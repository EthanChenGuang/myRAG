import { getSupabaseAdmin } from '@/lib/supabase';
import { versionPrefix } from '../artifacts';
import { assertObjectKey } from '../object-store';

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
}

export interface PublicStorageClientLike {
  storage: { from(bucket: string): PublicStorageBucketApi };
}

function raceAbort<T>(call: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(call);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(call).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The store over the service-role client: the bucket is public to read by URL, and only this client writes under `rag/`. */
export function createSupabasePublicImageStore(client: () => PublicStorageClientLike | null): PublicImageStore {
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
