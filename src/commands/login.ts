import { hostname } from 'node:os';
import { ApiError, fetchMe, type ApiClient } from '../api.ts';
import { DEFAULT_BASE_URL, configPath, normalizeBaseUrl, writeConfig } from '../config.ts';
import { CliError, type Context, type Input } from '../context.ts';
import { clientFor, type GlobalOptions } from '../session.ts';

export interface LoginOptions {
  token?: string;
  withToken?: boolean;
}

export async function readAll(input: Input): Promise<string> {
  let text = '';

  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  return text;
}

interface StartedLogin {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type LoginStatus = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token: string };

const EXPIRED_MESSAGE = 'The login code expired before it was approved. Run "filecafe login" again.';

function isStartedLogin(value: unknown): value is StartedLogin {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const login = value as Record<string, unknown>;

  return (
    typeof login.device_code === 'string' &&
    typeof login.user_code === 'string' &&
    typeof login.verification_uri === 'string' &&
    typeof login.verification_uri_complete === 'string' &&
    typeof login.expires_in === 'number' &&
    typeof login.interval === 'number'
  );
}

/**
 * Ask where the login stands, treating a dropped connection or server hiccup
 * as "still pending" so one bad poll does not end the login.
 */
async function pollLogin(client: ApiClient, deviceCode: string): Promise<LoginStatus> {
  try {
    return await client.request<LoginStatus>('POST', '/api/v1/cli/logins/token', { device_code: deviceCode });
  } catch (error) {
    if (error instanceof ApiError && (error.status === null || error.status >= 500)) {
      return { status: 'pending' };
    }

    throw error;
  }
}

/**
 * Start a login on file.cafe, show its code, and poll until it is approved in
 * the browser. The token only exists once this collects it, and nothing
 * listens on a local port, so it works over SSH too.
 */
async function tokenFromBrowser(context: Context, baseUrl: string): Promise<string> {
  const client = clientFor(context, baseUrl, undefined, (message) => context.stderr.write(`${message}\n`));
  const login = await client.request<unknown>('POST', '/api/v1/cli/logins', { name: hostname() });

  if (!isStartedLogin(login)) {
    throw new CliError(`Unexpected response from ${baseUrl} when starting the login. Check the --url option / FILECAFE_URL.`);
  }

  context.stderr.write(
    `Your one-time code: ${login.user_code}\n\n` +
      `Opening your browser to approve this login. Check that the code there matches.\n` +
      `If it does not open, visit ${login.verification_uri} and enter the code.\n\n` +
      'Waiting for approval...\n',
  );
  context.openBrowser(login.verification_uri_complete);

  const intervalMs = Math.max(login.interval, 1) * 1000;
  const deadline = context.now() + login.expires_in * 1000;

  while (context.now() < deadline) {
    await context.sleep(Math.min(intervalMs, deadline - context.now()));
    const result = await pollLogin(client, login.device_code);

    switch (result.status) {
      case 'approved':
        return result.token;
      case 'denied':
        throw new CliError('Login was cancelled in the browser.');
      case 'expired':
        throw new CliError(EXPIRED_MESSAGE);
    }
  }

  throw new CliError(EXPIRED_MESSAGE);
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
    token = await tokenFromBrowser(context, baseUrl);
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
