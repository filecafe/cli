import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, apiErrorMessage, createApiClient, fetchMe, parseRetryAfter } from '../src/api.ts';
import { BASE, createSleep, json, mockFetch, type Handler } from './helpers.ts';

function client(handler: Handler) {
  const { fetch, calls } = mockFetch(handler);
  const { sleep, waits } = createSleep();
  const notices: string[] = [];
  const api = createApiClient({
    baseUrl: BASE,
    token: 'secret-token',
    fetch,
    sleep,
    userAgent: 'test',
    onNotice: (message) => notices.push(message),
  });

  return { api, calls, waits, notices };
}

describe('api client', () => {
  it('returns data from GET /api/v1/me with bearer auth and JSON accept headers', async () => {
    const { api, calls } = client(() => json(200, { data: { name: 'Ada', email: 'ada@example.com' } }));

    assert.deepEqual(await fetchMe(api), { name: 'Ada', email: 'ada@example.com' });
    assert.equal(calls[0]?.url, `${BASE}/api/v1/me`);
    assert.equal(calls[0]?.headers.authorization, 'Bearer secret-token');
    assert.equal(calls[0]?.headers.accept, 'application/json');
  });

  it('surfaces the first 422 validation message per field', async () => {
    const { api } = client(() =>
      json(422, {
        message: 'The size field must not be greater than 5368709120. (and 1 more error)',
        errors: {
          size: ['The file may not be larger than 5 GB.', 'ignored second message'],
          filename: ['The filename may not contain slashes.'],
        },
      }),
    );

    await assert.rejects(api.request('POST', '/api/v1/uploads', {}), (error: ApiError) => {
      assert.equal(error.status, 422);
      assert.equal(error.message, 'The file may not be larger than 5 GB. The filename may not contain slashes.');

      return true;
    });
  });

  it('tells the user how to log in on 401', async () => {
    const { api } = client(() => json(401, { message: 'Unauthenticated.' }));

    await assert.rejects(fetchMe(api), (error: ApiError) => {
      assert.equal(error.status, 401);
      assert.ok(error.isFatal);
      assert.match(error.message, /Run "filecafe login" or set FILECAFE_TOKEN\./);

      return true;
    });
  });

  it('shows the server message for 403 and 503', async () => {
    const forbidden = client(() => json(403, { message: 'Your email address is not verified.' }));
    await assert.rejects(fetchMe(forbidden.api), /^ApiError: Your email address is not verified\.$/);

    const unavailable = client(() => json(503, { message: 'Uploads are temporarily disabled.' }));
    await assert.rejects(unavailable.api.request('POST', '/api/v1/uploads', {}), /Uploads are temporarily disabled\./);
  });

  it('waits for Retry-After on 429 and retries', async () => {
    let attempts = 0;
    const { api, waits, notices } = client(() => {
      attempts++;

      return attempts === 1
        ? json(429, { message: 'Too Many Attempts.' }, { 'Retry-After': '7' })
        : json(201, { data: { ok: true } });
    });

    assert.deepEqual(await api.request('POST', '/api/v1/uploads', {}), { ok: true });
    assert.deepEqual(waits, [7000]);
    assert.match(notices[0] ?? '', /retrying in 7s/);
  });

  it('gives up after repeated 429s', async () => {
    let attempts = 0;
    const { api } = client(() => {
      attempts++;

      return json(429, { message: 'Too Many Attempts.' }, { 'Retry-After': '1' });
    });

    await assert.rejects(api.request('POST', '/api/v1/uploads', {}), /Too Many Attempts\./);
    assert.equal(attempts, 4);
  });

  it('retries idempotent requests after network errors but not POSTs', async () => {
    let attempts = 0;
    const flaky = client(() => {
      attempts++;

      if (attempts === 1) {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      }

      return json(200, { data: { id: 'u1' } });
    });

    assert.deepEqual(await flaky.api.request('PUT', '/api/v1/uploads/u1', {}, { idempotent: true }), { id: 'u1' });

    const down = client(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });

    await assert.rejects(down.api.request('POST', '/api/v1/uploads', {}), /Could not reach https:\/\/file\.cafe \(ECONNREFUSED\)/);
    assert.equal(down.calls.length, 1);
  });

  it('retries idempotent requests when the response body fails mid-read', async () => {
    let attempts = 0;
    const { api } = client(() => {
      attempts++;

      if (attempts === 1) {
        const body = new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('terminated', { cause: { code: 'ECONNRESET' } }));
          },
        });

        return new Response(body, { status: 200 });
      }

      return json(200, { data: { id: 'u1' } });
    });

    assert.deepEqual(await api.request('PUT', '/api/v1/uploads/u1', {}, { idempotent: true }), { id: 'u1' });
    assert.equal(attempts, 2);
  });

  it('reports non-JSON responses as a likely wrong --url', async () => {
    const { api } = client(() => new Response('<html></html>', { status: 200 }));

    await assert.rejects(fetchMe(api), /not file\.cafe API JSON/);
  });

  it('parses Retry-After seconds and dates', () => {
    assert.equal(parseRetryAfter('30'), 30_000);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.equal(apiErrorMessage(500, null), 'Request failed with HTTP 500.');
  });
});
