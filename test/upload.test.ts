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
  receiptResponse,
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
      requires_receipts: true,
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
  it('starts, PUTs the bytes with exactly the signed headers, and completes with the receipt', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
        return singleStart();
      }

      if (call.method === 'PUT' && call.url === 'https://upload.file.cafe/upload-1') {
        return receiptResponse('receipt-1');
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
      'content-type': 'text/plain',
      'if-none-match': '*',
      'x-upload-token': 'signed-upload-token',
    });
    assert.ok(put?.body instanceof Blob);
    assert.equal(await bodyText(put?.body), 'hello world');

    assert.equal(complete?.headers.authorization, 'Bearer secret-token');
    assert.deepEqual(await bodyJson(complete?.body), {
      token: 'completion-token-upload-1',
      receipts: ['receipt-1'],
    });
  });

  it('fails when the upload succeeds without a receipt and does not complete', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        return singleStart();
      }

      return receiptResponse(null);
    }, 'hello world');

    await assert.rejects(uploadFile(options), (error: Error) => {
      assert.ok(error instanceof TransferError);
      assert.match(error.message, /did not return an upload receipt/);

      return true;
    });
    assert.equal(calls.filter((call) => call.url.includes('/api/v1/uploads/')).length, 0);
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

        return attempts < 3 ? text(502, 'The file could not be uploaded. Please try again.') : receiptResponse('receipt-1');
      }

      return completed('upload-1', 'hello.txt', 11);
    }, 'hello world');

    const result = await uploadFile(options);

    assert.equal(result.id, 'upload-1');
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(await bodyJson(calls.at(-1)?.body), { token: 'completion-token-upload-1', receipts: ['receipt-1'] });
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

        return receiptResponse('receipt-1');
      }

      return completed('upload-1', 'hello.txt', 11);
    }, 'hello world');

    await uploadFile(options);
    assert.equal(attempts, 2);
  });

  it('restarts the upload once when the object exists but its receipt was lost (412)', async () => {
    let starts = 0;
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        starts++;

        return singleStart(`upload-${starts}`);
      }

      if (call.url === 'https://upload.file.cafe/upload-1') {
        return text(412, 'The file already exists.');
      }

      if (call.url === 'https://upload.file.cafe/upload-2') {
        return receiptResponse('receipt-2');
      }

      return completed('upload-2', 'hello.txt', 11);
    }, 'hello world');

    const result = await uploadFile(options);

    assert.equal(starts, 2);
    assert.equal(result.id, 'upload-2');
    assert.deepEqual(await bodyJson(calls.at(-1)?.body), { token: 'completion-token-upload-2', receipts: ['receipt-2'] });
  });
});

describe('multipart upload', () => {
  it('uploads the right slices in parallel and sends receipts in part order', async () => {
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
            requires_receipts: true,
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

        return receiptResponse(`receipt-${index}`);
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
    assert.deepEqual(await bodyJson(calls.at(-1)?.body), {
      token: 'multi-completion-token',
      receipts: ['receipt-0', 'receipt-1', 'receipt-2', 'receipt-3'],
    });
    assert.equal(progress.at(-1), contents.length);
  });

  it('stops scheduling parts and does not complete when a part fails', async () => {
    const { calls, options } = await setup((call) => {
      if (call.method === 'POST') {
        return json(201, {
          data: {
            id: 'multi-2',
            requires_receipts: true,
            multipart_id: 'mp-2',
            part_size: 2,
            parts: [0, 1, 2, 3, 4].map((index) => ({ url: `https://upload.file.cafe/multi-2/${index}`, headers: {} })),
            token: 't',
          },
        });
      }

      return call.url.endsWith('/0') ? text(400, 'The upload does not match its authorized size or type.') : receiptResponse('r');
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
