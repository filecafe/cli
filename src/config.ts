import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://file.cafe';

export interface SavedConfig {
  url: string;
  token: string;
}

export interface ConfigEnvironment {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
}

export function defaultConfigEnvironment(): ConfigEnvironment {
  return { env: process.env, platform: process.platform, homedir: osHomedir() };
}

/**
 * Location of the config file:
 * - Windows: %APPDATA%\filecafe\config.json
 * - Elsewhere: $XDG_CONFIG_HOME/filecafe/config.json, falling back to ~/.config/filecafe/config.json
 */
export function configPath({ env, platform, homedir }: ConfigEnvironment): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(homedir, 'AppData', 'Roaming');

    return join(appData, 'filecafe', 'config.json');
  }

  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.startsWith('/') ? xdg : join(homedir, '.config');

  return join(base, 'filecafe', 'config.json');
}

/** Validate and normalize a base URL (http/https only, no trailing slash). */
export function normalizeBaseUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid URL "${value}". Expected something like https://file.cafe`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid URL "${value}". Only http:// and https:// URLs are supported.`);
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid URL "${value}". Pass only the site address, e.g. https://file.cafe`);
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export async function readConfig(environment: ConfigEnvironment): Promise<SavedConfig | null> {
  let raw: string;

  try {
    raw = await readFile(configPath(environment), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SavedConfig>;

    if (typeof parsed.url === 'string' && typeof parsed.token === 'string' && parsed.token) {
      return { url: normalizeBaseUrl(parsed.url), token: parsed.token };
    }
  } catch {
    // Fall through: treat a corrupt file as "not logged in".
  }

  return null;
}

/** Write the config file atomically with owner-only permissions (dir 0700, file 0600). */
export async function writeConfig(environment: ConfigEnvironment, config: SavedConfig): Promise<string> {
  const path = configPath(environment);
  const directory = dirname(path);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (environment.platform !== 'win32') {
    await chmod(directory, 0o700);
  }

  const temporary = `${path}.${process.pid}.tmp`;
  const contents = `${JSON.stringify({ url: config.url, token: config.token }, null, 2)}\n`;

  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);

  if (environment.platform !== 'win32') {
    await chmod(path, 0o600);
  }

  return path;
}

/** Delete the saved config. Returns true if a file was removed. */
export async function deleteConfig(environment: ConfigEnvironment): Promise<boolean> {
  const path = configPath(environment);

  try {
    await rm(path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export type TokenSource = 'env' | 'config';

export interface ResolvedSettings {
  baseUrl: string;
  token: string | null;
  tokenSource: TokenSource | null;
  saved: SavedConfig | null;
}

/**
 * Resolve the base URL and token.
 *
 * Base URL: --url, then FILECAFE_URL, then the URL saved by `filecafe login`, then https://file.cafe.
 * Token: FILECAFE_TOKEN, then the saved token — but the saved token is only used when it was
 * issued for the resolved base URL, so a token is never sent to a different site.
 */
export async function resolveSettings(
  environment: ConfigEnvironment,
  urlOption: string | undefined,
): Promise<ResolvedSettings> {
  const saved = await readConfig(environment);
  const explicitUrl = urlOption || environment.env.FILECAFE_URL;
  const baseUrl = normalizeBaseUrl(explicitUrl || saved?.url || DEFAULT_BASE_URL);
  const envToken = environment.env.FILECAFE_TOKEN?.trim();

  if (envToken) {
    return { baseUrl, token: envToken, tokenSource: 'env', saved };
  }

  if (saved && saved.url === baseUrl) {
    return { baseUrl, token: saved.token, tokenSource: 'config', saved };
  }

  return { baseUrl, token: null, tokenSource: null, saved };
}
