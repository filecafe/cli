import { ApiError } from '../api.ts';
import { configPath, deleteConfig, readConfig } from '../config.ts';
import type { Context } from '../context.ts';
import { clientFor } from '../session.ts';
import { colorsFor } from '../terminal.ts';

export async function logoutCommand(context: Context): Promise<number> {
  const saved = await readConfig(context).catch(() => null);
  const out = colorsFor(context.stdout, context.env);
  const err = colorsFor(context.stderr, context.env);

  if (saved) {
    try {
      await clientFor(context, saved.url, saved.token).request<void>('DELETE', '/api/v1/token', undefined, {
        idempotent: true,
      });
    } catch (error) {
      // A 401 means the token was already revoked, which is the outcome we wanted.
      if (!(error instanceof ApiError && error.status === 401)) {
        context.stderr.write(
          `${err.yellow('Could not revoke the token')} on ${saved.url}: ${(error as Error).message}\n` +
            `It may still be active; revoke it in Settings → API tokens.\n`,
        );
      }
    }
  }

  const removed = await deleteConfig(context);

  if (removed) {
    context.stdout.write(saved ? `${out.green('Logged out')} of ${saved.url}.\n` : `${out.green('Logged out')}.\n`);
    context.stderr.write(`${err.gray(`Removed ${configPath(context)}`)}\n`);
  } else {
    context.stdout.write('Not logged in; nothing to do.\n');
  }

  if (context.env.FILECAFE_TOKEN?.trim()) {
    context.stderr.write(
      `${err.yellow('Note:')} FILECAFE_TOKEN is still set in your environment; unset it to stop using that token.\n`,
    );
  }

  return 0;
}
