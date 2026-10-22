import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '../src/context.ts';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit['body'];
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch replacement that records every call and answers with `handler`. */
export function mockFetch(handler: Handler) {
  const calls: RecordedCall[] = [];

  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });

    const call: RecordedCall = {
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    };
    calls.push(call);

    return handler(call);
  };

  return { fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function receiptResponse(receipt: string | null): Response {
  return new Response(null, { status: 204, headers: receipt === null ? {} : { 'X-Upload-Receipt': receipt } });
}

export function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain' } });
}

export async function bodyText(body: RequestInit['body']): Promise<string> {
  if (body instanceof Blob) {
    return body.text();
  }

  return typeof body === 'string' ? body : '';
}

export async function bodyJson(body: RequestInit['body']): Promise<unknown> {
  return JSON.parse(await bodyText(body));
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'filecafe-test-'));
}

export async function tempFile(name: string, contents: string): Promise<string> {
  const path = join(await tempDir(), name);
  await writeFile(path, contents);

  return path;
}

export function createSleep() {
  const waits: number[] = [];

  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

export interface TestContext {
  context: Context;
  stdout: () => string;
  stderr: () => string;
  waits: number[];
}

export async function createTestContext(
  fetch: Context['fetch'],
  overrides: Partial<Context> = {},
): Promise<TestContext> {
  let out = '';
  let err = '';
  const { sleep, waits } = createSleep();

  const context: Context = {
    env: {},
    platform: 'linux',
    homedir: await tempDir(),
    fetch,
    sleep,
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    stdin: { isTTY: true, async *[Symbol.asyncIterator]() {} },
    openBrowser: () => {},
    userAgent: 'filecafe-cli/test',
    ...overrides,
  };

  return { context, stdout: () => out, stderr: () => err, waits };
}

export const BASE = 'https://file.cafe';
