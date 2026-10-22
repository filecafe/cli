export const LOGIN_HINT = 'Run "filecafe login" or set FILECAFE_TOKEN.';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  /** HTTP status, or null for network-level failures. */
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  /** Errors that will fail every subsequent request too (bad token, unverified account). */
  get isFatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
  /** Called with human-readable notices such as rate-limit waits. */
  onNotice?: (message: string) => void;
  maxRateLimitRetries?: number;
  maxNetworkRetries?: number;
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Safe to repeat after a network error or gateway failure. */
  idempotent?: boolean;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
}

const MAX_RETRY_AFTER_SECONDS = 120;

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS) * 1000;
  }

  const date = Date.parse(trimmed);

  if (Number.isNaN(date)) {
    return null;
  }

  return Math.min(Math.max(date - now, 0), MAX_RETRY_AFTER_SECONDS * 1000);
}

function messageFrom(body: unknown): string | null {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' && body.message) {
    return body.message;
  }

  return null;
}

/** Build the user-facing message for a failed API response. */
export function apiErrorMessage(status: number, body: unknown): string {
  const message = messageFrom(body);

  switch (status) {
    case 401:
      return `Authentication failed: your token is missing, invalid, or revoked. ${LOGIN_HINT}`;
    case 403:
      return message ?? 'This action is not allowed for your account.';
    case 404:
      return message && message !== 'Not Found.' ? message : 'Not found. Check the --url option and the IDs you passed.';
    case 422: {
      const errors =
        body && typeof body === 'object' && 'errors' in body && body.errors && typeof body.errors === 'object'
          ? (body.errors as Record<string, unknown>)
          : {};
      const firstMessages = Object.values(errors)
        .map((value) => (Array.isArray(value) ? value[0] : value))
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

      if (firstMessages.length > 0) {
        return firstMessages.join(' ');
      }

      return message ?? 'The request was invalid.';
    }
    case 429:
      return message ?? 'Too many requests. Please wait a minute and try again.';
    case 503:
      return message ?? 'file.cafe is temporarily unavailable. Please try again later.';
    default:
      return message ? `${message} (HTTP ${status})` : `Request failed with HTTP ${status}.`;
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'the request timed out';
    }

    const cause = (error as Error & { cause?: unknown }).cause;

    if (cause && typeof cause === 'object') {
      const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
      const causeMessage = 'message' in cause && typeof cause.message === 'string' ? cause.message : null;

      return code ?? causeMessage ?? error.message;
    }

    return error.message;
  }

  return String(error);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const {
    baseUrl,
    token,
    fetch,
    sleep,
    userAgent,
    onNotice,
    maxRateLimitRetries = 3,
    maxNetworkRetries = 3,
    timeoutMs = 60_000,
  } = options;

  async function request<T>(method: string, path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<T> {
    const url = `${baseUrl}${path}`;
    let rateLimitRetries = 0;
    let networkRetries = 0;

    for (;;) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (requestOptions.idempotent && networkRetries < maxNetworkRetries) {
          networkRetries++;
          await sleep(1000 * 2 ** (networkRetries - 1));
          continue;
        }

        throw new ApiError(`Could not reach ${baseUrl} (${describeNetworkError(error)}).`, null);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location');
        await response.body?.cancel();

        throw new ApiError(
          `${url} redirected to ${location ?? 'another location'}. Check the --url option / FILECAFE_URL (e.g. use https:// instead of http://).`,
          response.status,
        );
      }

      const text = await response.text();
      let json: unknown = null;

      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      if (response.status === 429 && rateLimitRetries < maxRateLimitRetries) {
        rateLimitRetries++;
        const waitMs = parseRetryAfter(response.headers.get('Retry-After')) ?? 5000 * rateLimitRetries;
        onNotice?.(`Rate limited by ${baseUrl}; retrying in ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }

      if (
        requestOptions.idempotent &&
        (response.status === 502 || response.status === 504) &&
        networkRetries < maxNetworkRetries
      ) {
        networkRetries++;
        await sleep(1000 * 2 ** (networkRetries - 1));
        continue;
      }

      if (!response.ok) {
        throw new ApiError(apiErrorMessage(response.status, json), response.status);
      }

      if (json && typeof json === 'object' && 'data' in json) {
        return json.data as T;
      }

      throw new ApiError(
        `Unexpected response from ${url} (HTTP ${response.status}, not file.cafe API JSON). Check the --url option / FILECAFE_URL.`,
        response.status,
      );
    }
  }

  return { baseUrl, request };
}

export interface Me {
  name: string;
  email: string;
}

export async function fetchMe(client: ApiClient): Promise<Me> {
  const me = await client.request<Partial<Me>>('GET', '/api/v1/me', undefined, { idempotent: true });

  if (!me || typeof me.email !== 'string') {
    throw new ApiError('Unexpected response from /api/v1/me.', null);
  }

  return { name: typeof me.name === 'string' ? me.name : '', email: me.email };
}
