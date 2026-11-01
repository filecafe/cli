# filecafe

Upload files to [file.cafe](https://file.cafe) from the command line and get share links back.

Built for AI coding agents (Claude Code, Codex, Cursor), humans, and CI: share URLs go to stdout, progress and errors go to stderr, `--json` gives machine-readable results, and nothing ever prompts (except the one-time browser login, and an upgrade offer when you run it yourself in a terminal).

## Install

Run it without installing:

```sh
npx filecafe upload report.pdf
```

Or install it globally:

```sh
npm i -g filecafe
filecafe --help
```

Requires Node.js 20 or newer.

When you run filecafe in a terminal and a new version is out, it tells you and offers to upgrade it with the package manager you installed it with. It checks npm in the background once a day (retrying on the next run if npm can't be reached), mentions an update at most every three days, and never shows this in CI or when its output is piped (scripts and AI agents). Set `FILECAFE_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to turn it off.

## Log in

```sh
filecafe login
```

This shows a one-time code and opens your browser so you can approve the CLI on file.cafe; check that the code on the page matches the one in your terminal. It works over SSH too: if no browser opens, visit the printed URL on any device and enter the code. The token is saved to `~/.config/filecafe/config.json` (or `$XDG_CONFIG_HOME/filecafe/config.json`; `%APPDATA%\filecafe\config.json` on Windows) with owner-only permissions.

Headless machines and CI can use an existing token instead:

```sh
echo "$FILECAFE_TOKEN" | filecafe login --with-token   # validate and save
# ...or skip saving entirely and just set FILECAFE_TOKEN for each run
```

Other account commands:

```sh
filecafe whoami          # Logged in to https://file.cafe as Ada (ada@example.com)
filecafe whoami --json   # {"name":"Ada","email":"ada@example.com","url":"https://file.cafe","token_source":"config"}
filecafe logout          # revoke the saved token on file.cafe and delete it locally
```

Saved logins never expire. They last until you run `filecafe logout` or revoke the token in
Settings → API tokens on file.cafe. `logout` revokes the token even if you saved it with
`filecafe login --token`, so don't log out with a token that CI or another machine still uses.

## Upload

```sh
filecafe upload screenshot.png                 # shows the share URL, size and expiry date
filecafe upload a.png b.mp4 notes.txt          # one summary per file, in order
filecafe upload build.zip | pbcopy             # piped: just the link, copied to the clipboard
filecafe upload video.mp4 --collection <uuid>  # add to a collection
filecafe upload report.pdf --json              # machine-readable output
filecafe upload big.mov --quiet                # no progress output
```

In a terminal each upload ends with a summary:

```
Successfully uploaded screenshot.png
URL:     https://file.cafe/9e54VITGmPY.png
Size:    1.2 MB
Expires: November 7th 2026
```

When the output is piped (scripts, CI, AI agents) or with `--quiet`, stdout is just the share URLs, one per line.

Files are uploaded one after another; large files (over 64 MiB) are split into parts that upload in parallel. Every input is checked before anything is uploaded: if any path is missing or is not a regular file, nothing is uploaded.

### `--json` output

A single JSON array on stdout with one object per input file, in the order given:

```json
[
  {
    "file": "report.pdf",
    "ok": true,
    "id": "9d3c3f8e-5a8b-4c1e-9f0a-2b7d6e4c1a90",
    "filename": "report.pdf",
    "size": 482113,
    "url": "https://file.cafe/...",
    "password_protected": false,
    "expires_at": "2026-11-07T12:00:00+00:00"
  },
  {
    "file": "missing.png",
    "ok": false,
    "error": "No such file."
  }
]
```

`expires_at` is `null` for files that never expire.

The exit code is `0` if every file uploaded and `1` if any failed.

## Configuration

| Setting | How to set | Default |
| --- | --- | --- |
| Site URL | `--url <url>`, then `FILECAFE_URL`, then the URL you logged in to | `https://file.cafe` |
| API token | `FILECAFE_TOKEN`, then the token saved by `filecafe login` | none |

A saved token is only ever sent to the site it was issued for. To work against another server (for example a local development site), log in to it explicitly: `filecafe login --url http://file-cafe.test`.

Set `FILECAFE_DEBUG=1` to print stack traces for unexpected errors.

Output is only colored in a terminal, never when piped. Set `NO_COLOR=1` to turn colors off, or `FORCE_COLOR=1` to keep them when piping.

## Using file.cafe with AI agents

Paste this into your project's `CLAUDE.md`, `AGENTS.md`, or Cursor rules:

```markdown
## Sharing files

To share a file with the user (screenshots, build artifacts, logs, exports), run:

    npx -y filecafe upload <path> --json

and give the user the `url` from the JSON output. Upload several files at once by passing
multiple paths. If the command fails with "Not logged in", ask the user to run
`npx filecafe login` (or set `FILECAFE_TOKEN`) and then try again.
```

Agents can run `filecafe --help` and `filecafe upload --help` to see every option with examples.

## Development

```sh
npm install
npm run typecheck
npm test          # node:test, runs the TypeScript sources directly (Node 24)
npm run build     # bundles to dist/cli.js with tsdown
node dist/cli.js --help
npm run dev -- --url http://file-cafe.test whoami   # run from source
```

Releases are published to npm from GitHub Actions when a `v*` tag is pushed (npm trusted publishing with provenance). Bump `version` in `package.json` to match the tag first.
