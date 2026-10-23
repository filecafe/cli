import { ApiError } from '../api.ts';
import { configPath, deleteConfig, readConfig } from '../config.ts';
import type { Context } from '../context.ts';
import { clientFor } from '../session.ts';

export async function logoutCommand(context: Context): Promise<number> {
  const saved = await readConfig(context).catch(() => null);

  if (saved) {
    try {
      await clientFor(context, saved.url, saved.token).request<void>('DELETE', '/api/v1/token', undefined, {
        idempotent: true,
      });
    } catch (error) {
      // A 401 means the token was already revoked, which is the outcome we wanted.
      if (!(error instanceof ApiError && error.status === 401)) {
        context.stderr.write(
          `Could not revoke the token on ${saved.url}: ${(error as Error).message}\n` +
            `It may still be active; revoke it in Settings → API tokens.\n`,
        );
      }
    }
  }

  const removed = await deleteConfig(context);

  if (removed) {
    context.stdout.write(saved ? `Logged out of ${saved.url}.\n` : 'Logged out.\n');
    context.stderr.write(`Removed ${configPath(context)}\n`);
  } else {
    context.stdout.write('Not logged in; nothing to do.\n');
  }

  if (context.env.FILECAFE_TOKEN?.trim()) {
    context.stderr.write('Note: FILECAFE_TOKEN is still set in your environment; unset it to stop using that token.\n');
  }

  return 0;
}
