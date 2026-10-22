import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { ApiError } from '../api.ts';
import { CliError, type Context } from '../context.ts';
import { guessMimeType } from '../mime.ts';
import { requireSession, type GlobalOptions } from '../session.ts';
import { uploadFile, type CompletedUpload } from '../upload.ts';

export interface UploadCommandOptions {
  collection?: string;
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

  if (files.length === 0) {
    throw new CliError('No files given. Usage: filecafe upload <files...>');
  }

  const showProgress = Boolean(context.stderr.isTTY) && !options.json && !options.quiet;
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
        progress.update(`Uploading ${filename} (${formatBytes(size)})...`);

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
            onNotice: notice,
            onProgress: (uploaded, total) => {
              if (uploaded > 0 && total > 0) {
                const percent = Math.floor((uploaded / total) * 100);
                progress.update(`Uploading ${filename}  ${percent}% (${formatBytes(uploaded)} / ${formatBytes(total)})`);
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
        if (result.ok && result.url) {
          context.stdout.write(`${result.url}\n`);
        } else if (result.ok) {
          context.stderr.write(`${file}: uploaded (id ${result.id}), but the server returned no share link.\n`);
        } else {
          context.stderr.write(`${file}: ${result.error}\n`);
        }
      }
    }
  }

  if (options.json) {
    context.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else if (invalid.length > 0) {
    for (const entry of invalid) {
      context.stderr.write(`${entry.file}: ${entry.error}\n`);
    }

    context.stderr.write('Nothing was uploaded.\n');
  }

  return results.every((result) => result.ok) ? 0 : 1;
}
