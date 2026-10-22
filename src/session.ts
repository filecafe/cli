import { createApiClient, type ApiClient } from './api.ts';
import { resolveSettings, type ResolvedSettings } from './config.ts';
import { CliError, type Context } from './context.ts';

export const NOT_LOGGED_IN = 'Not logged in. Run "filecafe login" or set FILECAFE_TOKEN.';

export interface GlobalOptions {
  url?: string;
}

export function clientFor(
  context: Context,
  baseUrl: string,
  token: string,
  onNotice?: (message: string) => void,
): ApiClient {
  return createApiClient({
    baseUrl,
    token,
    fetch: context.fetch,
    sleep: context.sleep,
    userAgent: context.userAgent,
    onNotice,
  });
}

/** Resolve the base URL and token, failing with a helpful message when not logged in. */
export async function requireSession(
  context: Context,
  globals: GlobalOptions,
  onNotice?: (message: string) => void,
): Promise<{ client: ApiClient; settings: ResolvedSettings & { token: string } }> {
  let settings: ResolvedSettings;

  try {
    settings = await resolveSettings(context, globals.url);
  } catch (error) {
    throw new CliError((error as Error).message);
  }

  const { token } = settings;

  if (!token) {
    if (settings.saved && settings.saved.url !== settings.baseUrl) {
      throw new CliError(
        `Not logged in to ${settings.baseUrl} (the saved login is for ${settings.saved.url}). ` +
          `Run "filecafe login --url ${settings.baseUrl}" or set FILECAFE_TOKEN.`,
      );
    }

    throw new CliError(NOT_LOGGED_IN);
  }

  return { client: clientFor(context, settings.baseUrl, token, onNotice), settings: { ...settings, token } };
}
