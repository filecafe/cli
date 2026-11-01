import { openAsBlob } from 'node:fs';
import { ApiError, type ApiClient, type FetchLike } from './api.ts';

export interface SignedTarget {
  url: string;
  headers: Record<string, string>;
}

interface StartedUploadBase {
  id: string;
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
  /** ISO 8601; null when the file never expires. Missing from older servers. */
  expires_at?: string | null;
}

/** An error while transferring bytes to the upload server. */
export class TransferError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'TransferError';
    this.status = status;
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
  /** Called as bytes are sent, so progress moves during each part rather than after it. */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PART_RETRIES = 3;
const DEFAULT_PART_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Multipart uploads use the start response's URLs for the first batch of parts and fetch each
 * later batch just before uploading it, so a long upload never sends a part to an expired URL.
 */
const PART_URL_BATCH_SIZE = 50;

/** Fetch a batch's URLs again once they are this old. file.cafe signs them for two hours. */
const PART_URL_MAX_AGE_MS = 60 * 60 * 1000;

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
  label: string;
  /** Called with each chunk's size as it is sent, and with the negative total when an attempt fails. */
  onBytes?: (bytes: number) => void;
}

/** PUT one byte range, retrying network errors and 5xx responses. */
export async function putPart(target: SignedTarget, body: Blob, options: PutPartOptions): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();

    let sent = 0;
    // Streamed so progress can count bytes as they leave; a failed attempt takes its count back.
    const counted = body.stream().pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          sent += chunk.byteLength;
          options.onBytes?.(chunk.byteLength);
          controller.enqueue(chunk);
        },
      }),
    );
    const failed = () => options.onBytes?.(-sent);

    let response: Response;

    try {
      // Only the signed headers plus Content-Length, which a streamed body must state (R2 checks it
      // against the signature). fetch never sends Origin.
      response = await options.fetch(target.url, {
        method: 'PUT',
        headers: { ...target.headers, 'Content-Length': String(body.size) },
        body: counted,
        duplex: 'half',
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      });
    } catch (error) {
      failed();

      if (options.signal.aborted) {
        throw options.signal.reason;
      }

      if (attempt < options.maxRetries) {
        await options.sleep(1000 * 2 ** attempt);
        continue;
      }

      throw new TransferError(`Upload of ${options.label} failed: network error (${describeFetchError(error)}).`, null);
    }

    // Single uploads are signed with If-None-Match: *, so a retry gets 412 when an earlier attempt
    // stored the file but its response was lost. That means it is uploaded; completing the upload
    // checks the stored size.
    if (response.ok || (response.status === 412 && attempt > 0)) {
      await response.body?.cancel();

      return;
    }

    failed();

    const detail = (await response.text().catch(() => '')).trim().slice(0, 500);

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

/**
 * Upload one file: start the upload, PUT each part (in parallel for multipart), then complete
 * it. file.cafe checks the stored file when completing, so nothing else needs to be sent back.
 */
export async function uploadFile(options: UploadOptions): Promise<CompletedUpload> {
  const { client, size } = options;
  const blob = await openAsBlob(options.path);

  if (blob.size !== size) {
    throw new Error(`${options.path} changed size while uploading. Please retry.`);
  }

  const started = await client.request<StartedUpload>('POST', '/api/v1/uploads', {
    filename: options.filename,
    size,
    mime_type: options.mimeType,
    ...(options.collectionId ? { collection_id: options.collectionId } : {}),
  });

  const { targets, partSize } = planTransfer(started, size);
  const partUrls = createPartUrls(options, started, targets);
  const controller = new AbortController();
  let uploadedBytes = 0;

  options.onProgress?.(0, size);

  await runPool(targets.length, options.concurrency ?? DEFAULT_CONCURRENCY, controller, async (index) => {
    const start = index * partSize;
    const end = Math.min(start + partSize, size);

    await putPart(await partUrls.target(index), blob.slice(start, end), {
      fetch: options.fetch,
      sleep: options.sleep,
      maxRetries: options.maxPartRetries ?? DEFAULT_PART_RETRIES,
      timeoutMs: options.partTimeoutMs ?? DEFAULT_PART_TIMEOUT_MS,
      signal: controller.signal,
      label: targets.length > 1 ? `part ${index + 1}/${targets.length}` : options.filename,
      onBytes: (bytes) => {
        uploadedBytes += bytes;
        options.onProgress?.(uploadedBytes, size);
      },
    });
  });

  return client.request<CompletedUpload>(
    'PUT',
    `/api/v1/uploads/${encodeURIComponent(started.id)}`,
    { token: partUrls.token() },
    { idempotent: true },
  );
}

interface PartUrlBatch {
  fetchedAt: number;
  targets: Promise<SignedTarget[]>;
}

/**
 * The URL for each part of an upload, in batches of PART_URL_BATCH_SIZE. The first batch comes
 * from the start response; later ones, and any batch older than PART_URL_MAX_AGE_MS, are fetched
 * when a part in them is about to be uploaded. Each fetch also renews the upload ticket, so the
 * latest token is the one to complete with.
 */
function createPartUrls(options: UploadOptions, started: StartedUpload, targets: SignedTarget[]) {
  const now = options.now ?? Date.now;
  const batches = new Map<number, PartUrlBatch>([
    [0, { fetchedAt: now(), targets: Promise.resolve(targets.slice(0, PART_URL_BATCH_SIZE)) }],
  ]);
  let token = started.token;

  const fetchBatch = async (batch: number): Promise<SignedTarget[]> => {
    const first = batch * PART_URL_BATCH_SIZE + 1;
    const partNumbers = Array.from({ length: Math.min(PART_URL_BATCH_SIZE, targets.length - first + 1) }, (_, i) => first + i);
    const response = await options.client.request<unknown>(
      'POST',
      `/api/v1/uploads/${encodeURIComponent(started.id)}/parts`,
      { token, part_numbers: partNumbers },
      { idempotent: true },
    );
    const parts = isRecord(response) && Array.isArray(response.parts) ? response.parts : [];
    const fresh = partNumbers.map((partNumber) => parts.find((part) => isRecord(part) && part.part_number === partNumber));

    if (!isRecord(response) || typeof response.token !== 'string' || !fresh.every(isSignedTarget)) {
      throw new ApiError('Unexpected response when fetching upload URLs.', null);
    }

    token = response.token;

    return fresh.map((part) => ({ url: part.url, headers: part.headers }));
  };

  return {
    async target(index: number): Promise<SignedTarget> {
      // A single PUT has one URL, used straight away.
      if (!('parts' in started)) {
        return targets[index] as SignedTarget;
      }

      const batch = Math.floor(index / PART_URL_BATCH_SIZE);
      let entry = batches.get(batch);

      if (!entry || now() - entry.fetchedAt > PART_URL_MAX_AGE_MS) {
        entry = { fetchedAt: now(), targets: fetchBatch(batch) };
        batches.set(batch, entry);
      }

      return (await entry.targets)[index % PART_URL_BATCH_SIZE] as SignedTarget;
    },
    token: () => token,
  };
}
