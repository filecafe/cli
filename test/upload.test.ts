import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApiClient } from '../src/api.ts';
import { TransferError, uploadFile, type UploadOptions } from '../src/upload.ts';
import {
  BASE,
  bodyJson,
  bodyText,
  createSleep,
  json,
  mockFetch,
  stored,
  tempFile,
  text,
  type Handler,
} from './helpers.ts';

const SINGLE_HEADERS = {
  'Content-Type': 'text/plain',
  'If-None-Match': '*',
  'X-Upload-Token': 'signed-upload-token',
};

function singleStart(id = 'upload-1') {
  return json(201, {
    data: {
      id,
      url: `https://upload.file.cafe/${id}`,
      headers: SINGLE_HEADERS,
      thumbnail: null,
      tile: null,
      preview: null,
      token: `completion-token-${id}`,
    },
  });
}

function completed(id: string, filename: string, size: number) {
  return json(201, {
    data: { id, filename, password_protected: false, size, url: `https://file.cafe/f/${id}` },
  });
}

async function setup(handler: Handler, contents: string, name = 'hello.txt') {
  const { fetch, calls } = mockFetch(handler);
  const { sleep, waits } = createSleep();
  const client = createApiClient({ baseUrl: BASE, token: 'secret-token', fetch, sleep, userAgent: 'test' });
  const path = await tempFile(name, contents);
  const options: UploadOptions = {
    client,
    fetch,
    sleep,
    path,
    filename: name,
    size: Buffer.byteLength(contents),
    mimeType: 'text/plain',
  };

  return { calls, waits, options };
}

describe('single PUT upload', () => {
  it('starts, PUTs the bytes with exactly the signed headers, and completes the upload', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
        return singleStart();
      }

      if (call.method === 'PUT' && call.url === 'https://upload.file.cafe/upload-1') {
        return stored();
      }

      if (call.method === 'PUT' && call.url === `${BASE}/api/v1/uploads/upload-1`) {
        return completed('upload-1', 'hello.txt', 11);
      }

      throw new Error(`Unexpected ${call.method} ${call.url}`);
    }, 'hello world');

    const result = await uploadFile({ ...options, collectionId: '0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b' });

    assert.deepEqual(result, {
      id: 'upload-1',
      filename: 'hello.txt',
      password_protected: false,
      size: 11,
      url: 'https://file.cafe/f/upload-1',
    });
    assert.equal(calls.length, 3);

    const [start, put, complete] = calls;
    assert.equal(start?.headers.authorization, 'Bearer secret-token');
    assert.equal(start?.headers.accept, 'application/json');
    assert.deepEqual(await bodyJson(start?.body), {
      filename: 'hello.txt',
      size: 11,
      mime_type: 'text/plain',
      collection_id: '0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b',
    });

    assert.deepEqual(put?.headers, {
      'content-length': '11',
      'content-type': 'text/plain',
      'if-none-match': '*',
      'x-upload-token': 'signed-upload-token',
    });
    assert.equal(await bodyText(put?.body), 'hello world');

    assert.equal(complete?.headers.authorization, 'Bearer secret-token');
    assert.deepEqual(await bodyJson(complete?.body), { token: 'completion-token-upload-1' });
  });

  it('does not retry 4xx part responses and surfaces the text message', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      return text(403, 'This upload has expired or is invalid.');
    }, 'hello world');

    await assert.rejects(uploadFile(options), /HTTP 403\): This upload has expired or is invalid\./);
    assert.equal(calls.filter((call) => call.url.startsWith('https://upload.file.cafe')).length, 1);
  });

  it('retries 5xx part responses with backoff', async () => {
    let attempts = 0;
    const { calls, waits, options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      if (call.url.startsWith('https://upload.file.cafe')) {
        attempts++;

        return attempts < 3 ? text(502, 'The file could not be uploaded. Please try again.') : stored();
      }

      return completed('upload-1', 'hello.txt', 11);
    }, 'hello world');

    const result = await uploadFile(options);

    assert.equal(result.id, 'upload-1');
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(await bodyJson(calls.at(-1)?.body), { token: 'completion-token-upload-1' });
  });

  it('reports progress as bytes are sent and takes back the bytes of a failed attempt', async () => {
    let attempts = 0;
    const { options } = await setup(async (call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      if (call.url.startsWith('https://upload.file.cafe')) {
        attempts++;
        await bodyText(call.body);

        return attempts === 1 ? text(502, 'Try again.') : stored();
      }

      return completed('upload-1', 'hello.txt', 11);
    }, 'hello world');

    const progress: number[] = [];
    await uploadFile({ ...options, onProgress: (uploaded) => progress.push(uploaded) });

    assert.deepEqual(progress, [0, 11, 0, 11]);
  });

  it('gives up after 3 retries on persistent 5xx', async () => {
    let attempts = 0;
    const { options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      attempts++;

      return text(502, 'The file could not be uploaded. Please try again.');
    }, 'hello world');

    await assert.rejects(uploadFile(options), /HTTP 502/);
    assert.equal(attempts, 4);
  });

  it('retries network errors', async () => {
    let attempts = 0;
    const { options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      if (call.url.startsWith('https://upload.file.cafe')) {
        attempts++;

        if (attempts === 1) {
          throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        }

        return stored();
      }

      return completed('upload-1', 'hello.txt', 11);
    }, 'hello world');

    await uploadFile(options);
    assert.equal(attempts, 2);
  });

  it('treats a 412 on a retry as already stored, because the lost attempt wrote the file', async () => {
    let attempts = 0;
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      if (call.url.startsWith('https://upload.file.cafe')) {
        attempts++;

        if (attempts === 1) {
          throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        }

        return text(412, 'The file already exists.');
      }

      return completed('upload-1', 'hello.txt', 11);
    }, 'hello world');

    const result = await uploadFile(options);

    assert.equal(result.id, 'upload-1');
    assert.equal(attempts, 2);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });

  it('fails on a 412 for the first attempt and does not complete', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      return text(412, 'The file already exists.');
    }, 'hello world');

    await assert.rejects(uploadFile(options), (error: Error) => {
      assert.ok(error instanceof TransferError);
      assert.match(error.message, /HTTP 412\): The file already exists\./);

      return true;
    });
    assert.equal(calls.filter((call) => call.url.includes('/api/v1/uploads/')).length, 0);
  });
});

/** A multipart start for `parts` one-byte parts, whose URLs are .../start/<part number>. */
function multipartStart(parts: number, token: string) {
  return json(201, {
    data: {
      id: 'multi-3',
      multipart_id: 'mp-3',
      part_size: 1,
      parts: Array.from({ length: parts }, (_, i) => ({
        url: `https://upload.file.cafe/multi-3/start/${i + 1}`,
        headers: { 'Content-Type': 'text/plain' },
      })),
      token,
    },
  });
}

/** What POST /uploads/{id}/parts returns: fresh URLs (.../fresh/<n>) and a renewed ticket. */
function partsResponse(partNumbers: number[], token: string) {
  return json(200, {
    data: {
      parts: partNumbers.map((partNumber) => ({
        part_number: partNumber,
        url: `https://upload.file.cafe/multi-3/fresh/${partNumber}`,
        headers: { 'Content-Type': 'text/plain' },
      })),
      token,
      expires_at: 0,
    },
  });
}

describe('multipart upload', () => {
  it('uploads the right slices in parallel and completes once every part is stored', async () => {
    const contents = 'abcdefghij';
    const partSize = 3;
    let inFlight = 0;
    let maxInFlight = 0;
    const slices = new Map<number, string>();

    const { calls, options } = await setup(async (call) => {
      if (call.method === 'POST') {
        return json(201, {
          data: {
            id: 'multi-1',
            multipart_id: 'mp-1',
            part_size: partSize,
            parts: [0, 1, 2, 3].map((index) => ({
              url: `https://upload.file.cafe/multi-1/${index}`,
              headers: { 'Content-Type': 'text/plain', 'X-Upload-Token': `part-token-${index}` },
            })),
            thumbnail: null,
            tile: null,
            preview: null,
            token: 'multi-completion-token',
          },
        });
      }

      const partMatch = /\/multi-1\/(\d)$/.exec(call.url);

      if (partMatch) {
        const index = Number(partMatch[1]);
        assert.equal(call.headers['x-upload-token'], `part-token-${index}`);
        assert.equal(call.headers.authorization, undefined);

        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        slices.set(index, await bodyText(call.body));
        // Later parts finish first, so completion order differs from part order.
        await new Promise((resolve) => setTimeout(resolve, (4 - index) * 10));
        inFlight--;

        return stored();
      }

      return completed('multi-1', 'hello.txt', contents.length);
    }, contents);

    const progress: number[] = [];
    await uploadFile({ ...options, concurrency: 2, onProgress: (uploaded) => progress.push(uploaded) });

    assert.deepEqual(
      [0, 1, 2, 3].map((index) => slices.get(index)),
      ['abc', 'def', 'ghi', 'j'],
    );
    assert.equal(maxInFlight, 2);
    assert.deepEqual(await bodyJson(calls.at(-1)?.body), { token: 'multi-completion-token' });
    assert.equal(progress.at(-1), contents.length);
  });

  it('fetches URLs for later parts in batches of 50 and completes with the latest ticket', async () => {
    const contents = 'x'.repeat(120);
    const putUrls: string[] = [];
    const batches: unknown[] = [];

    const { calls, options } = await setup(async (call) => {
      if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
        return multipartStart(120, 'start-token');
      }

      if (call.url === `${BASE}/api/v1/uploads/multi-3/parts`) {
        const body = (await bodyJson(call.body)) as { token: string; part_numbers: number[] };
        batches.push(body);

        return partsResponse(body.part_numbers, `parts-token-${batches.length}`);
      }

      if (call.url.startsWith('https://upload.file.cafe')) {
        putUrls.push(call.url);

        return stored();
      }

      return completed('multi-3', 'hello.txt', contents.length);
    }, contents);

    await uploadFile(options);

    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    assert.deepEqual(batches, [
      { token: 'start-token', part_numbers: range(51, 100) },
      { token: 'parts-token-1', part_numbers: range(101, 120) },
    ]);
    assert.deepEqual(
      putUrls.filter((url) => url.includes('/start/')).map((url) => Number(url.split('/').pop())).sort((a, b) => a - b),
      range(1, 50),
    );
    assert.equal(putUrls.filter((url) => url.includes('/fresh/')).length, 70);
    assert.deepEqual(await bodyJson(calls.at(-1)?.body), { token: 'parts-token-2' });
  });

  it('fetches a batch again once its URLs are an hour old', async () => {
    let clock = 0;
    const putUrls: string[] = [];
    const batches: number[][] = [];

    const { options } = await setup(async (call) => {
      if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
        return multipartStart(3, 'start-token');
      }

      if (call.url.endsWith('/parts')) {
        const body = (await bodyJson(call.body)) as { part_numbers: number[] };
        batches.push(body.part_numbers);

        return partsResponse(body.part_numbers, 'renewed-token');
      }

      if (call.url.startsWith('https://upload.file.cafe')) {
        putUrls.push(call.url);
        clock += 61 * 60 * 1000;

        return stored();
      }

      return completed('multi-3', 'hello.txt', 3);
    }, 'abc');

    await uploadFile({ ...options, concurrency: 1, now: () => clock });

    assert.deepEqual(batches, [
      [1, 2, 3],
      [1, 2, 3],
    ]);
    assert.deepEqual(putUrls, [
      'https://upload.file.cafe/multi-3/start/1',
      'https://upload.file.cafe/multi-3/fresh/2',
      'https://upload.file.cafe/multi-3/fresh/3',
    ]);
  });

  it('stops when file.cafe does not return URLs for every requested part', async () => {
    const { calls, options } = await setup(async (call) => {
      if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
        return multipartStart(60, 'start-token');
      }

      if (call.url.endsWith('/parts')) {
        return json(200, { data: { parts: [], token: 'renewed-token', expires_at: 0 } });
      }

      return stored();
    }, 'x'.repeat(60));

    await assert.rejects(uploadFile(options), /Unexpected response when fetching upload URLs/);
    assert.equal(calls.filter((call) => call.method === 'PUT' && call.url.startsWith(BASE)).length, 0);
  });

  it('stops scheduling parts and does not complete when a part fails', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        return json(201, {
          data: {
            id: 'multi-2',
            multipart_id: 'mp-2',
            part_size: 2,
            parts: [0, 1, 2, 3, 4].map((index) => ({ url: `https://upload.file.cafe/multi-2/${index}`, headers: {} })),
            token: 't',
          },
        });
      }

      return call.url.endsWith('/0') ? text(400, 'The upload does not match its authorized size or type.') : stored();
    }, 'abcdefghij');

    await assert.rejects(uploadFile({ ...options, concurrency: 1 }), /authorized size or type/);
    assert.equal(calls.filter((call) => call.url.startsWith('https://upload.file.cafe')).length, 1);
    assert.equal(calls.filter((call) => call.url.includes('/api/v1/uploads/')).length, 0);
  });

  it('rejects a start response whose part count does not cover the file', async () => {
    const { options } = await setup(
      () =>
        json(201, {
          data: { id: 'x', multipart_id: 'mp', part_size: 3, parts: [{ url: 'https://u', headers: {} }], token: 't' },
        }),
      'abcdefghij',
    );

    await assert.rejects(uploadFile(options), /expected 4 parts but got 1/);
  });
});
