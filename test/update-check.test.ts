import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { configPath } from '../src/config.ts';
import type { Context } from '../src/context.ts';
import { CHECK_INTERVAL_MS, detectInstaller, isNewer, startUpdateCheck } from '../src/update-check.ts';
import { VERSION } from '../src/version.ts';
import { createTestContext, json, mockFetch } from './helpers.ts';

const NEWER = '99.0.0';
const NPM_GLOBAL = '/usr/local/lib/node_modules/filecafe/dist/cli.js';

/** A terminal session: stdin, stdout and stderr are all TTYs. */
async function terminal(registry: () => Response, overrides: Partial<Context> = {}) {
  const { fetch, calls } = mockFetch(registry);
  let err = '';
  const questions: string[] = [];
  const runs: string[] = [];

  const test = await createTestContext(fetch, {
    stdout: { isTTY: true, write: () => true },
    stderr: { isTTY: true, write: (chunk: string) => (err += chunk) },
    stdin: { isTTY: true, async *[Symbol.asyncIterator]() {} },
    now: () => 1_000_000_000,
    confirm: async (question) => {
      questions.push(question);

      return false;
    },
    run: async (command, args) => {
      runs.push([command, ...args].join(' '));

      return 0;
    },
    ...overrides,
  });

  const cachePath = join(dirname(configPath(test.context)), 'update-check.json');

  return { ...test, calls, questions, runs, stderr: () => err, cachePath };
}

const latest = (version: string) => () => json(200, { name: 'filecafe', version });

describe('update check', () => {
  it('offers to upgrade a global npm install and runs npm when the user says yes', async () => {
    const session = await terminal(latest(NEWER), { confirm: async () => true });

    await startUpdateCheck(session.context)();

    assert.equal(session.calls[0]?.url, 'https://registry.npmjs.org/filecafe/latest');
    assert.match(session.stderr(), new RegExp(`Update available for filecafe \\(${VERSION} → ${NEWER}\\)`));
    assert.match(session.stderr(), /Changelog: https:\/\/github\.com\/filecafe\/cli\/releases\/tag\/v99\.0\.0\n/);
    assert.deepEqual(session.runs, ['npm i -g filecafe@latest']);
    assert.match(session.stderr(), /Updated filecafe to 99\.0\.0\./);
  });

  it('reports a failed upgrade with the command to run by hand', async () => {
    const session = await terminal(latest(NEWER), { confirm: async () => true, run: async () => 1 });

    await startUpdateCheck(session.context)();

    assert.match(session.stderr(), /The update failed\. Run it yourself: npm i -g filecafe@latest/);
  });

  it('only asks once per release when the user says no', async () => {
    const session = await terminal(latest(NEWER));

    await startUpdateCheck(session.context)();
    await startUpdateCheck(session.context)();

    assert.deepEqual(session.questions, ['Would you like to upgrade now? (Y/n) ']);
    assert.deepEqual(session.runs, []);
    assert.match(session.stderr(), /Run: npm i -g filecafe@latest\n$/);
  });

  it('asks again when an even newer release comes out', async () => {
    const session = await terminal(latest('100.0.0'));
    await mkdir(dirname(session.cachePath), { recursive: true });
    await writeFile(session.cachePath, JSON.stringify({ checkedAt: 0, latest: NEWER, declined: NEWER }));

    await startUpdateCheck(session.context)();

    assert.equal(session.questions.length, 1);
  });

  it('says nothing when this is the latest version', async () => {
    const session = await terminal(latest(VERSION));

    await startUpdateCheck(session.context)();

    assert.equal(session.stderr(), '');
  });

  it('asks npm at most once a day', async () => {
    let now = 1_000_000_000;
    const session = await terminal(latest(NEWER), { now: () => now });

    await startUpdateCheck(session.context)();
    await startUpdateCheck(session.context)();
    assert.equal(session.calls.length, 1);

    now += CHECK_INTERVAL_MS;
    await startUpdateCheck(session.context)();
    assert.equal(session.calls.length, 2);
  });

  it('stays quiet and waits a day when npm cannot be reached', async () => {
    const session = await terminal(() => {
      throw new TypeError('fetch failed');
    });

    await startUpdateCheck(session.context)();
    await startUpdateCheck(session.context)();

    assert.equal(session.stderr(), '');
    assert.equal(session.calls.length, 1);
    assert.deepEqual(JSON.parse(await readFile(session.cachePath, 'utf8')), { checkedAt: 1_000_000_000, latest: null });
  });

  it('ignores pre-releases and nonsense from the registry', async () => {
    for (const version of ['99.0.0-beta.1', 'latest', 99]) {
      const session = await terminal(() => json(200, { version }));

      await startUpdateCheck(session.context)();

      assert.equal(session.stderr(), '', `for ${JSON.stringify(version)}`);
    }
  });

  it('prints the command without asking when output is piped or the CLI is not a global install', async () => {
    const cases: Partial<Context>[] = [
      { stdout: { isTTY: false, write: () => true } },
      { stdin: { isTTY: false, async *[Symbol.asyncIterator]() {} } },
      { scriptPath: '/home/ada/project/node_modules/filecafe/dist/cli.js' },
    ];

    for (const overrides of cases) {
      const session = await terminal(latest(NEWER), overrides);

      await startUpdateCheck(session.context)();

      assert.deepEqual(session.questions, []);
      assert.match(session.stderr(), /Run: npm i -g filecafe@latest/);
    }
  });

  it('does not check at all in CI, when stderr is piped, or when turned off', async () => {
    const cases: Partial<Context>[] = [
      { env: { CI: 'true' } },
      { env: { FILECAFE_NO_UPDATE_CHECK: '1' } },
      { stderr: { isTTY: false, write: () => true } },
    ];

    for (const overrides of cases) {
      const session = await terminal(latest(NEWER), overrides);

      await startUpdateCheck(session.context)();

      assert.equal(session.calls.length, 0);
      assert.equal(session.stderr(), '');
    }
  });
});

describe('detectInstaller', () => {
  const command = (scriptPath: string, env: Record<string, string> = {}) => {
    const installer = detectInstaller({ env, scriptPath });

    return `${[installer.command, ...installer.args].join(' ')}${installer.global ? '' : ' (no prompt)'}`;
  };

  it('upgrades through the package manager that installed the CLI', () => {
    assert.equal(command(NPM_GLOBAL), 'npm i -g filecafe@latest');
    assert.equal(
      command('/Users/ada/.nvm/versions/node/v24.22.1/lib/node_modules/filecafe/dist/cli.js'),
      'npm i -g filecafe@latest',
    );
    assert.equal(command('C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\filecafe\\dist\\cli.js'), 'npm i -g filecafe@latest');
    assert.equal(
      command('/Users/ada/Library/pnpm/global/5/node_modules/filecafe/dist/cli.js'),
      'pnpm add -g filecafe@latest',
    );
    assert.equal(command('/Users/ada/.bun/install/global/node_modules/filecafe/dist/cli.js'), 'bun add -g filecafe@latest');
    assert.equal(
      command('/Users/ada/.config/yarn/global/node_modules/filecafe/dist/cli.js'),
      'yarn global add filecafe@latest',
    );
  });

  it('points npx users at npx and never offers to install', () => {
    assert.equal(command('/Users/ada/.npm/_npx/1a2b3c/node_modules/filecafe/dist/cli.js'), 'npx filecafe@latest (no prompt)');
    assert.equal(command(NPM_GLOBAL, { npm_command: 'exec' }), 'npx filecafe@latest (no prompt)');
  });
});

describe('isNewer', () => {
  it('compares each part numerically', () => {
    assert.equal(isNewer('0.10.0', '0.9.9'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.2.0', '0.2.0'), false);
    assert.equal(isNewer('0.1.9', '0.2.0'), false);
  });
});
