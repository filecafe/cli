import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configPath } from './config.ts';
import type { Context } from './context.ts';
import { VERSION } from './version.ts';

const REGISTRY_URL = 'https://registry.npmjs.org/filecafe/latest';
const RELEASES_URL = 'https://github.com/filecafe/cli/releases/tag';

/** Ask npm at most once a day, even when the registry cannot be reached. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 2000;

interface UpdateCache {
  checkedAt: number;
  latest: string | null;
  /** The newest version the user said no to, so they are only asked once per release. */
  declined?: string;
}

interface Installer {
  command: string;
  args: string[];
  /** Whether running `command` upgrades the copy that is running now. */
  global: boolean;
}

/**
 * Start looking for a newer release while the command runs. The returned function reports it
 * on stderr once the command's own output is done, and offers to install it when the user is
 * at a terminal and the CLI was installed globally.
 *
 * Nothing is shown in CI, when stderr is piped (scripts and AI agents), or when
 * FILECAFE_NO_UPDATE_CHECK is set.
 */
export function startUpdateCheck(context: Context): () => Promise<void> {
  if (!context.stderr.isTTY || context.env.CI || context.env.FILECAFE_NO_UPDATE_CHECK) {
    return async () => {};
  }

  const path = join(dirname(configPath(context)), 'update-check.json');
  const check = refreshCache(context, path).catch(() => null);

  return async () => {
    const cache = await check;
    const latest = cache?.latest;

    if (!cache || !latest || !isNewer(latest, VERSION)) {
      return;
    }

    const installer = detectInstaller(context);
    const command = [installer.command, ...installer.args].join(' ');

    context.stderr.write(
      `\nUpdate available for filecafe (${VERSION} → ${latest}).\nChangelog: ${RELEASES_URL}/v${latest}\n`,
    );

    const canAsk = installer.global && context.stdin.isTTY && context.stdout.isTTY && cache.declined !== latest;

    if (!canAsk) {
      context.stderr.write(`Run: ${command}\n`);

      return;
    }

    if (!(await context.confirm('Would you like to upgrade now? (Y/n) '))) {
      context.stderr.write(`Run "${command}" whenever you're ready.\n`);
      await writeCache(path, { ...cache, declined: latest }).catch(() => {});

      return;
    }

    context.stderr.write(`> ${command}\n`);

    const exitCode = await context.run(installer.command, installer.args);

    context.stderr.write(
      exitCode === 0 ? `Updated filecafe to ${latest}.\n` : `The update failed. Run it yourself: ${command}\n`,
    );
  };
}

async function refreshCache(context: Context, path: string): Promise<UpdateCache> {
  const cache = await readCache(path);

  if (cache && context.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
    return cache;
  }

  // Keep the last known version if npm cannot be reached, and don't ask again until tomorrow.
  const fresh = { ...cache, checkedAt: context.now(), latest: (await fetchLatest(context)) ?? cache?.latest ?? null };

  await writeCache(path, fresh);

  return fresh;
}

async function readCache(path: string): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCache>;

    if (typeof parsed.checkedAt === 'number' && (typeof parsed.latest === 'string' || parsed.latest === null)) {
      return {
        checkedAt: parsed.checkedAt,
        latest: parsed.latest,
        ...(typeof parsed.declined === 'string' && { declined: parsed.declined }),
      };
    }
  } catch {
    // Missing or corrupt: check again.
  }

  return null;
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cache)}\n`);
}

async function fetchLatest(context: Context): Promise<string | null> {
  try {
    const response = await context.fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': context.userAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const { version } = (await response.json()) as { version?: unknown };

    return typeof version === 'string' && parseVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Work out how the running copy was installed from where it lives, so the upgrade goes through
 * the same package manager instead of leaving a second, older copy on the PATH.
 */
export function detectInstaller({ env, scriptPath }: Pick<Context, 'env' | 'scriptPath'>): Installer {
  const path = scriptPath.replaceAll('\\', '/');

  if (env.npm_command === 'exec' || path.includes('/_npx/')) {
    return { command: 'npx', args: ['filecafe@latest'], global: false };
  }

  if (path.includes('/pnpm/global/')) {
    return { command: 'pnpm', args: ['add', '-g', 'filecafe@latest'], global: true };
  }

  if (path.includes('/.bun/install/global/')) {
    return { command: 'bun', args: ['add', '-g', 'filecafe@latest'], global: true };
  }

  if (path.includes('/yarn/global/')) {
    return { command: 'yarn', args: ['global', 'add', 'filecafe@latest'], global: true };
  }

  // npm's global folder: <prefix>/lib/node_modules on macOS and Linux, %APPDATA%\npm\node_modules on Windows.
  const npmGlobal = /\/lib\/node_modules\/filecafe\//.test(path) || /\/npm\/node_modules\/filecafe\//.test(path);

  return { command: 'npm', args: ['i', '-g', 'filecafe@latest'], global: npmGlobal };
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `candidate` is a later release than `current`. Pre-releases never count as newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);

  if (!a || !b) {
    return false;
  }

  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i]! > b[i]!;
    }
  }

  return false;
}
