export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/;

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface ObjectStoreCallOptions {
  signal?: AbortSignal;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, options: ObjectStoreCallOptions & { contentType: string }): Promise<void>;
  get(key: string, options?: ObjectStoreCallOptions): Promise<StoredObject | null>;
  remove(key: string, options?: ObjectStoreCallOptions): Promise<void>;
  exists(key: string, options?: ObjectStoreCallOptions): Promise<boolean>;
}

const inert: ObjectStore = {
  async put() {},
  async get() {
    return null;
  },
  async remove() {},
  async exists() {
    return false;
  },
};

let override: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  return override ?? inert;
}

export function setObjectStoreForTests(store: ObjectStore): void {
  override = store;
}

export function resetObjectStoreForTests(): void {
  override = null;
}

export const ORIGINALS_BUCKET = 'rag-originals';
export const ORIGINALS_MAX_BYTES = 20 * 1024 * 1024;

export class ObjectStoreError extends Error {
  readonly op: string;
  readonly status: number | null;

  constructor(op: string, status: number | null = null) {
    super(`[Object Store] ${op}`);
    this.name = 'ObjectStoreError';
    this.op = op;
    this.status = status;
  }
}

export function assertObjectKey(_key: string): void {}

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

export interface StorageBucketApi {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<StorageResult<unknown>>;
  download(path: string): PromiseLike<StorageResult<Blob>>;
  remove(paths: string[]): PromiseLike<StorageResult<unknown>>;
  exists(path: string): PromiseLike<StorageResult<boolean>>;
}

export interface StorageClientLike {
  storage: { from(bucket: string): StorageBucketApi };
}

export function createSupabaseObjectStore(_client: () => StorageClientLike | null): ObjectStore {
  return inert;
}
