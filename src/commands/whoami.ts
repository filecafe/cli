import { fetchMe } from '../api.ts';
import { CliError, type Context } from '../context.ts';
import { requireSession, type GlobalOptions } from '../session.ts';

export interface WhoamiOptions {
  json?: boolean;
}

export async function whoamiCommand(options: WhoamiOptions, globals: GlobalOptions, context: Context): Promise<number> {
  const { client, settings } = await requireSession(context, globals);

  let me;

  try {
    me = await fetchMe(client);
  } catch (error) {
    throw new CliError((error as Error).message);
  }

  if (options.json) {
    context.stdout.write(
      `${JSON.stringify({ name: me.name, email: me.email, url: settings.baseUrl, token_source: settings.tokenSource })}\n`,
    );
  } else {
    context.stdout.write(`Logged in to ${settings.baseUrl} as ${me.name} (${me.email})\n`);

    if (settings.tokenSource === 'env') {
      context.stderr.write('(using FILECAFE_TOKEN)\n');
    }
  }

  return 0;
}
