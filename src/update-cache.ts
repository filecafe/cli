import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FetchLike } from './api.ts';
import { configPath, type ConfigEnvironment } from './config.ts';

const REGISTRY_URL = 'https://registry.npmjs.org/filecafe/latest';

/** Ask npm at most once a day. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long the background refresh may wait for npm. */
const BACKGROUND_TIMEOUT_MS = 8000;

/** Shared by the CLI, which reads it, and the background worker, which keeps it fresh. */
export interface UpdateCache {
  /** When the background worker should ask npm again. */
  expireAt: number;
  /** Don't mention an update before this time. */
  notifyAt?: number;
  /** The latest version on npm when last checked. */
  version: string;
}

export function updateCachePath(environment: ConfigEnvironment): string {
  return join(dirname(configPath(environment)), 'update-check.json');
}

export async function readUpdateCache(path: string): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCache>;

    if (typeof parsed.expireAt === 'number' && typeof parsed.version === 'string') {
      return {
        expireAt: parsed.expireAt,
        version: parsed.version,
        ...(typeof parsed.notifyAt === 'number' && { notifyAt: parsed.notifyAt }),
      };
    }
  } catch {
    // Missing or corrupt: check again.
  }

  return null;
}

/**
 * Re-read the cache and save `change(current)`. The CLI and the background worker both write
 * the cache, so each applies its change to what is on disk now rather than to what it read
 * earlier; the write replaces the file atomically so a reader never sees half of it.
 */
export async function updateUpdateCache(
  path: string,
  change: (current: UpdateCache | null) => UpdateCache,
): Promise<void> {
  const next = change(await readUpdateCache(path));

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await replaceFile(path, `${JSON.stringify(next)}\n`);
}

/** Write `contents` to a temporary file and move it over `path` in one step. */
async function replaceFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
}

/** The version npm's `latest` tag points at, or null if npm cannot be reached in time. */
export async function fetchLatestVersion(fetch: FetchLike, userAgent: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return null;
    }

    const { version } = (await response.json()) as { version?: unknown };

    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

interface RefreshOptions {
  fetch: FetchLike;
  userAgent: string;
  now: () => number;
}

/**
 * Ask npm for the latest version and save it. Runs in the background worker, so only one runs
 * at a time (guarded by a lock next to the cache) and errors are swallowed. If npm cannot
 * be reached the cache is left as it was, so the next command tries again.
 */
export async function refreshUpdateCache(path: string, { fetch, userAgent, now }: RefreshOptions): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const lock = await acquireLock(path);

  if (!lock) {
    return;
  }

  try {
    const current = await readUpdateCache(path);

    // Another refresh finished just before we took the lock.
    if (current && now() < current.expireAt) {
      return;
    }

    const version = await fetchLatestVersion(fetch, userAgent, BACKGROUND_TIMEOUT_MS);

    if (!version) {
      return;
    }

    await updateUpdateCache(path, (previous) => ({
      expireAt: now() + CHECK_INTERVAL_MS,
      version,
      // A new release resets the reminder so it is mentioned right away.
      ...(previous?.notifyAt !== undefined && version === previous.version && { notifyAt: previous.notifyAt }),
    }));
  } finally {
    await replaceFile(lock, RELEASED).catch(() => {});
  }
}

const RELEASED = 'released';

/**
 * Take the refresh lock and return its file, or null if another refresh holds it.
 *
 * Locks are numbered files (update-check.json.lock.1, .2, ...) and the highest number is the
 * current one. To take the lock, a process creates the next number, which only one process can
 * do, and keeps it only if that is still the highest number afterwards. That stays exclusive
 * even when a holder dies without releasing it, which a single lock file taken over by
 * deleting or renaming it cannot guarantee.
 */
async function acquireLock(path: string): Promise<string | null> {
  const numbers = await lockNumbers(path);
  const newest = numbers.at(-1) ?? 0;

  if (newest && (await isHeld(lockFile(path, newest)))) {
    return null;
  }

  const mine = newest + 1;
  const lock = lockFile(path, mine);

  if (!(await createExclusive(lock, `${process.pid}:${randomUUID()}`))) {
    return null;
  }

  // Someone who looked at the locks before us may have taken a higher number.
  if ((await lockNumbers(path)).at(-1) !== mine) {
    await replaceFile(lock, RELEASED).catch(() => {});

    return null;
  }

  // Older locks can't be the current one any more. Never remove the newest: it carries the count.
  for (const old of numbers) {
    await rm(lockFile(path, old), { force: true });
  }

  return lock;
}

function lockFile(path: string, number: number): string {
  return `${path}.lock.${number}`;
}

async function lockNumbers(path: string): Promise<number[]> {
  const prefix = `${basename(path)}.lock.`;
  const names = await readdir(dirname(path)).catch(() => [] as string[]);

  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)))
    .sort((a, b) => a - b);
}

/** Whether a live process holds this lock: not released, and its owner is still running. */
async function isHeld(lock: string): Promise<boolean> {
  const contents = await readFile(lock, 'utf8').catch(() => RELEASED);
  const pid = Number.parseInt(contents, 10);

  return contents !== RELEASED && Number.isInteger(pid) && pid > 0 && isRunning(pid);
}

/**
 * Create `path` holding `contents`, or return false if it exists. The contents are written to a
 * temporary file first and hard-linked into place, so nobody ever sees a half-written lock.
 * Without hard links (FAT and exFAT drives) this also returns false, so no refresh runs there:
 * an exclusive create would expose the lock before its owner is written into it.
 */
async function createExclusive(path: string, contents: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, contents);
    await link(temporary, path);

    return true;
  } catch {
    return false;
  } finally {
    await rm(temporary, { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
