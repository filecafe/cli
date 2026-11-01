#!/usr/bin/env node
import { Command } from 'commander';
import { ApiError } from './api.ts';
import { loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { uploadCommand } from './commands/upload.ts';
import { whoamiCommand } from './commands/whoami.ts';
import { CliError, createDefaultContext, type Context } from './context.ts';
import type { GlobalOptions } from './session.ts';
import { colorsFor } from './terminal.ts';
import { startUpdateCheck } from './update-check.ts';
import { VERSION } from './version.ts';

const MAIN_EXAMPLES = `
Examples:
  $ filecafe login                          # log in via your browser (one time)
  $ filecafe upload report.pdf              # shows the share URL, size and expiry date
  $ filecafe upload a.png b.mp4 --json      # machine-readable results (for scripts and AI agents)
  $ filecafe upload ./build.zip | pbcopy    # copy the share URL to the clipboard
  $ FILECAFE_TOKEN=... npx filecafe upload notes.txt --json   # CI / headless

Environment:
  FILECAFE_TOKEN   API token; takes precedence over the saved login
  FILECAFE_URL     Site URL (default: https://file.cafe)
  FILECAFE_NO_UPDATE_CHECK   Set to turn off the new-version check (NO_UPDATE_NOTIFIER works too)

Exit codes: 0 on success, 1 on any failure. Errors and progress go to stderr.
`;

const UPLOAD_EXAMPLES = `
Output:
  Terminal: a summary per file (share URL, size, expiry date).
  Piped or --quiet: one share URL per line on stdout, in the order the files were given.
  --json:  a JSON array on stdout with one object per input file:
             {"file": "a.png", "ok": true, "id": "...", "filename": "a.png", "size": 1234,
              "url": "https://file.cafe/...", "password_protected": false, "expires_at": "2026-11-07T12:00:00+00:00"}
             {"file": "b.png", "ok": false, "error": "No such file."}
  Exit code is 0 if every file uploaded, 1 if any failed.

Examples:
  $ filecafe upload screenshot.png
  $ filecafe upload report.pdf data.csv --json
  $ filecafe upload video.mp4 --collection 0b6f9a2e-3c1d-4f7a-9e5b-2d8c4a1f6e3b
  $ filecafe upload build.zip --quiet | pbcopy
  $ FILECAFE_TOKEN=... filecafe upload logs.txt --json   # no saved login needed
`;

const LOGIN_EXAMPLES = `
Examples:
  $ filecafe login                                   # opens your browser to approve this device
  $ echo "$FILECAFE_TOKEN" | filecafe login --with-token
  $ filecafe login --url http://file-cafe.test       # log in to another file.cafe server

In CI you can skip login entirely and set FILECAFE_TOKEN instead.
`;

async function execute(context: Context, action: () => Promise<number>, { quiet = false } = {}): Promise<void> {
  const printUpdateNotice = quiet ? async () => {} : startUpdateCheck(context);

  try {
    process.exitCode = await action();
  } catch (error) {
    const expected = error instanceof CliError || error instanceof ApiError;
    const label = expected ? 'Error:' : 'Unexpected error:';
    const message = error instanceof Error ? error.message : String(error);

    context.stderr.write(`${colorsFor(context.stderr, context.env).red(label)} ${message}\n`);

    if (context.env.FILECAFE_DEBUG && error instanceof Error && error.stack) {
      context.stderr.write(`${error.stack}\n`);
    }

    process.exitCode = 1;
  }

  await printUpdateNotice();
}

export function createProgram(context: Context): Command {
  const program = new Command();

  program
    .name('filecafe')
    .description('Upload files to file.cafe and get share links. Designed for AI coding agents, humans, and CI.')
    .version(VERSION, '-v, --version', 'print the version')
    .option('--url <url>', 'file.cafe site URL (env: FILECAFE_URL, default: https://file.cafe)')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError('(run "filecafe --help" for usage and examples)')
    .addHelpText('after', MAIN_EXAMPLES);

  const globals = (command: Command): GlobalOptions => command.optsWithGlobals<GlobalOptions>();

  program
    .command('login')
    .description('Log in via your browser, or save an existing API token')
    .option('--token <token>', 'save this API token instead of opening a browser (visible in shell history; prefer --with-token)')
    .option('--with-token', 'read the API token from standard input')
    .addHelpText('after', LOGIN_EXAMPLES)
    .action((options: { token?: string; withToken?: boolean }, command: Command) =>
      execute(context, () => loginCommand(options, globals(command), context)),
    );

  program
    .command('logout')
    .description('Revoke the saved login token on file.cafe and delete it from this machine (does not affect FILECAFE_TOKEN)')
    .addHelpText(
      'after',
      '\nThe token is revoked even if it was saved with "filecafe login --token", so don\'t log out\n' +
        'with a token that CI or another machine still uses.\n',
    )
    .action(() => execute(context, () => logoutCommand(context)));

  program
    .command('whoami')
    .description('Show the account you are logged in as')
    .option('--json', 'print {"name","email","url","token_source"} as JSON')
    .addHelpText('after', '\nExamples:\n  $ filecafe whoami\n  $ filecafe whoami --json\n')
    .action((options: { json?: boolean }, command: Command) =>
      execute(context, () => whoamiCommand(options, globals(command), context)),
    );

  program
    .command('upload')
    .description('Upload one or more files and print their share URLs')
    .argument('<files...>', 'files to upload (uploaded one after another)')
    .option('--collection <uuid>', 'add the files to this collection')
    .option('--json', 'print a JSON array of per-file results on stdout')
    .option('-q, --quiet', 'no progress or notices on stderr (errors are still printed)')
    .addHelpText('after', UPLOAD_EXAMPLES)
    .action((files: string[], options: { collection?: string; json?: boolean; quiet?: boolean }, command: Command) =>
      execute(context, () => uploadCommand(files, options, globals(command), context), { quiet: options.quiet }),
    );

  return program;
}

await createProgram(createDefaultContext()).parseAsync(process.argv);
