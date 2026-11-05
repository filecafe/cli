import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { ApiError } from '../api.ts';
import { createCollection, CollectionIncompleteError, validateCollectionName, type Collection } from '../collections.ts';
import { CliError, type Context } from '../context.ts';
import { guessMimeType } from '../mime.ts';
import { requireSession, type GlobalOptions } from '../session.ts';
import { colorsFor, styledUrl } from '../terminal.ts';
import { uploadFile, type CompletedUpload } from '../upload.ts';

export interface UploadCommandOptions {
  collection?: string;
  /** Name of a collection to create from the uploaded files. */
  newCollection?: string;
  json?: boolean;
  quiet?: boolean;
  /** Parallel part uploads per file. */
  concurrency?: number;
}

export type UploadResult =
  | {
      file: string;
      ok: true;
      id: string;
      filename: string;
      size: number;
      url: string | null;
      password_protected: boolean;
      expires_at?: string | null;
    }
  | { file: string; ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILENAME_LENGTH = 255;

/** The name sent to the server: a basename without slashes or control characters, at most 255 characters. */
export function uploadFilename(path: string): string {
  let name = basename(path).replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim();

  if (!name || name === '.' || name === '..') {
    name = 'file';
  }

  const characters = Array.from(name);

  if (characters.length <= MAX_FILENAME_LENGTH) {
    return name;
  }

  const extension = Array.from(extname(name));
  const keep = extension.length > 0 && extension.length <= 16 ? extension : [];

  return characters.slice(0, MAX_FILENAME_LENGTH - keep.length).join('') + keep.join('');
}

/** "November 7th 2026", in the local time zone. */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const day = date.getDate();
  const suffixes: Partial<Record<Intl.LDMLPluralRule, string>> = { one: 'st', two: 'nd', few: 'rd' };
  const suffix = suffixes[new Intl.PluralRules('en-US', { type: 'ordinal' }).select(day)] ?? 'th';
  const month = date.toLocaleString('en-US', { month: 'long' });

  return `${month} ${day}${suffix} ${date.getFullYear()}`;
}

export function collectionSummary(collection: Collection, url: string, color: ReturnType<typeof colorsFor>): string {
  const files = `${collection.files_count} ${collection.files_count === 1 ? 'file' : 'files'}`;

  return [
    `${color.green('Created collection')} ${color.bold(collection.name)}`,
    `${color.gray('URL:')}     ${url}`,
    `${color.gray('Files:')}   ${files}`,
    `${color.gray('ID:')}      ${collection.id}`,
    '',
  ].join('\n');
}

function summary(
  result: { filename: string; size: number; expires_at?: string | null },
  url: string,
  color: ReturnType<typeof colorsFor>,
): string {
  const lines = [
    `${color.green('Successfully uploaded')} ${color.bold(result.filename)}`,
    `${color.gray('URL:')}     ${url}`,
    `${color.gray('Size:')}    ${formatBytes(result.size)}`,
  ];

  if (result.expires_at !== undefined) {
    lines.push(`${color.gray('Expires:')} ${result.expires_at === null ? 'Never' : formatExpiry(result.expires_at)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

interface ValidFile {
  file: string;
  size: number;
}

async function validateFile(file: string): Promise<ValidFile | { file: string; error: string }> {
  try {
    const stats = await stat(file);

    if (stats.isDirectory()) {
      return { file, error: 'Is a directory. Only regular files can be uploaded.' };
    }

    if (!stats.isFile()) {
      return { file, error: 'Not a regular file.' };
    }

    return { file, size: stats.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      return { file, error: 'No such file.' };
    }

    if (code === 'EACCES' || code === 'EPERM') {
      return { file, error: 'Permission denied.' };
    }

    return { file, error: (error as Error).message };
  }
}

function createProgress(context: Context, enabled: boolean) {
  let active = false;

  return {
    update(line: string) {
      if (!enabled) {
        return;
      }

      active = true;
      context.stderr.write(`\r\u001b[2K${line}`);
    },
    clear() {
      if (enabled && active) {
        context.stderr.write('\r\u001b[2K');
        active = false;
      }
    },
  };
}

export async function uploadCommand(
  files: string[],
  options: UploadCommandOptions,
  globals: GlobalOptions,
  context: Context,
): Promise<number> {
  if (options.collection !== undefined && !UUID_PATTERN.test(options.collection)) {
    throw new CliError(`Invalid --collection "${options.collection}". Expected a collection UUID.`);
  }

  let newCollectionName: string | undefined;

  if (options.newCollection !== undefined) {
    if (options.collection !== undefined) {
      throw new CliError('Use either --collection or --new-collection, not both.');
    }

    const checked = validateCollectionName(options.newCollection);

    if ('error' in checked) {
      throw new CliError(`Invalid --new-collection: ${checked.error}`);
    }

    newCollectionName = checked.name;
  }

  if (files.length === 0) {
    throw new CliError('No files given. Usage: filecafe upload <files...>');
  }

  const showProgress = Boolean(context.stderr.isTTY) && !options.json && !options.quiet;
  // Share URLs on stdout are never colored, so piping or copying them stays clean.
  const err = colorsFor(context.stderr, context.env);
  // People at a terminal get a summary per file; scripts and agents reading a pipe get bare URLs.
  const showSummary = Boolean(context.stdout.isTTY) && !options.quiet;
  const out = colorsFor(context.stdout, context.env);
  let summaries = 0;
  const progress = createProgress(context, showProgress);
  const notice = (message: string) => {
    if (!options.quiet) {
      progress.clear();
      context.stderr.write(`${message}\n`);
    }
  };

  const { client } = await requireSession(context, globals, notice);

  const checked = await Promise.all(files.map(validateFile));
  const invalid = checked.filter((entry): entry is { file: string; error: string } => 'error' in entry);
  const results: UploadResult[] = [];
  let collection: Collection | null = null;
  let collectionError: string | null = null;
  // With --new-collection, scripts reading a pipe get the collection's URL instead of each file's.
  const printFileUrls = newCollectionName === undefined || showSummary;

  if (invalid.length > 0) {
    // Fail fast: nothing is uploaded unless every input is a readable regular file.
    for (const entry of checked) {
      results.push({
        file: entry.file,
        ok: false,
        error: 'error' in entry ? entry.error : 'Skipped because another input file is invalid; nothing was uploaded.',
      });
    }
  } else {
    let fatal: string | null = null;

    for (const { file, size } of checked as ValidFile[]) {
      let result: UploadResult;

      if (fatal !== null) {
        result = { file, ok: false, error: fatal };
      } else {
        const filename = uploadFilename(file);
        progress.update(`Uploading ${err.bold(filename)} (${formatBytes(size)})...`);
        let lastDrawn = -Infinity;

        try {
          const completed: CompletedUpload = await uploadFile({
            client,
            fetch: context.fetch,
            sleep: context.sleep,
            path: file,
            filename,
            size,
            mimeType: guessMimeType(filename),
            collectionId: options.collection,
            concurrency: options.concurrency,
            now: context.now,
            onProgress: (uploaded, total) => {
              // Bytes arrive in small chunks; redraw at most every 100 ms, and always at the end.
              if (uploaded < total && context.now() - lastDrawn < 100) {
                return;
              }

              lastDrawn = context.now();

              if (uploaded > 0 && total > 0) {
                const percent = Math.floor((uploaded / total) * 100);
                progress.update(
                  `Uploading ${err.bold(filename)}  ${err.cyan(`${percent}%`)} (${formatBytes(uploaded)} / ${formatBytes(total)})`,
                );
              }
            },
          });

          result = {
            file,
            ok: true,
            id: completed.id,
            filename: completed.filename,
            size: completed.size,
            url: completed.url ?? null,
            password_protected: Boolean(completed.password_protected),
            ...(completed.expires_at !== undefined && { expires_at: completed.expires_at }),
          };
        } catch (error) {
          result = { file, ok: false, error: error instanceof Error ? error.message : String(error) };

          // A bad token or unverified account will fail every remaining file the same way.
          if (error instanceof ApiError && error.isFatal) {
            fatal = result.error;
          }
        } finally {
          progress.clear();
        }
      }

      results.push(result);

      if (!options.json) {
        if (result.ok && result.url && showSummary) {
          context.stdout.write(`${summaries++ > 0 ? '\n' : ''}${summary(result, styledUrl(context.stdout, context.env, result.url), out)}`);
        } else if (result.ok && result.url) {
          if (printFileUrls) {
            context.stdout.write(`${result.url}\n`);
          }
        } else if (result.ok) {
          context.stderr.write(
            `${err.yellow(`${file}:`)} uploaded (id ${result.id}), but the server returned no share link.\n`,
          );
        } else {
          context.stderr.write(`${err.red(`${file}:`)} ${result.error}\n`);
        }
      }
    }
  }

  if (newCollectionName !== undefined && invalid.length === 0) {
    const uploadedIds = results.flatMap((result) => (result.ok ? [result.id] : []));

    if (uploadedIds.length === 0) {
      collectionError = 'No files were uploaded, so the collection was not created.';
    } else {
      progress.update(`Creating collection ${err.bold(newCollectionName)}...`);

      try {
        collection = await createCollection(client, newCollectionName, uploadedIds);
      } catch (error) {
        if (error instanceof CollectionIncompleteError) {
          collection = error.collection;
        }

        collectionError = error instanceof Error ? error.message : String(error);
      } finally {
        progress.clear();
      }
    }

    if (!options.json) {
      if (collection && showSummary) {
        context.stdout.write(`${summaries > 0 ? '\n' : ''}${collectionSummary(collection, styledUrl(context.stdout, context.env, collection.url), out)}`);
      } else if (collection) {
        context.stdout.write(`${collection.url}\n`);
      }

      if (collectionError !== null) {
        context.stderr.write(`${err.red('Collection:')} ${collectionError}\n`);
      } else if (results.some((result) => !result.ok)) {
        context.stderr.write(`${err.yellow('Collection:')} created without the files that failed to upload.\n`);
      }
    }
  }

  if (options.json && newCollectionName !== undefined) {
    const output = {
      collection,
      ...(collectionError !== null && { collection_error: collectionError }),
      files: results,
    };
    context.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else if (options.json) {
    context.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else if (invalid.length > 0) {
    for (const entry of invalid) {
      context.stderr.write(`${err.red(`${entry.file}:`)} ${entry.error}\n`);
    }

    context.stderr.write(`${err.red('Nothing was uploaded.')}\n`);
  }

  return results.every((result) => result.ok) && collectionError === null ? 0 : 1;
}
