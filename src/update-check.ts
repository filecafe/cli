import { join, sep } from 'node:path';
import type { Context } from './context.ts';
import { colorsFor } from './terminal.ts';
import { CHECK_INTERVAL_MS, fetchLatestVersion, readUpdateCache, updateCachePath, updateUpdateCache, type UpdateCache } from './update-cache.ts';
import { VERSION } from './version.ts';

const RELEASES_URL = 'https://github.com/filecafe/cli/releases/tag';

/** Mention an update at most every three days, like the Vercel CLI. */
export const NOTIFY_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

/** How long the command may wait at the end to confirm a cached version is still the latest. */
const CONFIRM_TIMEOUT_MS = 3000;

/** How long to wait for the package managers to say where they keep global packages. */
export const DETECT_TIMEOUT_MS = 3000;

const UNKNOWN_INSTALL =
  'Could not tell whether npm, pnpm, Yarn, or Bun installed filecafe. Update it with the package manager that installed it.\n';

/**
 * Check for a newer release without slowing the command down. The cache is refreshed by a
 * detached worker; when it already knows of a newer version, npm is asked again while the
 * command runs so the notice never names a stale version.
 *
 * The returned function reports the update on stderr once the command's own output is done,
 * and offers to install it when the user is at a terminal. Nothing is shown in CI, when stderr
 * is piped (scripts and AI agents), or when FILECAFE_NO_UPDATE_CHECK or NO_UPDATE_NOTIFIER is set.
 */
export function startUpdateCheck(context: Context): () => Promise<void> {
  const { env } = context;

  if (!context.stderr.isTTY || env.CI || env.FILECAFE_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER) {
    return async () => {};
  }

  const path = updateCachePath(context);

  const pending = (async () => {
    const cache = await readUpdateCache(path);

    if (!cache || context.now() >= cache.expireAt) {
      context.refreshInBackground(path);
    }

    if (!cache?.version || !isNewer(cache.version, VERSION) || context.now() < (cache.notifyAt ?? 0)) {
      return null;
    }

    return { cache, fresh: await fetchLatestVersion(context.fetch, context.userAgent, CONFIRM_TIMEOUT_MS) };
  })().catch(() => null);

  return async () => {
    const result = await pending;

    if (!result) {
      return;
    }

    const { cache, fresh } = result;
    const confirmed = fresh ? { version: fresh, expireAt: context.now() + CHECK_INTERVAL_MS } : {};
    // The background worker may have refreshed the cache while the command ran, so build on that.
    const save = (change: Partial<UpdateCache>) =>
      updateUpdateCache(path, (current) => ({ ...(current ?? cache), ...confirmed, ...change })).catch(() => {});

    if (fresh && !isNewer(fresh, VERSION)) {
      // The cache was stale: this is already the latest version.
      await save({});

      return;
    }

    await save({ notifyAt: context.now() + NOTIFY_INTERVAL_MS });
    await offerUpdate(context, fresh);
  };
}

/** Show the notice and, at a terminal, offer to install. `version` is null when npm could not confirm it. */
async function offerUpdate(context: Context, version: string | null): Promise<void> {
  const color = colorsFor(context.stderr, context.env);
  const run = (command: string) => color.cyan(command);

  context.stderr.write(
    version
      ? `\nUpdate available for filecafe (${color.gray(VERSION)} → ${color.green(version)}).\n` +
          `Changelog: ${color.cyan(`${RELEASES_URL}/v${version}`)}\n`
      : '\nA newer version of filecafe may be available.\n',
  );

  if (context.env.npm_command === 'exec' || context.scriptPath.replaceAll('\\', '/').includes('/_npx/')) {
    context.stderr.write(`Run: ${run('npx filecafe@latest')}\n`);

    return;
  }

  if (!context.stdin.isTTY || !context.stdout.isTTY) {
    const installer = await detectInstaller(context);

    context.stderr.write(installer ? `Run: ${run(installer.join(' '))}\n` : UNKNOWN_INSTALL);

    return;
  }

  if (!(await context.confirm(`Would you like to upgrade now? ${color.gray('(Y/n)')} `))) {
    return;
  }

  const installer = await detectInstaller(context);

  if (!installer) {
    context.stderr.write(UNKNOWN_INSTALL);

    return;
  }

  const [command, ...args] = installer;

  context.stderr.write(`${color.gray(`> ${installer.join(' ')}`)}\n`);

  const exitCode = await context.run(command!, args);

  context.stderr.write(
    exitCode === 0
      ? `${color.green('Updated filecafe.')}\n`
      : `${color.red('The update failed.')} Run it yourself: ${run(installer.join(' '))}\n`,
  );
}

interface PackageManager {
  install: string[];
  /** Asks the package manager where it keeps global packages. */
  detect: string[];
  /** The global filecafe package folder, from the detect command's output. */
  packageDir?: (output: string) => string | undefined;
  /** For managers that report a folder of binaries instead. */
  binaryDir?: (output: string) => string;
}

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    install: ['npm', 'i', '-g', 'filecafe@latest'],
    detect: ['npm', 'root', '-g'],
    packageDir: (root) => join(root, 'filecafe'),
  },
  {
    install: ['pnpm', 'add', '-g', 'filecafe@latest'],
    detect: ['pnpm', 'list', '-g', 'filecafe', '--depth=0', '--json'],
    packageDir: (output) => {
      try {
        const parsed = JSON.parse(output) as unknown;
        const project = (Array.isArray(parsed) ? parsed[0] : parsed) as
          | { dependencies?: { filecafe?: { path?: unknown } } }
          | undefined;
        const path = project?.dependencies?.filecafe?.path;

        return typeof path === 'string' ? path : undefined;
      } catch {
        return undefined;
      }
    },
  },
  {
    install: ['yarn', 'global', 'add', 'filecafe@latest'],
    detect: ['yarn', '--silent', 'global', 'dir'],
    packageDir: (root) => join(root, 'node_modules', 'filecafe'),
  },
  {
    install: ['bun', 'add', '-g', 'filecafe@latest'],
    detect: ['bun', 'pm', 'bin', '-g'],
    binaryDir: (root) => root,
  },
];

/**
 * Find the package manager whose global install is the copy running now, by asking each one
 * (all at once) where it keeps global packages. Returns the command that upgrades it, or null
 * when none of them owns this copy (a project dependency, a source checkout, or an unusual
 * setup) or they take longer than `timeoutMs` to answer.
 */
export async function detectInstaller(
  context: Pick<Context, 'scriptPath' | 'capture' | 'realpath'>,
  timeoutMs = DETECT_TIMEOUT_MS,
): Promise<string[] | null> {
  const installPath = await context.realpath(context.scriptPath);

  if (!installPath) {
    return null;
  }

  const stop = new AbortController();

  const owns = async (manager: PackageManager): Promise<boolean> => {
    const [command, ...args] = manager.detect;
    const output = (await context.capture(command!, args, stop.signal))?.trim();

    if (!output) {
      return false;
    }

    const packageDir = manager.packageDir?.(output);
    const resolvedDir = packageDir && (await context.realpath(packageDir));

    if (resolvedDir && installPath.startsWith(resolvedDir + sep)) {
      return true;
    }

    return !!manager.binaryDir && (await context.realpath(join(manager.binaryDir(output), 'filecafe'))) === installPath;
  };

  let timer: NodeJS.Timeout | undefined;

  try {
    // The first manager that owns this copy wins; a slow or missing one can't hold up the rest.
    return await new Promise<string[] | null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);

      const checks = PACKAGE_MANAGERS.map((manager) =>
        owns(manager).then((owned) => owned && resolve(manager.install), () => {}),
      );

      void Promise.all(checks).then(() => resolve(null));
    });
  } finally {
    clearTimeout(timer);
    // Kill the probes still running so they don't keep the CLI from exiting.
    stop.abort();
  }
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
