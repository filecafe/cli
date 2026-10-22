import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { loginCommand, authorizeUrl } from '../src/commands/login.ts';
import { configPath, readConfig } from '../src/config.ts';
import { generateState, handleCallbackRequest, statesMatch } from '../src/login-server.ts';
import { BASE, createTestContext, json, mockFetch } from './helpers.ts';

const STATE = 'a'.repeat(32);

describe('login callback handler', () => {
  it('accepts GET /callback with the matching state and returns the token', () => {
    const response = handleCallbackRequest('GET', `/callback?token=1%7Cplain-text-token&state=${STATE}`, STATE);

    assert.equal(response.status, 200);
    assert.deepEqual(response.result, { token: '1|plain-text-token' });
    assert.match(response.body, /<h1>You're logged in to file\.cafe\.<\/h1><p>You can close this tab/);
  });

  it('rejects a mismatched or missing state without concluding the login', () => {
    const mismatched = handleCallbackRequest('GET', `/callback?token=stolen&state=${'b'.repeat(32)}`, STATE);
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.result, undefined);

    const shorter = handleCallbackRequest('GET', `/callback?token=stolen&state=${STATE.slice(1)}`, STATE);
    assert.equal(shorter.result, undefined);

    const missing = handleCallbackRequest('GET', '/callback?token=stolen', STATE);
    assert.equal(missing.status, 400);
    assert.equal(missing.result, undefined);
  });

  it('reports access_denied when the user cancels', () => {
    const response = handleCallbackRequest('GET', `/callback?error=access_denied&state=${STATE}`, STATE);

    assert.deepEqual(response.result, { error: 'access_denied' });
    assert.match(response.body, /cancelled/i);
  });

  it('ignores other paths and methods', () => {
    assert.equal(handleCallbackRequest('GET', '/favicon.ico', STATE).status, 404);
    assert.equal(handleCallbackRequest('POST', `/callback?token=t&state=${STATE}`, STATE).result, undefined);
  });

  it('generates 32-hex-character states and compares them safely', () => {
    const state = generateState();

    assert.match(state, /^[0-9a-f]{32}$/);
    assert.ok(statesMatch(state, state));
    assert.ok(!statesMatch(null, state));
    assert.ok(!statesMatch(`${state}x`, state));
  });

  it('builds the authorize URL with an encoded device name', () => {
    assert.equal(
      authorizeUrl(BASE, 4321, STATE, "Ada's MacBook"),
      `${BASE}/cli/authorize?port=4321&state=${STATE}&name=Ada's%20MacBook`,
    );
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
