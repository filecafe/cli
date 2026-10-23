import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { uploadCommand, uploadFilename } from '../src/commands/upload.ts';
import { whoamiCommand } from '../src/commands/whoami.ts';
import { logoutCommand } from '../src/commands/logout.ts';
import { readConfig, writeConfig } from '../src/config.ts';
import { guessMimeType } from '../src/mime.ts';
import { NOT_LOGGED_IN } from '../src/session.ts';
import { BASE, bodyJson, createTestContext, json, mockFetch, receiptResponse, tempDir, tempFile, type Handler } from './helpers.ts';

/** A fake server where uploads of files named "bad*" fail validation. */
const server: Handler = async (call) => {
  if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
    const body = (await bodyJson(call.body)) as { filename: string; size: number };

    if (body.filename.startsWith('bad')) {
      return json(422, { message: 'Invalid.', errors: { mime_type: ['This file type is not allowed.'] } });
    }

    return json(201, {
      data: {
        id: `id-${body.filename}`,
        requires_receipts: true,
        url: `https://upload.file.cafe/${body.filename}`,
        headers: { 'Content-Type': 'text/plain' },
        thumbnail: null,
        tile: null,
        preview: null,
        token: `token-${body.filename}`,
      },
    });
  }

  if (call.method === 'PUT' && call.url.startsWith('https://upload.file.cafe/')) {
    return receiptResponse(`receipt-${call.url.split('/').pop()}`);
  }

  const match = /\/api\/v1\/uploads\/id-(.+)$/.exec(call.url);

  if (call.method === 'PUT' && match) {
    const filename = decodeURIComponent(match[1] ?? '');

    return json(201, {
      data: { id: `id-${filename}`, filename, password_protected: false, size: 5, url: `${BASE}/f/${filename}` },
    });
  }

  throw new Error(`Unexpected ${call.method} ${call.url}`);
};

describe('filecafe upload', () => {
  it('prints a JSON array with one result per file and exits 1 when any file fails', async () => {
    const { fetch } = mockFetch(server);
    const { context, stdout, stderr } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 'env-token' } });
    const good = await tempFile('good.txt', 'hello');
    const bad = await tempFile('bad.exe', 'MZ...');

    const exitCode = await uploadCommand([good, bad], { json: true }, {}, context);

    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(stdout()), [
      {
        file: good,
        ok: true,
        id: 'id-good.txt',
        filename: 'good.txt',
        size: 5,
        url: `${BASE}/f/good.txt`,
        password_protected: false,
      },
      { file: bad, ok: false, error: 'This file type is not allowed.' },
    ]);
    assert.equal(stderr(), '');
  });

  it('prints one share URL per line and exits 0 when everything succeeds', async () => {
    const { fetch } = mockFetch(server);
    const { context, stdout } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 'env-token' } });
    const first = await tempFile('one.txt', 'hello');
    const second = await tempFile('two.txt', 'world');

    assert.equal(await uploadCommand([first, second], {}, {}, context), 0);
    assert.equal(stdout(), `${BASE}/f/one.txt\n${BASE}/f/two.txt\n`);
  });

  it('validates every input before uploading anything', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context, stdout } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 'env-token' } });
    const good = await tempFile('good.txt', 'hello');
    const missing = join(await tempDir(), 'missing.txt');
    const directory = await tempDir();

    assert.equal(await uploadCommand([good, missing, directory], { json: true }, {}, context), 1);
    assert.equal(calls.length, 0);

    const results = JSON.parse(stdout()) as { file: string; ok: boolean; error: string }[];
    assert.deepEqual(
      results.map((result) => [result.file, result.ok]),
      [
        [good, false],
        [missing, false],
        [directory, false],
      ],
    );
    assert.match(results[0]?.error ?? '', /Skipped/);
    assert.equal(results[1]?.error, 'No such file.');
    assert.match(results[2]?.error ?? '', /directory/);
  });

  it('stops after an authentication failure instead of retrying every file', async () => {
    const { fetch, calls } = mockFetch(() => json(401, { message: 'Unauthenticated.' }));
    const { context, stderr } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 'revoked' } });
    const first = await tempFile('one.txt', 'hello');
    const second = await tempFile('two.txt', 'world');

    assert.equal(await uploadCommand([first, second], {}, {}, context), 1);
    assert.equal(calls.length, 1);
    assert.match(stderr(), /two\.txt: Authentication failed.*filecafe login/);
  });

  it('fails with a login hint when there is no token', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context } = await createTestContext(fetch);
    const file = await tempFile('one.txt', 'hello');

    await assert.rejects(uploadCommand([file], {}, {}, context), { message: NOT_LOGGED_IN });
    assert.equal(calls.length, 0);
  });

  it('rejects an invalid --collection before doing anything', async () => {
    const { fetch } = mockFetch(server);
    const { context } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    await assert.rejects(uploadCommand(['x'], { collection: 'nope' }, {}, context), /Expected a collection UUID/);
  });

  it('sanitizes file names and guesses MIME types', () => {
    assert.equal(uploadFilename('/tmp/dir/report.pdf'), 'report.pdf');
    assert.equal(uploadFilename('/tmp/we\u0007ird\\name.txt'), 'we_ird_name.txt');
    assert.equal(uploadFilename(`/tmp/${'a'.repeat(300)}.png`).length, 255);
    assert.ok(uploadFilename(`/tmp/${'a'.repeat(300)}.png`).endsWith('.png'));
    assert.equal(guessMimeType('photo.JPG'), 'image/jpeg');
    assert.equal(guessMimeType('notes.md'), 'text/markdown');
    assert.equal(guessMimeType('mystery.blob'), 'application/octet-stream');
    assert.equal(guessMimeType('Makefile'), 'application/octet-stream');
  });
});

describe('filecafe whoami / logout', () => {
  it('prints the account as JSON', async () => {
    const { fetch } = mockFetch(() => json(200, { data: { name: 'Ada', email: 'ada@example.com' } }));
    const { context, stdout } = await createTestContext(fetch);
    await writeConfig(context, { url: BASE, token: 'saved' });

    assert.equal(await whoamiCommand({ json: true }, {}, context), 0);
    assert.deepEqual(JSON.parse(stdout()), {
      name: 'Ada',
      email: 'ada@example.com',
      url: BASE,
      token_source: 'config',
    });
  });

  it('logout revokes the saved token on the server and deletes it', async () => {
    const { fetch, calls } = mockFetch(() => new Response(null, { status: 204 }));
    const { context, stdout, stderr } = await createTestContext(fetch);
    await writeConfig(context, { url: BASE, token: 'saved' });

    assert.equal(await logoutCommand(context), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'DELETE');
    assert.equal(calls[0]?.url, `${BASE}/api/v1/token`);
    assert.equal(calls[0]?.headers.authorization, 'Bearer saved');
    assert.equal(await readConfig(context), null);
    assert.equal(stdout(), `Logged out of ${BASE}.\n`);
    assert.doesNotMatch(stderr(), /Could not revoke/);
  });

  it('logout stays quiet when the token was already revoked', async () => {
    const { fetch } = mockFetch(() => json(401, { message: 'Unauthenticated.' }));
    const { context, stderr } = await createTestContext(fetch);
    await writeConfig(context, { url: BASE, token: 'saved' });

    assert.equal(await logoutCommand(context), 0);
    assert.equal(await readConfig(context), null);
    assert.doesNotMatch(stderr(), /Could not revoke/);
  });

  it('logout still deletes the saved token when the server cannot be reached', async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { context, stdout, stderr } = await createTestContext(fetch);
    await writeConfig(context, { url: BASE, token: 'saved' });

    assert.equal(await logoutCommand(context), 0);
    assert.equal(await readConfig(context), null);
    assert.equal(stdout(), `Logged out of ${BASE}.\n`);
    assert.match(stderr(), /Could not revoke the token on https:\/\/file\.cafe/);
    assert.match(stderr(), /Settings → API tokens/);
  });

  it('logout makes no request when nothing is saved', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context, stdout } = await createTestContext(fetch);

    assert.equal(await logoutCommand(context), 0);
    assert.equal(calls.length, 0);
    assert.equal(stdout(), 'Not logged in; nothing to do.\n');
  });
});
