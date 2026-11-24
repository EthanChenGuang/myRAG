import { OBJECT_KEY_PATTERN, ObjectStoreError, setObjectStoreForTests, type ObjectStore, type StoredObject } from '@/lib/rag/ingest/object-store';

type Operation = 'put' | 'get' | 'remove' | 'exists';

export interface FakeObjectStore extends ObjectStore {
  readonly objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  /** Every call in order, with the key it named. */
  readonly calls: Array<{ op: Operation; key: string }>;
  /** Makes every later call of the named operations fail as a storage outage does. */
  failOn(...operations: Operation[]): void;
  heal(): void;
  keys(): string[];
}

/** An in-memory store that refuses every key Supabase Storage refuses, so a key that is not plain ASCII fails the test. */
export function createFakeObjectStore(): FakeObjectStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const calls: Array<{ op: Operation; key: string }> = [];
  let failing = new Set<Operation>();

  function enter(op: Operation, key: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    calls.push({ op, key });
    if (!OBJECT_KEY_PATTERN.test(key) || key === '') throw new ObjectStoreError(op, 400);
    if (failing.has(op)) throw new ObjectStoreError(op, 503);
  }

  return {
    objects,
    calls,
    failOn(...operations) {
      failing = new Set(operations);
    },
    heal() {
      failing = new Set();
    },
    keys() {
      return [...objects.keys()].sort();
    },
    async put(key, bytes, options) {
      enter('put', key, options.signal);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options.contentType });
    },
    async get(key, options) {
      enter('get', key, options?.signal);
      const found = objects.get(key);
      if (!found) return null;
      const stored: StoredObject = { bytes: new Uint8Array(found.bytes), contentType: found.contentType };
      return stored;
    },
    async remove(key, options) {
      enter('remove', key, options?.signal);
      objects.delete(key);
    },
    async exists(key, options) {
      enter('exists', key, options?.signal);
      return objects.has(key);
    },
  };
}

export function installFakeObjectStore(): FakeObjectStore {
  const store = createFakeObjectStore();
  setObjectStoreForTests(store);
  return store;
}
