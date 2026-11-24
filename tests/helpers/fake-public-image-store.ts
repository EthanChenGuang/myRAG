import { assertPublicImageKey, PublicImageStoreError, setPublicImageStoreForTests, type PublicImageStore } from '@/lib/rag/ingest/images/public-store';

export const FAKE_PUBLIC_IMAGE_BASE = 'https://project.example.test/storage/v1/object/public/chat-images/';

export interface FakePublicImageStore extends PublicImageStore {
  readonly objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  /** Every key put, in order, repeats included. */
  readonly puts: string[];
  failIf(predicate: (key: string) => boolean): void;
  keys(): string[];
}

/** An in-memory public bucket that refuses every key the real store refuses. */
export function createFakePublicImageStore(): FakePublicImageStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const puts: string[] = [];
  let failing: ((key: string) => boolean) | null = null;
  return {
    objects,
    puts,
    failIf(predicate) {
      failing = predicate;
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
  };
}

export function installFakePublicImageStore(): FakePublicImageStore {
  const store = createFakePublicImageStore();
  setPublicImageStoreForTests(store);
  return store;
}
