import {
  assertPublicImageKey,
  assertPublicImageLineagePrefix,
  assertPublicImageRemoval,
  assertUploadImageFolder,
  assertUploadImageKey,
  PublicImageStoreError,
  setPublicImageStoreForTests,
  type PublicImageStore,
} from '@/lib/rag/ingest/images/public-store';

export const FAKE_PUBLIC_IMAGE_BASE = 'https://project.example.test/storage/v1/object/public/chat-images/';

export interface FakePublicImageStore extends PublicImageStore {
  readonly objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  /** Every key put, in order, repeats included. */
  readonly puts: string[];
  /** Every key removed, in order. */
  readonly removals: string[];
  failIf(predicate: (key: string) => boolean): void;
  /** Makes removals (page pictures and uploads) of the keys the predicate accepts fail as a storage outage does. */
  failRemoveIf(predicate: ((key: string) => boolean) | null): void;
  /** Stores an image as the upload route does (`<user id>/<name>`), outside the `rag/` prefix. */
  putUpload(key: string, bytes: Uint8Array): void;
  keys(): string[];
}

/** An in-memory public bucket that refuses every key the real store refuses. */
export function createFakePublicImageStore(): FakePublicImageStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const puts: string[] = [];
  const removals: string[] = [];
  let failing: ((key: string) => boolean) | null = null;
  let failingRemove: ((key: string) => boolean) | null = null;
  const removeOne = (key: string): void => {
    if (failingRemove?.(key)) throw new PublicImageStoreError('remove', 503);
    objects.delete(key);
    removals.push(key);
  };
  return {
    objects,
    puts,
    removals,
    failIf(predicate) {
      failing = predicate;
    },
    failRemoveIf(predicate) {
      failingRemove = predicate;
    },
    putUpload(key, bytes) {
      assertUploadImageKey(key);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: 'image/png' });
    },
    keys: () => [...objects.keys()].sort(),
    async put(key, bytes, options) {
      options.signal?.throwIfAborted();
      assertPublicImageKey(key);
      puts.push(key);
      if (failing?.(key)) throw new PublicImageStoreError('put', 503);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options.contentType });
    },
    urlFor(key) {
      assertPublicImageKey(key);
      return `${FAKE_PUBLIC_IMAGE_BASE}${key}`;
    },
    async remove(keys, options) {
      options.signal?.throwIfAborted();
      assertPublicImageRemoval(keys, options.within);
      if (keys.some((key) => failingRemove?.(key))) throw new PublicImageStoreError('remove', 503);
      for (const key of keys) removeOne(key);
    },
    async list(prefix, options) {
      options?.signal?.throwIfAborted();
      assertPublicImageLineagePrefix(prefix);
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    async removeUpload(key, options) {
      options?.signal?.throwIfAborted();
      assertUploadImageKey(key);
      removeOne(key);
    },
    async listUploads(folder, options) {
      options?.signal?.throwIfAborted();
      assertUploadImageFolder(folder);
      return [...objects.keys()].filter((key) => key.startsWith(folder)).sort();
    },
  };
}

export function installFakePublicImageStore(): FakePublicImageStore {
  const store = createFakePublicImageStore();
  setPublicImageStoreForTests(store);
  return store;
}
