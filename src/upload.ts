import { openAsBlob } from 'node:fs';
import { ApiError, type ApiClient, type FetchLike } from './api.ts';

export interface SignedTarget {
  url: string;
  headers: Record<string, string>;
}

interface StartedUploadBase {
  id: string;
  requires_receipts?: boolean;
  token: string;
}

export type StartedUpload = StartedUploadBase &
  (SignedTarget | { multipart_id: string; part_size: number; parts: SignedTarget[] });

export interface CompletedUpload {
  id: string;
  filename: string;
  password_protected: boolean;
  size: number;
  url: string | null;
}

/** An error while transferring bytes to the upload server. */
export class TransferError extends Error {
  readonly status: number | null;
  /** The upload must be started again from scratch (e.g. the receipt for a written object was lost). */
  readonly restartUpload: boolean;

  constructor(message: string, status: number | null, restartUpload = false) {
    super(message);
    this.name = 'TransferError';
    this.status = status;
    this.restartUpload = restartUpload;
  }
}

export interface UploadOptions {
  client: ApiClient;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  collectionId?: string;
  /** Parallel part uploads for multipart files. */
  concurrency?: number;
  /** Retries per part for network errors and 5xx responses. */
  maxPartRetries?: number;
  partTimeoutMs?: number;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  /** Called when an upload is restarted after a lost receipt. */
  onNotice?: (message: string) => void;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PART_RETRIES = 3;
const DEFAULT_PART_TIMEOUT_MS = 15 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignedTarget(value: unknown): value is SignedTarget {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    isRecord(value.headers) &&
    Object.values(value.headers).every((header) => typeof header === 'string')
  );
}

interface TransferPlan {
  targets: SignedTarget[];
  partSize: number;
}

/** Validate the start response and turn it into a list of byte ranges to PUT. */
export function planTransfer(upload: StartedUpload, size: number): TransferPlan {
  const unexpected = (detail: string) => new ApiError(`Unexpected response when starting the upload: ${detail}.`, null);
  const data: unknown = upload;

  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.token !== 'string') {
    throw unexpected('missing id or token');
  }

  if ('parts' in data) {
    const { parts, part_size: partSize } = data;

    if (typeof partSize !== 'number' || !Number.isSafeInteger(partSize) || partSize <= 0) {
      throw unexpected('invalid part_size');
    }

    if (!Array.isArray(parts) || !parts.every(isSignedTarget)) {
      throw unexpected('invalid parts');
    }

    const expectedParts = Math.max(1, Math.ceil(size / partSize));

    if (parts.length !== expectedParts) {
      throw unexpected(`expected ${expectedParts} parts but got ${parts.length}`);
    }

    return { targets: parts, partSize };
  }

  if (!isSignedTarget(data)) {
    throw unexpected('missing upload url');
  }

  return { targets: [{ url: data.url, headers: data.headers }], partSize: Math.max(size, 1) };
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return 'timed out';
    }

    const cause = (error as Error & { cause?: { code?: unknown; message?: unknown } }).cause;

    if (cause && typeof cause.code === 'string') {
      return cause.code;
    }

    if (cause && typeof cause.message === 'string') {
      return cause.message;
    }

    return error.message;
  }

  return String(error);
}

interface PutPartOptions {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  maxRetries: number;
  timeoutMs: number;
  signal: AbortSignal;
  requireReceipt: boolean;
  label: string;
}

/** PUT one byte range, retrying network errors and 5xx responses. Returns the upload receipt. */
export async function putPart(target: SignedTarget, body: Blob, options: PutPartOptions): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();

    let response: Response;

    try {
      // Only the signed headers are sent; fetch derives Content-Length from the Blob and never sends Origin.
      response = await options.fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body,
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw options.signal.reason;
      }

      if (attempt < options.maxRetries) {
        await options.sleep(1000 * 2 ** attempt);
        continue;
      }

      throw new TransferError(`Upload of ${options.label} failed: network error (${describeFetchError(error)}).`, null);
    }

    if (response.ok) {
      await response.body?.cancel();
      const receipt = response.headers.get('X-Upload-Receipt');

      if (!receipt && options.requireReceipt) {
        throw new TransferError(
          `Upload of ${options.label} succeeded but the server did not return an upload receipt.`,
          response.status,
        );
      }

      return receipt;
    }

    const detail = (await response.text().catch(() => '')).trim().slice(0, 500);

    if (response.status === 412) {
      throw new TransferError(
        `Upload of ${options.label} failed: the file already exists and its receipt was lost.`,
        412,
        true,
      );
    }

    if (response.status >= 500 && attempt < options.maxRetries) {
      await options.sleep(1000 * 2 ** attempt);
      continue;
    }

    throw new TransferError(
      `Upload of ${options.label} failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
      response.status,
    );
  }
}

/** Run `worker` for indexes 0..count-1 with bounded concurrency, stopping on the first error. */
async function runPool(
  count: number,
  concurrency: number,
  controller: AbortController,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown = null;

  const runner = async () => {
    while (next < count && !controller.signal.aborted) {
      const index = next++;

      try {
        await worker(index);
      } catch (error) {
        if (firstError === null) {
          firstError = error;
          controller.abort(error);
        }

        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, runner));

  if (firstError !== null) {
    throw firstError;
  }
}

async function transferOnce(options: UploadOptions, blob: Blob): Promise<CompletedUpload> {
  const { client, size } = options;
  const started = await client.request<StartedUpload>('POST', '/api/v1/uploads', {
    filename: options.filename,
    size,
    mime_type: options.mimeType,
    ...(options.collectionId ? { collection_id: options.collectionId } : {}),
  });

  const { targets, partSize } = planTransfer(started, size);
  const requireReceipt = started.requires_receipts !== false;
  const receipts: (string | null)[] = new Array(targets.length).fill(null);
  const controller = new AbortController();
  let uploadedBytes = 0;

  options.onProgress?.(0, size);

  await runPool(targets.length, options.concurrency ?? DEFAULT_CONCURRENCY, controller, async (index) => {
    const start = index * partSize;
    const end = Math.min(start + partSize, size);
    const target = targets[index] as SignedTarget;

    receipts[index] = await putPart(target, blob.slice(start, end), {
      fetch: options.fetch,
      sleep: options.sleep,
      maxRetries: options.maxPartRetries ?? DEFAULT_PART_RETRIES,
      timeoutMs: options.partTimeoutMs ?? DEFAULT_PART_TIMEOUT_MS,
      signal: controller.signal,
      requireReceipt,
      label: targets.length > 1 ? `part ${index + 1}/${targets.length}` : options.filename,
    });

    uploadedBytes += end - start;
    options.onProgress?.(uploadedBytes, size);
  });

  return client.request<CompletedUpload>(
    'PUT',
    `/api/v1/uploads/${encodeURIComponent(started.id)}`,
    {
      token: started.token,
      receipts: receipts.filter((receipt): receipt is string => receipt !== null),
    },
    { idempotent: true },
  );
}

/**
 * Upload one file: start the upload, PUT each part (in parallel for multipart),
 * then complete it with the receipts in part order.
 */
export async function uploadFile(options: UploadOptions): Promise<CompletedUpload> {
  const blob = await openAsBlob(options.path);

  if (blob.size !== options.size) {
    throw new Error(`${options.path} changed size while uploading. Please retry.`);
  }

  try {
    return await transferOnce(options, blob);
  } catch (error) {
    if (error instanceof TransferError && error.restartUpload) {
      options.onNotice?.(`Restarting the upload of ${options.filename}...`);

      return transferOnce(options, blob);
    }

    throw error;
  }
}
