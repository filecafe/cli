# filecafe

Upload files to [file.cafe](https://file.cafe) from the command line and get share links back, or group them into a collection that shares them all on one page.

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
filecafe upload video.mp4 --collection <uuid>  # add to an existing collection
filecafe upload *.png --new-collection "Shots" # share them all on one collection page
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

`expires_at` is `null` for files that never expire. With `--new-collection` the output is an object instead; see [Collections](#collections).

The exit code is `0` if every file uploaded and `1` if any failed.

## Collections

A collection shares several files on one page, with one link (`https://file.cafe/c/...`). Each
file in it keeps its own share link too.

```sh
filecafe upload shots/*.png --new-collection "Launch screenshots"  # upload files into a new collection
filecafe collections create "Inbox"                                # make an empty collection
filecafe upload extra.png --collection <id>                        # add files to an existing one
filecafe collections                                               # list your collections and their IDs
```

Collection names can be up to 120 characters. Collections made from the CLI never expire, have no
password, and don't accept files from visitors. You can add a password or let visitors send files
(paid plans) from the collection's page on your file.cafe dashboard. A collection holds up to
10,000 files.

### Upload files into a new collection

```sh
filecafe upload shots/*.png --new-collection "Launch screenshots"
```

The files upload first, then one collection is created holding the ones that uploaded, in the order
you passed them. Any number of files works: the CLI adds them to the collection 100 at a time. In a
terminal you get the usual summary per file, followed by:

```
Created collection Launch screenshots
URL:     https://file.cafe/c/b7kfVweVXQM
Files:   12 files
ID:      01a1a9ea-a04d-70da-8786-d74d331a9720
```

When piped or with `--quiet`, stdout is just the collection's URL, so
`filecafe upload *.png --new-collection "Shots" | pbcopy` copies the one link to share.

If some files fail to upload, the collection is still created from the rest and the command exits
with `1`. If no file uploads, no collection is created. `--new-collection` can't be combined with
`--collection`.

With `--json` the output is an object instead of an array:

```json
{
  "collection": {
    "id": "01a1a9ea-a04d-70da-8786-d74d331a9720",
    "name": "Launch screenshots",
    "url": "https://file.cafe/c/b7kfVweVXQM",
    "files_count": 12,
    "password_protected": false,
    "accepts_uploads": false,
    "created_at": "2026-11-05T04:14:48+00:00",
    "expires_at": null
  },
  "files": [ /* one object per input file, as in the upload --json output */ ]
}
```

`collection` is `null` when no file uploaded or the collection couldn't be created, and a
`collection_error` field then says why. Files that uploaded keep their share links either way.

### Create an empty collection

```sh
filecafe collections create "Inbox"
```

In a terminal this prints the new collection's URL and ID, and the command to upload into it.
When piped it prints one `id<TAB>name<TAB>url` line, so a script can create a collection and upload
into it straight away:

```sh
id=$(filecafe collections create "Nightly builds" | cut -f1)
filecafe upload build.zip --collection "$id"
```

Add `--json` to print the collection object (the same fields as above) instead.

### Add files to an existing collection

```sh
filecafe upload video.mp4 notes.txt --collection 01a1a9ea-a04d-70da-8786-d74d331a9720
```

Pass the ID of one of your own collections. Files are added to the end of it. Get the ID from
`filecafe collections`, from `collections create`, or from the collection's address on your
dashboard.

### List your collections

```sh
filecafe collections          # same as: filecafe collections list
filecafe collections --json
```

Collections are listed newest first. In a terminal:

```
Launch screenshots (12 files)
  URL: https://file.cafe/c/b7kfVweVXQM
  ID:  01a1a9ea-a04d-70da-8786-d74d331a9720

Client review (3 files, expires November 21st 2026, password)
  URL: https://file.cafe/c/gChBn26axib
  ID:  01a1a9ea-9c07-7226-8553-97ac44eb759c
```

When piped there's one `id<TAB>name<TAB>url` line per collection, and `--json` prints an array of
collection objects.

### Collection fields

| Field | Meaning |
| --- | --- |
| `id` | The collection's ID, for `upload --collection` |
| `name` | Its name |
| `url` | The link that shares the whole collection |
| `files_count` | Files currently in it (expired and deleted files don't count) |
| `password_protected` | Whether the collection page needs a password |
| `accepts_uploads` | Whether visitors can send files to it (set on file.cafe) |
| `created_at` | When it was created (ISO 8601) |
| `expires_at` | When its link stops working (ISO 8601), or `null` if it never expires |

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
multiple paths. To share several files on one page, add `--new-collection "<name>"` and give
the user `collection.url` instead. If the command fails with "Not logged in", ask the user to run
`npx filecafe login` (or set `FILECAFE_TOKEN`) and then try again.
```

Agents can run `filecafe --help`, `filecafe upload --help` and `filecafe collections --help` to see every option with examples.

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
