import { getSupabaseAdmin } from '@/lib/supabase';
import { versionPrefix } from '../artifacts';
import { assertObjectKey, listStorageFolder, raceAbort, statusOf, type StorageListEntry, type StorageResult } from '../object-store';

/** The public bucket the chat already reads image URLs from (source_images). Images of PDFs live under the `rag/` prefix of it. */
export const PUBLIC_IMAGES_BUCKET = 'chat-images';
export const PUBLIC_IMAGE_PREFIX = 'rag/';
/** Same cap as an uploaded image (the upload route's limit). */
export const PUBLIC_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const LINEAGE_PREFIX = /^rag\/[a-z]:[a-z0-9-]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;
/** An image the upload route stored for a user: `<user id>/<unique name>` (src/app/api/upload/route.ts), never under `rag/`. */
const UPLOAD_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_.-]{1,255}$/;
const UPLOAD_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

const KEY =
  /^rag\/[a-z]:[a-z0-9-]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9]{1,10}\/p[0-9]{1,6}-[0-9]{1,3}\.(png|jpg|webp|gif)$/;

/** A failed public-image call. Carries the operation and status only: the storage message can echo keys. */
export class PublicImageStoreError extends Error {
  readonly op: string;
  readonly status: number | null;

  constructor(op: string, status: number | null = null) {
    super(`[Public Images] ${op} failed${status === null ? '' : ` (${status})`}`);
    this.name = 'PublicImageStoreError';
    this.op = op;
    this.status = status;
  }
}

export interface PublicImageStore {
  /** Stores one image under a key made by publicImageKey, replacing an earlier copy. */
  put(key: string, bytes: Uint8Array, options: { contentType: string; signal?: AbortSignal }): Promise<void>;
  /** The public URL of a key; no network call. */
  urlFor(key: string): string;
  /**
   * Removes page pictures of one lineage. `within` must be a lineage prefix `rag/<tenant>/<lineage>/` and every key must have the
   * publicImageKey shape under it; otherwise nothing is removed and the call fails.
   */
  remove(keys: string[], options: { within: string; signal?: AbortSignal }): Promise<void>;
  /** Every page picture under a lineage prefix `rag/<tenant>/<lineage>/`, sorted. */
  list(prefix: string, options?: { signal?: AbortSignal }): Promise<string[]>;
  /** Removes one image the upload route stored (`<user id>/<name>`). */
  removeUpload(key: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** The uploaded images of one user folder `<user id>/`, sorted. */
  listUploads(folder: string, options?: { signal?: AbortSignal }): Promise<string[]>;
}

/** Refuses anything but a lineage prefix of page pictures. */
export function assertPublicImageLineagePrefix(prefix: string): string {
  if (!LINEAGE_PREFIX.test(prefix)) throw new PublicImageStoreError('key', 400);
  assertObjectKey(prefix.slice(0, -1));
  return prefix;
}

/** Refuses anything but an upload-route image key; it never names a page picture under `rag/`. */
export function assertUploadImageKey(key: string): string {
  if (!UPLOAD_KEY.test(key)) throw new PublicImageStoreError('key', 400);
  assertObjectKey(key);
  return key;
}

export function assertUploadImageFolder(folder: string): string {
  if (!UPLOAD_FOLDER.test(folder)) throw new PublicImageStoreError('key', 400);
  return folder;
}

/** Checks a removal before anything is sent: the prefix and every key, all or nothing. */
export function assertPublicImageRemoval(keys: string[], within: string): void {
  assertPublicImageLineagePrefix(within);
  for (const key of keys) {
    assertPublicImageKey(key);
    if (!key.startsWith(within)) throw new PublicImageStoreError('key', 400);
  }
}

/** The file extension of an image media type, or null for one the chat cannot show. */
export function publicImageExtension(mimeType: string): string | null {
  return EXTENSIONS[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? null;
}

/**
 * `rag/<tenant_key>/<lineage_id>/<version>/p<page>-<n>.<ext>`: built from the run's tenant key, the version's lineage (a random UUID)
 * and integers, never from a filename or anything the document says. The tenant segment keeps one tenant's images apart from another's.
 */
export function publicImageKey(tenantKey: string, lineageId: string, version: number, page: number, ordinal: number, extension: string): string {
  if (!Number.isInteger(page) || page < 1 || page > 999_999) throw new PublicImageStoreError('key', 400);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 999) throw new PublicImageStoreError('key', 400);
  const key = `${PUBLIC_IMAGE_PREFIX}${versionPrefix(tenantKey, lineageId, version)}p${page}-${ordinal}.${extension}`;
  return assertPublicImageKey(key);
}

/** Refuses any key that is not exactly the shape publicImageKey makes, so nothing can name a path outside `rag/<tenant>/...`. */
export function assertPublicImageKey(key: string): string {
  if (!KEY.test(key)) throw new PublicImageStoreError('key', 400);
  assertObjectKey(key);
  return key;
}

export interface PublicStorageBucketApi {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<{ error: { status?: number; statusCode?: string } | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  remove?(paths: string[]): PromiseLike<{ error: { status?: number; statusCode?: string } | null }>;
  list?(path: string, options: { limit: number; offset: number }): PromiseLike<StorageResult<StorageListEntry[]>>;
}

export interface PublicStorageClientLike {
  storage: { from(bucket: string): PublicStorageBucketApi };
}

/** The store over the service-role client: the bucket is public to read by URL, and only this client writes under `rag/`. */
export function createSupabasePublicImageStore(client: () => PublicStorageClientLike | null): PublicImageStore {
  const bucket = (op: string): PublicStorageBucketApi => {
    const admin = client();
    if (!admin) throw new PublicImageStoreError(op, null);
    return admin.storage.from(PUBLIC_IMAGES_BUCKET);
  };

  async function removePaths(paths: string[], signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    const api = bucket('remove');
    if (typeof api.remove !== 'function') throw new PublicImageStoreError('remove', null);
    const { error } = await raceAbort(api.remove(paths), signal);
    if (error) throw new PublicImageStoreError('remove', statusOf(error));
  }

  async function listPaths(prefix: string, signal: AbortSignal | undefined): Promise<string[]> {
    signal?.throwIfAborted();
    const api = bucket('list');
    if (typeof api.list !== 'function') throw new PublicImageStoreError('list', null);
    return listStorageFolder((path, opts) => api.list!(path, opts), prefix, signal, (status) => new PublicImageStoreError('list', status));
  }

  return {
    async put(key, bytes, options) {
      assertPublicImageKey(key);
      if (bytes.byteLength > PUBLIC_IMAGE_MAX_BYTES) throw new PublicImageStoreError('put', 413);
      options.signal?.throwIfAborted();
      const admin = client();
      if (!admin) throw new PublicImageStoreError('put', null);
      const { error } = await raceAbort(admin.storage.from(PUBLIC_IMAGES_BUCKET).upload(key, bytes, { contentType: options.contentType, upsert: true }), options.signal);
      if (error) {
        const code = Number(error.statusCode);
        throw new PublicImageStoreError('put', typeof error.status === 'number' ? error.status : Number.isInteger(code) && code > 0 ? code : null);
      }
    },

    urlFor(key) {
      assertPublicImageKey(key);
      const admin = client();
      if (!admin) throw new PublicImageStoreError('url', null);
      return admin.storage.from(PUBLIC_IMAGES_BUCKET).getPublicUrl(key).data.publicUrl;
    },

    async remove(keys, options) {
      assertPublicImageRemoval(keys, options.within);
      if (keys.length === 0) return;
      await removePaths(keys, options.signal);
    },

    async list(prefix, options) {
      assertPublicImageLineagePrefix(prefix);
      const found = await listPaths(prefix, options?.signal);
      return found.filter((key) => KEY.test(key) && key.startsWith(prefix));
    },

    async removeUpload(key, options) {
      assertUploadImageKey(key);
      await removePaths([key], options?.signal);
    },

    async listUploads(folder, options) {
      assertUploadImageFolder(folder);
      const found = await listPaths(folder, options?.signal);
      return found.filter((key) => UPLOAD_KEY.test(key) && key.startsWith(folder));
    },
  };
}

let defaultStore: PublicImageStore | null = null;
let override: PublicImageStore | null = null;

export function getPublicImageStore(): PublicImageStore {
  if (override) return override;
  defaultStore ??= createSupabasePublicImageStore(() => getSupabaseAdmin() as unknown as PublicStorageClientLike | null);
  return defaultStore;
}

export function setPublicImageStoreForTests(store: PublicImageStore): void {
  override = store;
}

export function resetPublicImageStoreForTests(): void {
  override = null;
}
