import { CliError, type Context } from '../context.ts';
import { colorsFor } from '../terminal.ts';
import { fetchLatestVersion } from '../update-cache.ts';
import { detectInstaller, isNewer, isNpx } from '../update-check.ts';
import { VERSION } from '../version.ts';

const LATEST_TIMEOUT_MS = 10_000;

/**
 * Upgrade a global install to the latest release with the package manager that installed it.
 * npx runs and installs it can't place get the command to run instead.
 */
export async function upgradeCommand(context: Context): Promise<number> {
  const color = colorsFor(context.stderr, context.env);
  const latest = await fetchLatestVersion(context.fetch, context.userAgent, LATEST_TIMEOUT_MS);

  if (latest && !isNewer(latest, VERSION)) {
    context.stdout.write(`filecafe v${VERSION} is already the latest version.\n`);

    return 0;
  }

  if (isNpx(context)) {
    context.stdout.write(`You are running filecafe with npx, so there is nothing to upgrade. Run: npx filecafe@latest\n`);

    return 0;
  }

  const installer = await detectInstaller(context);

  if (!installer) {
    throw new CliError(
      'Could not tell whether npm, pnpm, Yarn, or Bun installed filecafe. Upgrade it with the package manager ' +
        'that installed it, for example: npm i -g filecafe@latest',
    );
  }

  const [command, ...args] = installer;

  context.stderr.write(latest ? `Upgrading filecafe v${VERSION} → v${latest}\n` : `Upgrading filecafe v${VERSION}\n`);
  context.stderr.write(`${color.gray(`> ${installer.join(' ')}`)}\n`);

  if ((await context.run(command!, args)) !== 0) {
    throw new CliError(`The upgrade failed. Run it yourself: ${installer.join(' ')}`);
  }

  context.stdout.write(latest ? `Upgraded filecafe to v${latest}.\n` : 'Upgraded filecafe to the latest version.\n');

  return 0;
}
