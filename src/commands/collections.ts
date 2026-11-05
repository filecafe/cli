import { createCollection, listCollections, validateCollectionName } from '../collections.ts';
import { CliError, type Context } from '../context.ts';
import { requireSession, type GlobalOptions } from '../session.ts';
import { colorsFor, styledUrl } from '../terminal.ts';
import { collectionSummary, formatExpiry } from './upload.ts';

export interface CollectionsOptions {
  json?: boolean;
}

/** Tabs and newlines in a name would break the tab-separated output. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Create an empty collection, to upload into later with --collection. */
export async function createCollectionCommand(
  name: string,
  options: CollectionsOptions,
  globals: GlobalOptions,
  context: Context,
): Promise<number> {
  const checked = validateCollectionName(name);

  if ('error' in checked) {
    throw new CliError(checked.error);
  }

  const notice = (message: string) => context.stderr.write(`${message}\n`);
  const { client } = await requireSession(context, globals, notice);
  const collection = await createCollection(client, checked.name);

  if (options.json) {
    context.stdout.write(`${JSON.stringify(collection, null, 2)}\n`);
  } else if (context.stdout.isTTY) {
    context.stdout.write(collectionSummary(collection, styledUrl(context.stdout, context.env, collection.url), colorsFor(context.stdout, context.env)));
    context.stderr.write(
      `${colorsFor(context.stderr, context.env).gray(`Upload into it with: filecafe upload <files...> --collection ${collection.id}`)}\n`,
    );
  } else {
    context.stdout.write(`${collection.id}\t${oneLine(collection.name)}\t${collection.url}\n`);
  }

  return 0;
}

export async function collectionsCommand(options: CollectionsOptions, globals: GlobalOptions, context: Context): Promise<number> {
  const notice = (message: string) => context.stderr.write(`${message}\n`);
  const { client } = await requireSession(context, globals, notice);
  const collections = await listCollections(client);

  if (options.json) {
    context.stdout.write(`${JSON.stringify(collections, null, 2)}\n`);

    return 0;
  }

  const err = colorsFor(context.stderr, context.env);

  if (collections.length === 0) {
    context.stderr.write(
      `No collections yet. ${err.gray('Create one with: filecafe collections create <name>, or filecafe upload <files...> --new-collection <name>')}\n`,
    );

    return 0;
  }

  // People at a terminal get a block per collection; scripts reading a pipe get "id<TAB>name<TAB>url" lines.
  if (!context.stdout.isTTY) {
    for (const collection of collections) {
      context.stdout.write(`${collection.id}\t${oneLine(collection.name)}\t${collection.url}\n`);
    }

    return 0;
  }

  const out = colorsFor(context.stdout, context.env);

  context.stdout.write(
    collections
      .map((collection) => {
        const details = [
          `${collection.files_count} ${collection.files_count === 1 ? 'file' : 'files'}`,
          ...(collection.expires_at ? [`expires ${formatExpiry(collection.expires_at)}`] : []),
          ...(collection.password_protected ? ['password'] : []),
          ...(collection.accepts_uploads ? ['accepts uploads'] : []),
        ];

        return [
          `${out.bold(oneLine(collection.name))} ${out.gray(`(${details.join(', ')})`)}`,
          `  ${out.gray('URL:')} ${styledUrl(context.stdout, context.env, collection.url)}`,
          `  ${out.gray('ID:')}  ${collection.id}`,
        ].join('\n');
      })
      .join('\n\n') + '\n',
  );

  return 0;
}
