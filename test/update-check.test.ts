import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { Context } from '../src/context.ts';
import { CHECK_INTERVAL_MS, refreshUpdateCache, updateCachePath, type UpdateCache } from '../src/update-cache.ts';
import type { FetchLike } from '../src/api.ts';
import { detectInstaller, isNewer, NOTIFY_INTERVAL_MS, startUpdateCheck } from '../src/update-check.ts';
import { VERSION } from '../src/version.ts';
import { createTestContext, json, mockFetch, tempDir } from './helpers.ts';

const NEWER = '99.0.0';
const NOW = 1_000_000_000;
const NPM_ROOT = '/usr/local/lib/node_modules';
const NPM_GLOBAL = `${NPM_ROOT}/filecafe/dist/cli.js`;

/** `npm root -g` answers; every other package manager is missing. */
const npmOnly: Context['capture'] = async (command) => (command === 'npm' ? `${NPM_ROOT}\n` : null);

/** A terminal session where the update cache says `cached` is the latest version. */
async function terminal(cached: Partial<UpdateCache> | null, registry: () => Response, overrides: Partial<Context> = {}) {
  const { fetch, calls } = mockFetch(registry);
  let err = '';
  const questions: string[] = [];
  const runs: string[] = [];
  const refreshes: string[] = [];

  const test = await createTestContext(fetch, {
    stdout: { isTTY: true, write: () => true },
    stderr: { isTTY: true, write: (chunk: string) => (err += chunk) },
    stdin: { isTTY: true, async *[Symbol.asyncIterator]() {} },
    now: () => NOW,
    confirm: async (question) => {
      questions.push(question);

      return false;
    },
    run: async (command, args) => {
      runs.push([command, ...args].join(' '));

      return 0;
    },
    capture: npmOnly,
    refreshInBackground: (path) => refreshes.push(path),
    scriptPath: NPM_GLOBAL,
    ...overrides,
  });

  const cachePath = updateCachePath(test.context);

  if (cached) {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ expireAt: NOW + 1, version: NEWER, ...cached }));
  }

  const readCache = async () => JSON.parse(await readFile(cachePath, 'utf8')) as UpdateCache;

  return { ...test, calls, questions, runs, refreshes, stderr: () => err, cachePath, readCache };
}

const latest = (version: string) => () => json(200, { name: 'filecafe', version });
const unreachable = () => {
  throw new TypeError('fetch failed');
};

describe('update check', () => {
  it('refreshes the cache in the background instead of waiting on npm', async () => {
    for (const cached of [null, { expireAt: NOW, version: VERSION }]) {
      const session = await terminal(cached, latest(NEWER));

      await startUpdateCheck(session.context)();

      assert.deepEqual(session.refreshes, [session.cachePath]);
      assert.equal(session.calls.length, 0);
      assert.equal(session.stderr(), '');
    }
  });

  it('leaves a fresh cache alone', async () => {
    const session = await terminal({ version: VERSION }, latest(NEWER));

    await startUpdateCheck(session.context)();

    assert.deepEqual(session.refreshes, []);
    assert.equal(session.calls.length, 0);
  });

  it('confirms a cached update with npm, then offers it and upgrades through npm', async () => {
    const session = await terminal({ version: '98.0.0' }, latest(NEWER), { confirm: async () => true });

    await startUpdateCheck(session.context)();

    assert.equal(session.calls[0]?.url, 'https://registry.npmjs.org/filecafe/latest');
    assert.equal(
      session.stderr(),
      `\nUpdate available for filecafe (${VERSION} → ${NEWER}).\n` +
        `Changelog: https://github.com/filecafe/cli/releases/tag/v${NEWER}\n` +
        '> npm i -g filecafe@latest\n' +
        'Updated filecafe.\n',
    );
    assert.deepEqual(session.runs, ['npm i -g filecafe@latest']);
    assert.deepEqual(await session.readCache(), {
      expireAt: NOW + CHECK_INTERVAL_MS,
      version: NEWER,
      notifyAt: NOW + NOTIFY_INTERVAL_MS,
    });
  });

  it('says nothing when npm shows the cached update was already installed', async () => {
    const session = await terminal({}, latest(VERSION));

    await startUpdateCheck(session.context)();

    assert.equal(session.stderr(), '');
    assert.equal((await session.readCache()).version, VERSION);
  });

  it('still offers the update, without naming a version, when npm cannot confirm it', async () => {
    const session = await terminal({}, unreachable);

    await startUpdateCheck(session.context)();

    assert.equal(session.stderr(), '\nA newer version of filecafe may be available.\n');
    assert.equal(session.questions.length, 1);
  });

  it('mentions an update at most every three days', async () => {
    let now = NOW;
    const session = await terminal({ expireAt: Number.MAX_SAFE_INTEGER }, latest(NEWER), { now: () => now });

    await startUpdateCheck(session.context)();
    await startUpdateCheck(session.context)();
    assert.equal(session.questions.length, 1);
    assert.deepEqual(session.runs, []);

    now += NOTIFY_INTERVAL_MS;
    await startUpdateCheck(session.context)();
    assert.equal(session.questions.length, 2);
  });

  it('keeps what the background refresh saved while the command ran', async () => {
    const session = await terminal({ expireAt: NOW, version: '98.0.0' }, unreachable, {
      refreshInBackground: (path) => {
        void writeFile(path, JSON.stringify({ expireAt: NOW + CHECK_INTERVAL_MS, version: NEWER }));
      },
    });

    const printNotice = startUpdateCheck(session.context);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the command runs; the worker finishes
    await printNotice();

    assert.deepEqual(await session.readCache(), {
      expireAt: NOW + CHECK_INTERVAL_MS,
      version: NEWER,
      notifyAt: NOW + NOTIFY_INTERVAL_MS,
    });
  });

  it('reports a failed upgrade with the command to run by hand', async () => {
    const session = await terminal({}, latest(NEWER), { confirm: async () => true, run: async () => 1 });

    await startUpdateCheck(session.context)();

    assert.match(session.stderr(), /The update failed\. Run it yourself: npm i -g filecafe@latest\n$/);
  });

  it('says so instead of guessing when it cannot tell which package manager installed it', async () => {
    const session = await terminal({}, latest(NEWER), {
      confirm: async () => true,
      scriptPath: '/home/ada/project/node_modules/filecafe/dist/cli.js',
    });

    await startUpdateCheck(session.context)();

    assert.deepEqual(session.runs, []);
    assert.match(session.stderr(), /Could not tell whether npm, pnpm, Yarn, or Bun installed filecafe\./);
  });

  it('prints the upgrade command without asking when output is piped', async () => {
    for (const overrides of [
      { stdout: { isTTY: false, write: () => true } },
      { stdin: { isTTY: false, async *[Symbol.asyncIterator]() {} } },
    ] satisfies Partial<Context>[]) {
      const session = await terminal({}, latest(NEWER), overrides);

      await startUpdateCheck(session.context)();

      assert.deepEqual(session.questions, []);
      assert.match(session.stderr(), /Run: npm i -g filecafe@latest\n$/);
    }
  });

  it('points npx users at npx and never offers to install', async () => {
    for (const overrides of [
      { env: { npm_command: 'exec' } },
      { scriptPath: '/Users/ada/.npm/_npx/1a2b3c/node_modules/filecafe/dist/cli.js' },
    ] satisfies Partial<Context>[]) {
      const session = await terminal({}, latest(NEWER), overrides);

      await startUpdateCheck(session.context)();

      assert.deepEqual(session.questions, []);
      assert.match(session.stderr(), /Run: npx filecafe@latest\n$/);
    }
  });

  it('does nothing at all in CI, when stderr is piped, or when turned off', async () => {
    for (const overrides of [
      { env: { CI: 'true' } },
      { env: { FILECAFE_NO_UPDATE_CHECK: '1' } },
      { env: { NO_UPDATE_NOTIFIER: '1' } },
      { stderr: { isTTY: false, write: () => true } },
    ] satisfies Partial<Context>[]) {
      const session = await terminal(null, latest(NEWER), overrides);

      await startUpdateCheck(session.context)();

      assert.deepEqual(session.refreshes, []);
      assert.equal(session.calls.length, 0);
      assert.equal(session.stderr(), '');
    }
  });
});

describe('background refresh', () => {
  const refresh = async (path: string, registry: () => Response) =>
    refreshUpdateCache(path, { fetch: mockFetch(registry).fetch, userAgent: 'test', now: () => NOW });

  const cacheFile = async (cache?: UpdateCache) => {
    const path = join(await tempDir(), 'filecafe', 'update-check.json');

    if (cache) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(cache));
    }

    return path;
  };

  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as UpdateCache;

  /** The lock files next to the cache, with their contents. */
  const locks = async (path: string) => {
    const names = (await readdir(dirname(path))).filter((name) => name.includes('.lock'));

    return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(dirname(path), name), 'utf8')])));
  };

  it('saves the latest version and checks again tomorrow', async () => {
    const path = await cacheFile();

    await refresh(path, latest(NEWER));

    assert.deepEqual(await read(path), { expireAt: NOW + CHECK_INTERVAL_MS, version: NEWER });
  });

  it('keeps the reminder schedule for the same release and resets it for a new one', async () => {
    const same = await cacheFile({ expireAt: 0, version: NEWER, notifyAt: NOW + 5 });
    const newer = await cacheFile({ expireAt: 0, version: '98.0.0', notifyAt: NOW + 5 });

    await refresh(same, latest(NEWER));
    await refresh(newer, latest(NEWER));

    assert.equal((await read(same)).notifyAt, NOW + 5);
    assert.equal((await read(newer)).notifyAt, undefined);
  });

  it('leaves the cache alone when npm cannot be reached, so the next command tries again', async () => {
    const path = await cacheFile({ expireAt: 0, version: NEWER });

    await refresh(path, unreachable);

    assert.deepEqual(await read(path), { expireAt: 0, version: NEWER });
  });

  it('ignores pre-releases and nonsense from the registry', async () => {
    for (const version of ['99.0.0-beta.1', 'latest', 99]) {
      const path = await cacheFile();

      await refresh(path, () => json(200, { version }));

      await assert.rejects(readFile(path, 'utf8'), `for ${JSON.stringify(version)}`);
    }
  });

  it('lets only one of many simultaneous refreshes ask npm, even when reclaiming a stale lock', async () => {
    for (let round = 0; round < 20; round++) {
      for (const staleLock of [false, true]) {
        const path = await cacheFile();
        let requests = 0;
        const slowFetch: FetchLike = async () => {
          requests++;
          await new Promise((resolve) => setTimeout(resolve, 30));

          return json(200, { version: NEWER });
        };

        await mkdir(dirname(path), { recursive: true });

        if (staleLock) {
          await writeFile(`${path}.lock.4`, '999999:stale');
        }

        await Promise.all(
          Array.from({ length: 10 }, () => refreshUpdateCache(path, { fetch: slowFetch, userAgent: 'test', now: () => NOW })),
        );

        assert.equal(requests, 1, `round ${round}, stale lock: ${staleLock}`);
        assert.equal((await read(path)).version, NEWER);
        assert.deepEqual(await locks(path), { [staleLock ? 'update-check.json.lock.5' : 'update-check.json.lock.1']: 'released' });
        assert.deepEqual((await readdir(dirname(path))).filter((name) => name.endsWith('.tmp')), [], 'no temporary files are left');
      }
    }
  });

  it('does nothing while another refresh holds the lock, and takes over one whose owner exited', async () => {
    const path = await cacheFile();

    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock.1`, `${process.pid}:live`);
    await refresh(path, latest(NEWER));
    await assert.rejects(readFile(path, 'utf8'));

    await writeFile(`${path}.lock.1`, '999999:exited');
    await refresh(path, latest(NEWER));
    assert.equal((await read(path)).version, NEWER);
    assert.deepEqual(await locks(path), { 'update-check.json.lock.2': 'released' });

    await refreshUpdateCache(path, { fetch: mockFetch(latest('100.0.0')).fetch, userAgent: 'test', now: () => NOW + CHECK_INTERVAL_MS });
    assert.equal((await read(path)).version, '100.0.0');
    assert.deepEqual(await locks(path), { 'update-check.json.lock.3': 'released' });
  });

  it('skips npm when another refresh updated the cache while it waited', async () => {
    const path = await cacheFile({ expireAt: NOW + 1, version: NEWER });
    const { fetch, calls } = mockFetch(latest('100.0.0'));

    await refreshUpdateCache(path, { fetch, userAgent: 'test', now: () => NOW });

    assert.equal(calls.length, 0);
    assert.equal((await read(path)).version, NEWER);
  });
});

describe('detectInstaller', () => {
  /** Answers detect commands from `outputs` and resolves symlinks from `links`. */
  const detect = (scriptPath: string, outputs: Record<string, string>, links: Record<string, string> = {}) =>
    detectInstaller({
      scriptPath,
      capture: async (command) => outputs[command] ?? null,
      realpath: async (path) => links[path] ?? path,
    }).then((installer) => installer?.join(' ') ?? null);

  it('asks npm where its global packages live, following the bin symlink', async () => {
    assert.equal(
      await detect('/usr/local/bin/filecafe', { npm: `${NPM_ROOT}\n` }, { '/usr/local/bin/filecafe': NPM_GLOBAL }),
      'npm i -g filecafe@latest',
    );
  });

  it('finds pnpm, Yarn, and Bun global installs', async () => {
    const pnpmDir = '/Users/ada/Library/pnpm/global/5/node_modules/filecafe';
    const pnpmList = JSON.stringify([{ dependencies: { filecafe: { version: '0.2.0', path: pnpmDir } } }]);

    assert.equal(await detect(`${pnpmDir}/dist/cli.js`, { npm: NPM_ROOT, pnpm: pnpmList }), 'pnpm add -g filecafe@latest');
    assert.equal(
      await detect('/Users/ada/.config/yarn/global/node_modules/filecafe/dist/cli.js', {
        yarn: '/Users/ada/.config/yarn/global',
      }),
      'yarn global add filecafe@latest',
    );

    const bunScript = '/Users/ada/.bun/install/global/node_modules/filecafe/dist/cli.js';
    assert.equal(
      await detect(bunScript, { bun: '/Users/ada/.bun/bin' }, { '/Users/ada/.bun/bin/filecafe': bunScript }),
      'bun add -g filecafe@latest',
    );
  });

  it('answers as soon as one manager claims the install, and gives up on ones that hang', async () => {
    const hang = new Promise<string | null>(() => {});
    const signals: AbortSignal[] = [];
    const started = Date.now();

    const npmWins = await detectInstaller(
      {
        scriptPath: NPM_GLOBAL,
        capture: (command, _args, signal) => {
          signals.push(signal!);

          return command === 'npm' ? Promise.resolve(NPM_ROOT) : hang;
        },
        realpath: async (path) => path,
      },
      60_000,
    );
    const nobody = await detectInstaller({ scriptPath: NPM_GLOBAL, capture: () => hang, realpath: async (path) => path }, 50);

    assert.deepEqual(npmWins, ['npm', 'i', '-g', 'filecafe@latest']);
    assert.equal(nobody, null);
    assert.ok(Date.now() - started < 1000);
    assert.equal(signals.length, 4);
    assert.ok(signals.every((signal) => signal.aborted), 'the probes still running are killed');
  });

  it('does not claim a project dependency or a source checkout', async () => {
    assert.equal(await detect('/home/ada/project/node_modules/filecafe/dist/cli.js', { npm: NPM_ROOT }), null);
    assert.equal(await detect('/home/ada/code/filecafe-cli/src/cli.ts', { npm: NPM_ROOT, yarn: '/x' }), null);
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
