import { hostname } from 'node:os';
import { fetchMe } from '../api.ts';
import { DEFAULT_BASE_URL, configPath, normalizeBaseUrl, writeConfig } from '../config.ts';
import { CliError, type Context, type Input } from '../context.ts';
import { generateState, startCallbackServer, LOGIN_TIMEOUT_MS } from '../login-server.ts';
import { clientFor, type GlobalOptions } from '../session.ts';

export interface LoginOptions {
  token?: string;
  withToken?: boolean;
  /** Override for tests. */
  timeoutMs?: number;
}

export async function readAll(input: Input): Promise<string> {
  let text = '';

  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  return text;
}

export function authorizeUrl(baseUrl: string, port: number, state: string, name: string): string {
  return `${baseUrl}/cli/authorize?port=${port}&state=${state}&name=${encodeURIComponent(name)}`;
}

async function tokenFromBrowser(context: Context, baseUrl: string, timeoutMs: number): Promise<string> {
  const state = generateState();
  const server = await startCallbackServer(state, timeoutMs);
  const url = authorizeUrl(baseUrl, server.port, state, hostname());

  context.stderr.write(`Opening your browser to log in to ${baseUrl}.\n`);
  context.stderr.write(`If it does not open, visit this URL on this machine:\n\n  ${url}\n\nWaiting for approval...\n`);
  context.openBrowser(url);

  const result = await server.result;

  if ('error' in result) {
    throw new CliError(
      result.error === 'access_denied'
        ? 'Login was cancelled in the browser.'
        : `Login failed in the browser (${result.error}).`,
    );
  }

  return result.token;
}

export async function loginCommand(options: LoginOptions, globals: GlobalOptions, context: Context): Promise<number> {
  if (options.token !== undefined && options.withToken) {
    throw new CliError('Use either --token <token> or --with-token, not both.');
  }

  let baseUrl: string;

  try {
    baseUrl = normalizeBaseUrl(globals.url || context.env.FILECAFE_URL || DEFAULT_BASE_URL);
  } catch (error) {
    throw new CliError((error as Error).message);
  }

  let token: string;

  if (options.token !== undefined) {
    token = options.token.trim();
  } else if (options.withToken) {
    if (context.stdin.isTTY) {
      throw new CliError('--with-token reads the token from standard input, e.g.: echo "$TOKEN" | filecafe login --with-token');
    }

    token = (await readAll(context.stdin)).trim();
  } else {
    token = await tokenFromBrowser(context, baseUrl, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  }

  if (!token || /\s/.test(token)) {
    throw new CliError('The token is empty or malformed.');
  }

  let me;

  try {
    me = await fetchMe(clientFor(context, baseUrl, token));
  } catch (error) {
    if ((error as { status?: unknown }).status === 401) {
      throw new CliError(`That token was rejected by ${baseUrl}. Check that it is correct and has not been revoked.`);
    }

    throw new CliError((error as Error).message);
  }

  await writeConfig(context, { url: baseUrl, token });

  context.stdout.write(`Logged in as ${me.name} (${me.email})\n`);
  context.stderr.write(`Saved credentials for ${baseUrl} to ${configPath(context)}\n`);

  if (context.env.FILECAFE_TOKEN?.trim()) {
    context.stderr.write('Note: FILECAFE_TOKEN is set in your environment and takes precedence over the saved login.\n');
  }

  return 0;
}
