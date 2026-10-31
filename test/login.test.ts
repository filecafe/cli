import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { describe, it } from 'node:test';
import { loginCommand } from '../src/commands/login.ts';
import { configPath, readConfig } from '../src/config.ts';
import { BASE, bodyJson, createTestContext, json, mockFetch, text, type RecordedCall } from './helpers.ts';

const STARTED = {
  device_code: 'secret-device-code',
  user_code: 'WDJB-MJHT',
  verification_uri: `${BASE}/cli/device`,
  verification_uri_complete: `${BASE}/cli/device?code=WDJB-MJHT`,
  expires_in: 600,
  interval: 5,
};

const ME = { data: { name: 'Ada', email: 'ada@example.com' } };

/** A file.cafe that answers polls with `statuses` in turn, repeating the last one. */
function loginServer(...statuses: Array<Response | Record<string, string>>) {
  let polls = 0;

  return mockFetch((call: RecordedCall) => {
    if (call.url === `${BASE}/api/v1/cli/logins`) {
      return json(201, { data: STARTED });
    }

    if (call.url === `${BASE}/api/v1/cli/logins/token`) {
      const status = statuses[Math.min(polls++, statuses.length - 1)]!;

      return status instanceof Response ? status : json(200, { data: status });
    }

    if (call.url === `${BASE}/api/v1/me`) {
      return json(200, ME);
    }

    return json(404, { message: 'Not Found.' });
  });
}

describe('browser login', () => {
  it('shows the code, opens the approval page, and saves the token once it is approved', async () => {
    const { fetch, calls } = loginServer({ status: 'pending' }, { status: 'approved', token: '1|from-browser' });
    const opened: string[] = [];
    const { context, stdout, stderr, waits } = await createTestContext(fetch, { openBrowser: (url) => opened.push(url) });

    assert.equal(await loginCommand({}, {}, context), 0);

    assert.equal(calls[0]?.headers.authorization, undefined);
    assert.deepEqual(await bodyJson(calls[0]?.body), { name: hostname() });
    assert.deepEqual(await bodyJson(calls[1]?.body), { device_code: 'secret-device-code' });
    assert.match(stderr(), /Your one-time code: WDJB-MJHT/);
    assert.match(stderr(), new RegExp(`visit ${BASE}/cli/device and enter the code`));
    assert.deepEqual(opened, [STARTED.verification_uri_complete]);
    assert.deepEqual(waits, [5000, 5000]);
    assert.equal(calls.at(-1)?.headers.authorization, 'Bearer 1|from-browser');
    assert.equal(stdout(), 'Logged in as Ada (ada@example.com)\n');
    assert.deepEqual(await readConfig(context), { url: BASE, token: '1|from-browser' });
  });

  it('links the address to the prefilled page and shows a spinner in a terminal that supports it', async () => {
    const { fetch } = loginServer({ status: 'approved', token: '1|t' });
    let err = '';
    const { context } = await createTestContext(fetch, {
      env: { TERM_PROGRAM: 'iTerm.app' },
      stderr: { isTTY: true, write: (chunk: string) => (err += chunk) },
    });

    await loginCommand({}, {}, context);

    assert.ok(
      err.includes(`visit \u001B]8;;${STARTED.verification_uri_complete}\u0007${BASE}/cli/device\u001B]8;;\u0007 and enter the code`),
    );
    assert.match(err, /\r⠋ Waiting for approval\.\.\.\r\u001B\[2K/);
    assert.match(err, /\nRun "filecafe upload <file>" to share a file\.\n$/);
  });

  it('stops the spinner when the login fails', async () => {
    const { fetch } = loginServer({ status: 'denied' });
    let err = '';
    const { context } = await createTestContext(fetch, { stderr: { isTTY: true, write: (chunk: string) => (err += chunk) } });

    await assert.rejects(loginCommand({}, {}, context), /cancelled in the browser/);
    assert.ok(err.endsWith('\r\u001B[2K'));
  });

  it('stops when the login is cancelled in the browser', async () => {
    const { fetch } = loginServer({ status: 'denied' });
    const { context } = await createTestContext(fetch);

    await assert.rejects(loginCommand({}, {}, context), /cancelled in the browser/);
    assert.equal(await readConfig(context), null);
  });

  it('stops when file.cafe says the code expired', async () => {
    const { fetch } = loginServer({ status: 'expired' });
    const { context } = await createTestContext(fetch);

    await assert.rejects(loginCommand({}, {}, context), /code expired/);
  });

  it('gives up once the code has expired without an approval', async () => {
    const { fetch, calls } = loginServer({ status: 'pending' });
    const { context } = await createTestContext(fetch);

    await assert.rejects(loginCommand({}, {}, context), /code expired/);
    assert.equal(calls.filter((call) => call.url.endsWith('/token')).length, 600 / 5);
  });

  it('gives up on time even when polls are slow to fail', async () => {
    let advanceClock = (_ms: number) => {};
    let polls = 0;
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith('/api/v1/cli/logins')) {
        return json(201, { data: STARTED });
      }

      polls++;
      advanceClock(55_000);
      throw new TypeError('fetch failed');
    });
    const { context, waits } = await createTestContext(fetch);
    advanceClock = (ms) => waits.push(ms);

    await assert.rejects(loginCommand({}, {}, context), /code expired/);
    assert.equal(polls, 10);
  });

  it('keeps polling through network errors and server failures', async () => {
    let polls = 0;
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith('/api/v1/cli/logins')) {
        return json(201, { data: STARTED });
      }

      if (call.url.endsWith('/token')) {
        polls++;

        if (polls === 1) {
          throw new TypeError('fetch failed');
        }

        return polls === 2 ? text(503, 'Service Unavailable') : json(200, { data: { status: 'approved', token: '1|t' } });
      }

      return json(200, ME);
    });
    const { context } = await createTestContext(fetch);

    assert.equal(await loginCommand({}, {}, context), 0);
    assert.deepEqual(await readConfig(context), { url: BASE, token: '1|t' });
  });

  it('explains when the server does not support browser login', async () => {
    const { fetch } = mockFetch(() => json(201, { data: { unexpected: true } }));
    const { context } = await createTestContext(fetch);

    await assert.rejects(loginCommand({}, {}, context), /Unexpected response/);
  });
});

describe('login --token / --with-token', () => {
  it('validates the token with /me and saves it', async () => {
    const { fetch, calls } = mockFetch(() => json(200, { data: { name: 'Ada', email: 'ada@example.com' } }));
    const { context, stdout } = await createTestContext(fetch);

    assert.equal(await loginCommand({ token: '1|abc' }, {}, context), 0);
    assert.equal(calls[0]?.headers.authorization, 'Bearer 1|abc');
    assert.equal(stdout(), 'Logged in as Ada (ada@example.com)\n');
    assert.deepEqual(await readConfig(context), { url: BASE, token: '1|abc' });
    assert.equal((await stat(configPath(context))).mode & 0o777, 0o600);
  });

  it('reads the token from stdin with --with-token', async () => {
    const { fetch } = mockFetch(() => json(200, { data: { name: 'Ada', email: 'ada@example.com' } }));
    const { context } = await createTestContext(fetch, {
      stdin: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('2|from-stdin\n');
        },
      },
    });

    await loginCommand({ withToken: true }, { url: 'http://file-cafe.test' }, context);
    assert.deepEqual(await readConfig(context), { url: 'http://file-cafe.test', token: '2|from-stdin' });
  });

  it('does not save a token the server rejects', async () => {
    const { fetch } = mockFetch(() => json(401, { message: 'Unauthenticated.' }));
    const { context } = await createTestContext(fetch);

    await assert.rejects(loginCommand({ token: 'bad' }, {}, context), /rejected/);
    assert.equal(await readConfig(context), null);
  });
});
