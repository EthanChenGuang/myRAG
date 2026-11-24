import { getSupabaseAdmin } from '@/lib/supabase';

/** The object-key pattern Supabase Storage enforces. Anything outside it, such as a zh or accented it filename, is refused. */
export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/;

/** The only name of the private bucket in the codebase; the bucket has no storage.objects policy. */
export const ORIGINALS_BUCKET = 'rag-originals';
export const ORIGINALS_MAX_BYTES = 20 * 1024 * 1024;

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface ObjectStoreCallOptions {
  signal?: AbortSignal;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, options: ObjectStoreCallOptions & { contentType: string }): Promise<void>;
  /** The stored object, or null when the key does not exist. */
  get(key: string, options?: ObjectStoreCallOptions): Promise<StoredObject | null>;
  remove(key: string, options?: ObjectStoreCallOptions): Promise<void>;
  exists(key: string, options?: ObjectStoreCallOptions): Promise<boolean>;
}

/** A failed store call. Carries the operation and the HTTP status only: the storage message can echo keys and content types. */
export class ObjectStoreError extends Error {
  readonly op: string;
  readonly status: number | null;

  constructor(op: string, status: number | null = null) {
    super(`[Object Store] ${op} failed${status === null ? '' : ` (${status})`}`);
    this.name = 'ObjectStoreError';
    this.op = op;
    this.status = status;
  }
}

/** Refuses what Supabase refuses and what could leave the tenant prefix: empty, root-relative, dot or empty segments, non-ASCII. */
export function assertObjectKey(key: string): void {
  if (key === '' || !OBJECT_KEY_PATTERN.test(key) || key.startsWith('/')) throw new ObjectStoreError('key', 400);
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new ObjectStoreError('key', 400);
  }
}

export interface StorageErrorLike {
  message?: string;
  status?: number;
  statusCode?: string;
  originalError?: unknown;
}

interface StorageResult<T> {
  data: T | null;
  error: StorageErrorLike | null;
}

/** The part of a Supabase storage bucket client the store uses. */
export interface StorageBucketApi {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<StorageResult<unknown>>;
  download(path: string): PromiseLike<StorageResult<Blob>>;
  remove(paths: string[]): PromiseLike<StorageResult<unknown>>;
  exists(path: string): PromiseLike<StorageResult<boolean>>;
}

export interface StorageClientLike {
  storage: { from(bucket: string): StorageBucketApi };
}

function statusOf(error: StorageErrorLike): number | null {
  if (typeof error.status === 'number') return error.status;
  const original = error.originalError;
  if (typeof original === 'object' && original !== null && typeof (original as { status?: unknown }).status === 'number') {
    return (original as { status: number }).status;
  }
  const code = Number(error.statusCode);
  return Number.isInteger(code) && code > 0 ? code : null;
}

/** Storage answers a missing object in a private bucket with 404, or with 400 and no statusCode of its own. */
function isMissing(error: StorageErrorLike): boolean {
  if (error.statusCode === '404') return true;
  const status = statusOf(error);
  return status === 404 || (status === 400 && error.statusCode === undefined);
}

/** The storage client takes no abort signal, so a run's abort ends the wait; the request itself finishes in the background. */
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

/**
 * The store over a Supabase storage client. Pass the service-role client only: the bucket has no policy, so any other
 * client sees nothing, and this module is the one place that names the bucket.
 */
export function createSupabaseObjectStore(client: () => StorageClientLike | null): ObjectStore {
  async function guarded<T>(
    op: string,
    key: string,
    signal: AbortSignal | undefined,
    call: (api: StorageBucketApi) => PromiseLike<StorageResult<T>>,
  ): Promise<StorageResult<T>> {
    assertObjectKey(key);
    signal?.throwIfAborted();
    const admin = client();
    if (!admin) throw new ObjectStoreError(op, null);
    return raceAbort(call(admin.storage.from(ORIGINALS_BUCKET)), signal);
  }

  return {
    async put(key, bytes, options) {
      if (bytes.byteLength > ORIGINALS_MAX_BYTES) throw new ObjectStoreError('put', 413);
      const { error } = await guarded('put', key, options.signal, (api) => api.upload(key, bytes, { contentType: options.contentType, upsert: true }));
      if (error) throw new ObjectStoreError('put', statusOf(error));
    },

    async get(key, options) {
      const { data, error } = await guarded('get', key, options?.signal, (api) => api.download(key));
      if (error) {
        if (isMissing(error)) return null;
        throw new ObjectStoreError('get', statusOf(error));
      }
      if (!data) return null;
      const buffer = await raceAbort(data.arrayBuffer(), options?.signal);
      return { bytes: new Uint8Array(buffer), contentType: data.type === '' ? null : data.type };
    },

    async remove(key, options) {
      const { error } = await guarded('remove', key, options?.signal, (api) => api.remove([key]));
      if (error) throw new ObjectStoreError('remove', statusOf(error));
    },

    async exists(key, options) {
      const { data, error } = await guarded('exists', key, options?.signal, (api) => api.exists(key));
      if (error && !isMissing(error)) throw new ObjectStoreError('exists', statusOf(error));
      return data === true;
    },
  };
}

let defaultStore: ObjectStore | null = null;
let override: ObjectStore | null = null;

/** The store of the running process: the Supabase store on the admin client, unless a test installed another. */
export function getObjectStore(): ObjectStore {
  if (override) return override;
  defaultStore ??= createSupabaseObjectStore(() => getSupabaseAdmin() as unknown as StorageClientLike | null);
  return defaultStore;
}

export function setObjectStoreForTests(store: ObjectStore): void {
  override = store;
}

export function resetObjectStoreForTests(): void {
  override = null;
}
