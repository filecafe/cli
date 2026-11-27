import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { upgradeCommand } from '../src/commands/upgrade.ts';
import type { Context } from '../src/context.ts';
import { VERSION } from '../src/version.ts';
import { createTestContext, json, mockFetch } from './helpers.ts';

const NPM_ROOT = '/usr/local/lib/node_modules';

/** `npm root -g` answers; every other package manager is missing. */
const npmOnly: Context['capture'] = async (command) => (command === 'npm' ? `${NPM_ROOT}\n` : null);

async function setup(registry: () => Response, overrides: Partial<Context> = {}, exitCode: number | null = 0) {
  const { fetch } = mockFetch(registry);
  const runs: string[] = [];
  const test = await createTestContext(fetch, {
    env: { NO_COLOR: '1' },
    capture: npmOnly,
    run: async (command, args) => {
      runs.push([command, ...args].join(' '));

      return exitCode;
    },
    ...overrides,
  });

  return { ...test, runs };
}

const latest = (version: string) => () => json(200, { version });

describe('upgrade', () => {
  it('installs the latest version with the package manager that installed filecafe', async () => {
    const { context, runs, stdout, stderr } = await setup(latest('99.0.0'));

    assert.equal(await upgradeCommand(context), 0);
    assert.deepEqual(runs, ['npm i -g filecafe@latest']);
    assert.equal(stderr(), `Upgrading filecafe v${VERSION} → v99.0.0\n> npm i -g filecafe@latest\n`);
    assert.equal(stdout(), 'Upgraded filecafe to v99.0.0.\n');
  });

  it('does nothing when this is already the latest version', async () => {
    const { context, runs, stdout } = await setup(latest(VERSION));

    assert.equal(await upgradeCommand(context), 0);
    assert.deepEqual(runs, []);
    assert.equal(stdout(), `filecafe v${VERSION} is already the latest version.\n`);
  });

  it('still upgrades when npm cannot say what the latest version is', async () => {
    const { context, runs, stdout } = await setup(() => json(503, {}));

    assert.equal(await upgradeCommand(context), 0);
    assert.deepEqual(runs, ['npm i -g filecafe@latest']);
    assert.equal(stdout(), 'Upgraded filecafe to the latest version.\n');
  });

  it('points npx users at npx@latest without installing anything', async () => {
    const { context, runs, stdout } = await setup(latest('99.0.0'), {
      scriptPath: '/Users/ada/.npm/_npx/1a2b3c/node_modules/filecafe/dist/cli.js',
    });

    assert.equal(await upgradeCommand(context), 0);
    assert.deepEqual(runs, []);
    assert.match(stdout(), /Run: npx filecafe@latest\n$/);
  });

  it('fails with the command to run when it cannot tell what installed filecafe', async () => {
    const { context, runs } = await setup(latest('99.0.0'), { capture: async () => null });

    await assert.rejects(upgradeCommand(context), /npm i -g filecafe@latest/);
    assert.deepEqual(runs, []);
  });

  it('fails with the command to run when the install fails', async () => {
    const { context, stdout } = await setup(latest('99.0.0'), {}, 1);

    await assert.rejects(upgradeCommand(context), /The upgrade failed\. Run it yourself: npm i -g filecafe@latest/);
    assert.equal(stdout(), '');
  });
});
