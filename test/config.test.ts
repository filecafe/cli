import assert from 'node:assert/strict';
import { stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  configPath,
  deleteConfig,
  normalizeBaseUrl,
  readConfig,
  resolveSettings,
  writeConfig,
  type ConfigEnvironment,
} from '../src/config.ts';
import { tempDir } from './helpers.ts';

async function environment(env: Record<string, string> = {}): Promise<ConfigEnvironment> {
  return { env, platform: 'linux', homedir: await tempDir() };
}

describe('config', () => {
  it('resolves the config path for XDG, ~/.config, and Windows', () => {
    assert.equal(
      configPath({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', homedir: '/home/ada' }),
      '/xdg/filecafe/config.json',
    );
    assert.equal(configPath({ env: {}, platform: 'darwin', homedir: '/Users/ada' }), '/Users/ada/.config/filecafe/config.json');
    assert.equal(
      configPath({ env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\ada' }),
      join('C:\\Users\\ada\\AppData\\Roaming', 'filecafe', 'config.json'),
    );
  });

  it('writes the config with 0600 permissions in a 0700 directory and reads it back', async () => {
    const env = await environment();
    const path = await writeConfig(env, { url: 'https://file.cafe', token: 'saved-token' });

    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
    assert.deepEqual(await readConfig(env), { url: 'https://file.cafe', token: 'saved-token' });

    assert.equal(await deleteConfig(env), true);
    assert.equal(await readConfig(env), null);
    assert.equal(await deleteConfig(env), false);
  });

  it('prefers FILECAFE_TOKEN over the saved token', async () => {
    const env = await environment({ FILECAFE_TOKEN: 'env-token' });
    await writeConfig(env, { url: 'https://file.cafe', token: 'saved-token' });

    const settings = await resolveSettings(env, undefined);

    assert.equal(settings.token, 'env-token');
    assert.equal(settings.tokenSource, 'env');
    assert.equal(settings.baseUrl, 'https://file.cafe');
  });

  it('uses the saved token when FILECAFE_TOKEN is not set', async () => {
    const env = await environment();
    await writeConfig(env, { url: 'https://file.cafe', token: 'saved-token' });

    const settings = await resolveSettings(env, undefined);

    assert.equal(settings.token, 'saved-token');
    assert.equal(settings.tokenSource, 'config');
  });

  it('resolves the URL from --url, then FILECAFE_URL, then the saved login, then the default', async () => {
    const env = await environment({ FILECAFE_URL: 'http://env.test/' });
    await writeConfig(env, { url: 'http://saved.test', token: 'saved-token' });

    assert.equal((await resolveSettings(env, 'http://flag.test')).baseUrl, 'http://flag.test');
    assert.equal((await resolveSettings(env, undefined)).baseUrl, 'http://env.test');

    const savedOnly = { ...env, env: {} };
    assert.equal((await resolveSettings(savedOnly, undefined)).baseUrl, 'http://saved.test');
    assert.equal((await resolveSettings(await environment(), undefined)).baseUrl, 'https://file.cafe');
  });

  it('never sends a saved token to a different site', async () => {
    const env = await environment();
    await writeConfig(env, { url: 'https://file.cafe', token: 'saved-token' });

    const settings = await resolveSettings(env, 'http://file-cafe.test');

    assert.equal(settings.token, null);
  });

  it('treats a corrupt config file as logged out', async () => {
    const env = await environment();
    await mkdir(join(configPath(env), '..'), { recursive: true });
    await writeFile(configPath(env), '{not json');

    assert.equal(await readConfig(env), null);
  });

  it('normalizes and validates base URLs', () => {
    assert.equal(normalizeBaseUrl('https://file.cafe/'), 'https://file.cafe');
    assert.equal(normalizeBaseUrl('http://file-cafe.test'), 'http://file-cafe.test');
    assert.throws(() => normalizeBaseUrl('ftp://file.cafe'), /Only http/);
    assert.throws(() => normalizeBaseUrl('not a url'), /Invalid URL/);
  });
});
