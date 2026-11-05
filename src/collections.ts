import { ApiError, type ApiClient } from './api.ts';

export interface Collection {
  id: string;
  name: string;
  url: string;
  files_count: number;
  password_protected: boolean;
  accepts_uploads: boolean;
  created_at: string | null;
  /** ISO 8601; null when the share link never expires. */
  expires_at: string | null;
}

/** The server's limit on a collection name, in characters. */
export const MAX_COLLECTION_NAME_LENGTH = 120;

/** Files sent per request: the server takes up to 100 when creating a collection or adding to one. */
export const FILES_PER_REQUEST = 100;

/** Collections the server returns per page of GET /api/v1/collections. */
const COLLECTIONS_PER_PAGE = 100;

/** Stop paging after this many pages, in case a server never returns a short page. */
const MAX_PAGES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCollection(value: unknown, what: string): Collection {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.url !== 'string') {
    throw new ApiError(`Unexpected response when ${what}.`, null);
  }

  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    url: value.url,
    files_count: typeof value.files_count === 'number' ? value.files_count : 0,
    password_protected: value.password_protected === true,
    accepts_uploads: value.accepts_uploads === true,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    expires_at: typeof value.expires_at === 'string' ? value.expires_at : null,
  };
}

/** A trimmed collection name, or an error message when it is empty or too long. */
export function validateCollectionName(name: string): { name: string } | { error: string } {
  const trimmed = name.trim();

  if (!trimmed) {
    return { error: 'The collection name cannot be empty.' };
  }

  if (Array.from(trimmed).length > MAX_COLLECTION_NAME_LENGTH) {
    return { error: `The collection name must be at most ${MAX_COLLECTION_NAME_LENGTH} characters.` };
  }

  return { name: trimmed };
}

/** Every collection the token's account owns, newest first. */
export async function listCollections(client: ApiClient): Promise<Collection[]> {
  const collections: Collection[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await client.request<unknown>('GET', `/api/v1/collections?page=${page}`, undefined, { idempotent: true });

    if (!Array.isArray(data)) {
      throw new ApiError('Unexpected response when listing collections.', null);
    }

    collections.push(...data.map((entry) => toCollection(entry, 'listing collections')));

    if (data.length < COLLECTIONS_PER_PAGE) {
      break;
    }
  }

  return collections;
}

/**
 * Create a collection holding `fileIds` in order, or an empty one to upload into later. The first
 * 100 files go with the create request and the rest are added 100 at a time, so a collection can
 * hold more than one request's worth.
 */
export async function createCollection(client: ApiClient, name: string, fileIds: string[] = []): Promise<Collection> {
  const created = toCollection(
    await client.request<unknown>('POST', '/api/v1/collections', {
      name,
      ...(fileIds.length > 0 && { file_ids: fileIds.slice(0, FILES_PER_REQUEST) }),
    }),
    'creating the collection',
  );
  let collection = created;

  for (let start = FILES_PER_REQUEST; start < fileIds.length; start += FILES_PER_REQUEST) {
    try {
      // Adding files skips ones already in the collection, so a retried request changes nothing.
      collection = toCollection(
        await client.request<unknown>(
          'POST',
          `/api/v1/collections/${encodeURIComponent(created.id)}/files`,
          { file_ids: fileIds.slice(start, start + FILES_PER_REQUEST) },
          { idempotent: true },
        ),
        'adding files to the collection',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new CollectionIncompleteError(
        `Created ${created.url}, but adding files ${start + 1}-${Math.min(start + FILES_PER_REQUEST, fileIds.length)} failed: ${message}`,
        collection,
      );
    }
  }

  return collection;
}

/** The collection was created but not every file made it in. */
export class CollectionIncompleteError extends Error {
  readonly collection: Collection;

  constructor(message: string, collection: Collection) {
    super(message);
    this.name = 'CollectionIncompleteError';
    this.collection = collection;
  }
}
