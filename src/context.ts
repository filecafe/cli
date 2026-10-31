import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './api.ts';
import type { ConfigEnvironment } from './config.ts';
import { VERSION } from './version.ts';

export interface Output {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface Input extends AsyncIterable<string | Buffer> {
  isTTY?: boolean;
}

/** Everything a command touches in the outside world, so tests can substitute it. */
export interface Context extends ConfigEnvironment {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  stdout: Output;
  stderr: Output;
  stdin: Input;
  openBrowser: (url: string) => void;
  /** Ask a yes/no question on the terminal; an empty answer means yes. */
  confirm: (question: string) => Promise<boolean>;
  /** Run a command attached to the terminal, outside any project, and resolve with its exit code. */
  run: (command: string, args: string[]) => Promise<number | null>;
  /** Run a command outside any project and resolve with its stdout, or null if it fails or is aborted. */
  capture: (command: string, args: string[], signal?: AbortSignal) => Promise<string | null>;
  /** Resolve symlinks, or null if the path does not exist. */
  realpath: (path: string) => Promise<string | null>;
  /** Start a detached process that refreshes the update cache at `cachePath`. */
  refreshInBackground: (cachePath: string) => void;
  /** The script that started the CLI (process.argv[1]). */
  scriptPath: string;
  userAgent: string;
}

/** Open a URL in the default browser without ever throwing. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const [command, args, extra] =
      platform === 'darwin'
        ? ['open', [url], {}]
        : platform === 'win32'
          ? // `start` is a cmd builtin; escape & so cmd does not split the URL.
            ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { windowsVerbatimArguments: true }]
          : ['xdg-open', [url], {}];

    const child = spawn(command, args, { stdio: 'ignore', detached: true, ...extra });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed as well, so a failure to launch a browser is not fatal.
  }
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const cancel = new AbortController();

  // Ctrl+C or Ctrl+D counts as no.
  prompt.once('SIGINT', () => cancel.abort());
  prompt.once('close', () => cancel.abort());

  try {
    const answer = await prompt.question(question, { signal: cancel.signal });

    return /^(y|yes)?$/i.test(answer.trim());
  } catch {
    process.stderr.write('\n');

    return false;
  } finally {
    prompt.close();
  }
}

// Package managers run from the temp folder so the current project's .npmrc, packageManager
// field, or local binaries can't change which install they look at or touch.
const packageManagerOptions = {
  cwd: tmpdir(),
  // npm, pnpm and yarn are .cmd scripts on Windows, which only run through a shell.
  shell: process.platform === 'win32',
  windowsHide: true,
};

function run(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...packageManagerOptions, stdio: 'inherit' });

    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
}

function capture(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    // Short, and SIGKILL so a wedged package manager can't keep the CLI from exiting.
    const options = { ...packageManagerOptions, encoding: 'utf8' as const, timeout: 3000, killSignal: 'SIGKILL' as const, signal };

    execFile(command, args, options, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** Spawn update-worker next to this file: dist/update-worker.js when built, src/update-worker.ts in development. */
function refreshInBackground(cachePath: string): void {
  try {
    const here = fileURLToPath(import.meta.url);
    const worker = fileURLToPath(new URL(`./update-worker${extname(here)}`, import.meta.url));
    const child = spawn(process.execPath, [worker, cachePath], { detached: true, stdio: 'ignore', windowsHide: true });

    child.on('error', () => {});
    child.unref();
  } catch {
    // The next run tries again.
  }
}

export function createDefaultContext(): Context {
  return {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    openBrowser: (url) => openBrowser(url),
    confirm,
    run,
    capture,
    realpath: (path) => realpath(path).catch(() => null),
    refreshInBackground,
    scriptPath: process.argv[1] ?? '',
    userAgent: `filecafe-cli/${VERSION} node/${process.versions.node} (${process.platform})`,
  };
}

/** Thrown for expected failures; the message is printed as-is and the process exits with code 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
