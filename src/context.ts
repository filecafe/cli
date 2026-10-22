import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
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
  stdout: Output;
  stderr: Output;
  stdin: Input;
  openBrowser: (url: string) => void;
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

export function createDefaultContext(): Context {
  return {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => delay(ms),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    openBrowser: (url) => openBrowser(url),
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
