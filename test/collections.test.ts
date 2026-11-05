import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApiClient } from '../src/api.ts';
import { createCollection, CollectionIncompleteError, validateCollectionName } from '../src/collections.ts';
import { collectionsCommand, createCollectionCommand } from '../src/commands/collections.ts';
import { uploadCommand } from '../src/commands/upload.ts';
import { BASE, bodyJson, createSleep, createTestContext, json, mockFetch, stored, tempFile, type Handler } from './helpers.ts';

function collection(overrides: Record<string, unknown> = {}) {
  return {
    id: '0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b',
    name: 'Launch',
    url: `${BASE}/c/AbCdEfGhIjK`,
    files_count: 2,
    password_protected: false,
    accepts_uploads: false,
    created_at: '2026-11-04T12:00:00+00:00',
    expires_at: null,
    ...overrides,
  };
}

/** A fake server: uploads of files named "bad*" fail; creating a collection echoes how many files it got. */
const server: Handler = async (call) => {
  if (call.method === 'POST' && call.url === `${BASE}/api/v1/uploads`) {
    const body = (await bodyJson(call.body)) as { filename: string };

    if (body.filename.startsWith('bad')) {
      return json(422, { message: 'Invalid.', errors: { mime_type: ['This file type is not allowed.'] } });
    }

    return json(201, {
      data: { id: `id-${body.filename}`, url: `https://upload.file.cafe/${body.filename}`, headers: {}, token: 't' },
    });
  }

  if (call.method === 'PUT' && call.url.startsWith('https://upload.file.cafe/')) {
    return stored();
  }

  const completed = /\/api\/v1\/uploads\/id-(.+)$/.exec(call.url);

  if (call.method === 'PUT' && completed) {
    const filename = decodeURIComponent(completed[1] ?? '');

    return json(201, {
      data: { id: `id-${filename}`, filename, password_protected: false, size: 5, expires_at: null, url: `${BASE}/f/${filename}` },
    });
  }

  if (call.method === 'POST' && call.url === `${BASE}/api/v1/collections`) {
    const body = (await bodyJson(call.body)) as { name: string; file_ids: string[] };

    return json(201, { data: collection({ name: body.name, files_count: body.file_ids.length }) });
  }

  throw new Error(`Unexpected ${call.method} ${call.url}`);
};

describe('filecafe upload --new-collection', () => {
  it('uploads the files, creates a collection holding them in order, and prints only its URL when piped', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context, stdout, stderr } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });
    const first = await tempFile('one.txt', 'hello');
    const second = await tempFile('two.txt', 'world');

    assert.equal(await uploadCommand([first, second], { newCollection: '  Launch  ' }, {}, context), 0);
    assert.equal(stdout(), `${BASE}/c/AbCdEfGhIjK\n`);
    assert.equal(stderr(), '');

    const create = calls.find((call) => call.url === `${BASE}/api/v1/collections`);
    assert.deepEqual(await bodyJson(create?.body), { name: 'Launch', file_ids: ['id-one.txt', 'id-two.txt'] });
  });

  it('shows the file summaries and then the collection in a terminal', async () => {
    const { fetch } = mockFetch(server);
    let out = '';
    const { context } = await createTestContext(fetch, {
      env: { FILECAFE_TOKEN: 't', NO_COLOR: '1' },
      stdout: { isTTY: true, write: (chunk: string) => (out += chunk) },
    });

    assert.equal(await uploadCommand([await tempFile('one.txt', 'hello')], { newCollection: 'Launch' }, {}, context), 0);
    assert.ok(
      out.endsWith(
        '\nCreated collection Launch\n' +
          `URL:     ${BASE}/c/AbCdEfGhIjK\n` +
          'Files:   1 file\n' +
          'ID:      0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b\n',
      ),
      out,
    );
    assert.ok(out.startsWith('Successfully uploaded one.txt\n'));
  });

  it('creates the collection from the files that uploaded, and exits 1 because one failed', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context, stdout } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });
    const good = await tempFile('good.txt', 'hello');
    const bad = await tempFile('bad.exe', 'MZ');

    assert.equal(await uploadCommand([good, bad], { newCollection: 'Launch', json: true }, {}, context), 1);

    const output = JSON.parse(stdout()) as { collection: { files_count: number }; files: { ok: boolean }[] };
    assert.equal(output.collection.files_count, 1);
    assert.deepEqual(
      output.files.map((file) => file.ok),
      [true, false],
    );
    assert.ok(!('collection_error' in output));

    const create = calls.find((call) => call.url === `${BASE}/api/v1/collections`);
    assert.deepEqual(await bodyJson(create?.body), { name: 'Launch', file_ids: ['id-good.txt'] });
  });

  it('does not create a collection when no file uploaded', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context, stdout } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    assert.equal(await uploadCommand([await tempFile('bad.exe', 'MZ')], { newCollection: 'Launch', json: true }, {}, context), 1);

    assert.deepEqual(JSON.parse(stdout()).collection, null);
    assert.match(JSON.parse(stdout()).collection_error, /not created/);
    assert.ok(!calls.some((call) => call.url === `${BASE}/api/v1/collections`));
  });

  it('reports a failed collection creation and exits 1, keeping the uploaded files', async () => {
    const { fetch } = mockFetch((call) =>
      call.url === `${BASE}/api/v1/collections`
        ? json(422, { message: 'Invalid.', errors: { name: ['The name field must not be greater than 120 characters.'] } })
        : server(call),
    );
    const { context, stdout, stderr } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    assert.equal(await uploadCommand([await tempFile('one.txt', 'hello')], { newCollection: 'Launch' }, {}, context), 1);
    assert.equal(stdout(), '');
    assert.match(stderr(), /Collection: The name field must not be greater than 120 characters\./);
  });

  it('rejects a bad name or --collection alongside it before uploading anything', async () => {
    const { fetch, calls } = mockFetch(server);
    const { context } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });
    const file = await tempFile('one.txt', 'hello');

    await assert.rejects(uploadCommand([file], { newCollection: '   ' }, {}, context), /cannot be empty/);
    await assert.rejects(uploadCommand([file], { newCollection: 'x'.repeat(121) }, {}, context), /at most 120 characters/);
    await assert.rejects(
      uploadCommand([file], { newCollection: 'Launch', collection: collection().id }, {}, context),
      /either --collection or --new-collection/,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(validateCollectionName('🍰'.repeat(120)), { name: '🍰'.repeat(120) });
  });
});

describe('createCollection', () => {
  const clientFor = (handler: Handler) => {
    const { fetch, calls } = mockFetch(handler);
    const client = createApiClient({ baseUrl: BASE, token: 't', fetch, sleep: createSleep().sleep, userAgent: 'test' });

    return { client, calls };
  };
  const ids = Array.from({ length: 250 }, (_, i) => `file-${i + 1}`);
  const addUrl = `${BASE}/api/v1/collections/${collection().id}/files`;

  it('creates with the first 100 files and adds the rest 100 at a time', async () => {
    const { client, calls } = clientFor(async (call) => {
      if (call.url === addUrl) {
        return json(200, { data: collection({ files_count: 250, added: 100 }) });
      }

      return json(201, { data: collection({ files_count: 100 }) });
    });

    const created = await createCollection(client, 'Launch', ids);

    assert.equal(created.files_count, 250);
    const bodies = (await Promise.all(calls.map((call) => bodyJson(call.body)))) as { file_ids: string[] }[];
    assert.deepEqual(
      calls.map((call) => call.url),
      [`${BASE}/api/v1/collections`, addUrl, addUrl],
    );
    assert.deepEqual(
      bodies.map((body) => [body.file_ids[0], body.file_ids.length]),
      [
        ['file-1', 100],
        ['file-101', 100],
        ['file-201', 50],
      ],
    );
  });

  it('says which files were left out when adding a later batch fails', async () => {
    const { client } = clientFor((call) =>
      call.url === addUrl
        ? json(422, { message: 'Invalid.', errors: { file_ids: ['A collection can hold up to 10,000 files.'] } })
        : json(201, { data: collection({ files_count: 100 }) }),
    );

    await assert.rejects(createCollection(client, 'Launch', ids), (error: unknown) => {
      assert.ok(error instanceof CollectionIncompleteError);
      assert.equal(error.collection.files_count, 100);
      assert.match(error.message, /adding files 101-200 failed: A collection can hold up to 10,000 files\./);

      return true;
    });
  });
});

describe('filecafe collections', () => {
  const list: Handler = () =>
    json(200, {
      data: [
        collection({ files_count: 1, expires_at: '2026-11-07T12:00:00+00:00', password_protected: true }),
        collection({ id: 'second-id', name: 'Old\tstuff', url: `${BASE}/c/second`, files_count: 3 }),
      ],
      meta: { current_page: 1, last_page: 1, total: 2 },
    });

  it('shows each collection in a terminal', async () => {
    const { fetch } = mockFetch(list);
    let out = '';
    const { context } = await createTestContext(fetch, {
      env: { FILECAFE_TOKEN: 't', NO_COLOR: '1' },
      stdout: { isTTY: true, write: (chunk: string) => (out += chunk) },
    });

    assert.equal(await collectionsCommand({}, {}, context), 0);
    assert.equal(
      out,
      'Launch (1 file, expires November 7th 2026, password)\n' +
        `  URL: ${BASE}/c/AbCdEfGhIjK\n` +
        '  ID:  0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b\n' +
        '\n' +
        'Old stuff (3 files)\n' +
        `  URL: ${BASE}/c/second\n` +
        '  ID:  second-id\n',
    );
  });

  it('prints tab-separated lines when piped and JSON with --json', async () => {
    const { fetch } = mockFetch(list);
    const piped = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    assert.equal(await collectionsCommand({}, {}, piped.context), 0);
    assert.equal(
      piped.stdout(),
      `0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b\tLaunch\t${BASE}/c/AbCdEfGhIjK\nsecond-id\tOld stuff\t${BASE}/c/second\n`,
    );

    const asJson = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });
    assert.equal(await collectionsCommand({ json: true }, {}, asJson.context), 0);
    assert.deepEqual(
      (JSON.parse(asJson.stdout()) as { id: string }[]).map((entry) => entry.id),
      ['0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b', 'second-id'],
    );
  });

  it('fetches every page until a short one', async () => {
    const { fetch, calls } = mockFetch((call) => {
      const page = Number(new URL(call.url).searchParams.get('page'));
      const count = page === 1 ? 100 : 1;

      return json(200, { data: Array.from({ length: count }, (_, i) => collection({ id: `p${page}-${i}` })) });
    });
    const { context, stdout } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    assert.equal(await collectionsCommand({ json: true }, {}, context), 0);
    assert.equal((JSON.parse(stdout()) as unknown[]).length, 101);
    assert.deepEqual(
      calls.map((call) => call.url),
      [`${BASE}/api/v1/collections?page=1`, `${BASE}/api/v1/collections?page=2`],
    );
  });

  it('says how to make one when there are none', async () => {
    const { fetch } = mockFetch(() => json(200, { data: [] }));
    const { context, stdout, stderr } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't', NO_COLOR: '1' } });

    assert.equal(await collectionsCommand({}, {}, context), 0);
    assert.equal(stdout(), '');
    assert.match(stderr(), /No collections yet\. Create one with: filecafe collections create <name>/);
  });
});

describe('filecafe collections create', () => {
  const created: Handler = () => json(201, { data: collection({ name: 'Inbox', files_count: 0 }) });

  it('creates an empty collection, sending only its name', async () => {
    const { fetch, calls } = mockFetch(created);
    const { context, stdout } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    assert.equal(await createCollectionCommand('  Inbox ', {}, {}, context), 0);
    assert.equal(stdout(), `0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b\tInbox\t${BASE}/c/AbCdEfGhIjK\n`);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [`POST ${BASE}/api/v1/collections`],
    );
    assert.deepEqual(await bodyJson(calls[0]?.body), { name: 'Inbox' });
  });

  it('shows the URL and ID with an upload hint in a terminal, and the collection with --json', async () => {
    const { fetch } = mockFetch(created);
    let out = '';
    const terminal = await createTestContext(fetch, {
      env: { FILECAFE_TOKEN: 't', NO_COLOR: '1' },
      stdout: { isTTY: true, write: (chunk: string) => (out += chunk) },
    });

    assert.equal(await createCollectionCommand('Inbox', {}, {}, terminal.context), 0);
    assert.equal(
      out,
      'Created collection Inbox\n' +
        `URL:     ${BASE}/c/AbCdEfGhIjK\n` +
        'Files:   0 files\n' +
        'ID:      0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b\n',
    );
    assert.equal(
      terminal.stderr(),
      'Upload into it with: filecafe upload <files...> --collection 0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b\n',
    );

    const asJson = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });
    assert.equal(await createCollectionCommand('Inbox', { json: true }, {}, asJson.context), 0);
    assert.deepEqual(JSON.parse(asJson.stdout()), collection({ name: 'Inbox', files_count: 0 }));
  });

  it('rejects a bad name without calling the server', async () => {
    const { fetch, calls } = mockFetch(created);
    const { context } = await createTestContext(fetch, { env: { FILECAFE_TOKEN: 't' } });

    await assert.rejects(createCollectionCommand(' ', {}, {}, context), /cannot be empty/);
    assert.equal(calls.length, 0);
  });
});
