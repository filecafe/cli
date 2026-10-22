import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export type LoginResult = { token: string } | { error: string };

export interface CallbackResponse {
  status: number;
  body: string;
  /** Present when this request concludes the login (successfully or not). */
  result?: LoginResult;
}

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function generateState(): string {
  return randomBytes(16).toString('hex');
}

export function statesMatch(received: string | null, expected: string): boolean {
  if (received === null) {
    return false;
  }

  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#faf9f7;color:#1c1917}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#57534e}</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>
`;
}

const SUCCESS_PAGE = page("You're logged in to file.cafe.", 'You can close this tab and return to your terminal.');
const DENIED_PAGE = page('Login cancelled.', 'The file.cafe CLI was not authorized. You can close this tab.');
const FAILED_PAGE = page('Login failed.', 'Something went wrong. Return to your terminal and run "filecafe login" again.');
const INVALID_PAGE = page(
  'Invalid login request.',
  'This link does not match the login started in your terminal. Run "filecafe login" again.',
);

/**
 * Decide how to answer a request to the local callback server. Only
 * `GET /callback` with the expected `state` concludes the login; anything
 * else is rejected and the server keeps waiting.
 */
export function handleCallbackRequest(
  method: string | undefined,
  rawUrl: string | undefined,
  expectedState: string,
): CallbackResponse {
  const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');

  if (method !== 'GET' || url.pathname !== '/callback') {
    return { status: 404, body: page('Not found.', 'Nothing to see here.') };
  }

  if (!statesMatch(url.searchParams.get('state'), expectedState)) {
    return { status: 400, body: INVALID_PAGE };
  }

  const error = url.searchParams.get('error');

  if (error) {
    return {
      status: 200,
      body: error === 'access_denied' ? DENIED_PAGE : FAILED_PAGE,
      result: { error },
    };
  }

  const token = url.searchParams.get('token');

  if (!token) {
    return { status: 400, body: FAILED_PAGE };
  }

  return { status: 200, body: SUCCESS_PAGE, result: { token } };
}

export interface CallbackServer {
  port: number;
  result: Promise<LoginResult>;
  close(): void;
}

/** Listen on a random loopback port for the browser redirect. */
export function startCallbackServer(state: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<CallbackServer> {
  let settle: (result: LoginResult) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let settled = false;
  const result = new Promise<LoginResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer((request, response) => {
    const outcome = handleCallbackRequest(request.method, request.url, state);

    response.writeHead(outcome.status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
    });
    response.end(outcome.body);

    if (outcome.result && !settled) {
      const loginResult = outcome.result;
      response.on('finish', () => finish(() => settle(loginResult)));
    }
  });

  let timer: NodeJS.Timeout | undefined;

  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };

  const finish = (callback: () => void) => {
    if (settled) {
      return;
    }

    settled = true;
    close();
    callback();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        close();
        reject(new Error('Could not start the local login server.'));

        return;
      }

      timer = setTimeout(
        () =>
          finish(() =>
            fail(
              new Error(
                'Timed out waiting for the browser login (5 minutes). Run "filecafe login" again, or use "filecafe login --token <token>".',
              ),
            ),
          ),
        timeoutMs,
      );

      resolve({ port: address.port, result, close: () => finish(() => fail(new Error('Login cancelled.'))) });
    });
  });
}
