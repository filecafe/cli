import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
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
  /** Run a command attached to the terminal and resolve with its exit code. */
  run: (command: string, args: string[]) => Promise<number | null>;
  /** Where the running CLI is installed, with symlinks resolved. */
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

function run(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    // npm, pnpm and yarn are .cmd scripts on Windows, which only run through a shell.
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });

    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
}

function currentScriptPath(): string {
  try {
    return realpathSync(process.argv[1] ?? '');
  } catch {
    return process.argv[1] ?? '';
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
    scriptPath: currentScriptPath(),
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
