import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DOCLING_ARTIFACT,
  PARSE_ARTIFACT,
  loadArtifact,
  originalKey,
  originalName,
  saveArtifact,
  versionPrefix,
  type ArtifactContext,
} from '@/lib/rag/ingest/artifacts';
import {
  OBJECT_KEY_PATTERN,
  ORIGINALS_BUCKET,
  ORIGINALS_MAX_BYTES,
  ObjectStoreError,
  assertObjectKey,
  createSupabaseObjectStore,
  getObjectStore,
  resetObjectStoreForTests,
  setObjectStoreForTests,
  type StorageBucketApi,
  type StorageClientLike,
} from '@/lib/rag/ingest/object-store';
import { createFakeObjectStore } from '../../helpers/fake-object-store';

const ORG_KEY = 'o:3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69';
const USER_KEY = 'u:7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LINEAGE = '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

afterEach(() => resetObjectStoreForTests());

function artifactContext(overrides: Partial<ArtifactContext> = {}): ArtifactContext {
  return {
    identity: { tenantKey: ORG_KEY },
    document: { lineageId: LINEAGE, version: 2 },
    signal: new AbortController().signal,
    state: { artifacts: {} },
    ...overrides,
  };
}

describe('object keys', () => {
  test('versionPrefix is <tenant_key>/<lineage_id>/<version>/ and refuses anything else', () => {
    expect(versionPrefix(ORG_KEY, LINEAGE, 2)).toBe(`${ORG_KEY}/${LINEAGE}/2/`);
    expect(versionPrefix('s:default', LINEAGE, 1)).toBe(`s:default/${LINEAGE}/1/`);
    expect(() => versionPrefix('o:../x', LINEAGE, 1)).toThrow();
    expect(() => versionPrefix(ORG_KEY, '../..', 1)).toThrow();
    expect(() => versionPrefix(ORG_KEY, `${LINEAGE}/x`, 1)).toThrow();
    expect(() => versionPrefix(ORG_KEY, LINEAGE, 0)).toThrow();
    expect(() => versionPrefix(ORG_KEY, LINEAGE, 1.5)).toThrow();
    expect(() => versionPrefix('合同:1', LINEAGE, 1)).toThrow();
  });

  test('the original key uses a fixed ASCII basename whatever the filename is', () => {
    const prefix = versionPrefix(ORG_KEY, LINEAGE, 2);
    const cases: Array<[string, string]> = [
      ['合同.pdf', 'original.pdf'],
      ['società.docx', 'original.docx'],
      ['Report.PDF', 'original.pdf'],
      ['archive.tar.gz', 'original.gz'],
      ['no-extension', 'original.bin'],
      ['trailing.', 'original.bin'],
      ['long.extension1', 'original.bin'],
      ['accent.文件', 'original.bin'],
      ['../../etc/passwd', 'original.bin'],
      ['evil.p/df', 'original.bin'],
    ];
    for (const [filename, name] of cases) {
      expect(originalName(filename), filename).toBe(name);
      expect(originalKey(prefix, filename), filename).toBe(`${prefix}${name}`);
    }
  });

  test('every key built from a tenant key, UUIDs, a version and a filename passes the Supabase object-key pattern and has no dot segment', () => {
    const filenames = ['合同.pdf', 'società.docx', 'a b.txt', '../x.md', '日本語', 'normal.md'];
    for (const tenantKey of ['s:default', USER_KEY, ORG_KEY]) {
      const prefix = versionPrefix(tenantKey, LINEAGE, 3);
      for (const filename of filenames) {
        for (const key of [originalKey(prefix, filename), `${prefix}${PARSE_ARTIFACT}`, `${prefix}${DOCLING_ARTIFACT}`]) {
          expect(OBJECT_KEY_PATTERN.test(key), key).toBe(true);
          expect(key.startsWith(`${tenantKey}/`)).toBe(true);
          expect(key.split('/').some((segment) => segment === '' && key.endsWith('/') === false)).toBe(false);
          expect(key.split('/').includes('..')).toBe(false);
          expect(() => assertObjectKey(key), key).not.toThrow();
        }
      }
    }
  });

  test('assertObjectKey refuses keys Supabase refuses and keys that climb or start at the root', () => {
    for (const key of ['', '合同.pdf', 'a/合同.pdf', '/leading', 'a/../b', 'a/./b', 'a//b', '../x', 'a\\b', 'a\nb']) {
      expect(() => assertObjectKey(key), JSON.stringify(key)).toThrow(ObjectStoreError);
    }
    expect(() => assertObjectKey(`${ORG_KEY}/${LINEAGE}/1/original.md`)).not.toThrow();
  });
});

describe('the in-memory store', () => {
  test('put then get round-trips bytes and content type, get of a missing key is null, remove deletes', async () => {
    const store = createFakeObjectStore();
    const key = `${ORG_KEY}/${LINEAGE}/1/original.md`;
    const bytes = new TextEncoder().encode('# 标题\n');
    await store.put(key, bytes, { contentType: 'text/markdown' });
    expect(await store.exists(key)).toBe(true);
    const found = await store.get(key);
    expect(found?.contentType).toBe('text/markdown');
    expect(Array.from(found?.bytes ?? [])).toEqual(Array.from(bytes));
    await store.remove(key);
    expect(await store.get(key)).toBeNull();
    expect(await store.exists(key)).toBe(false);
  });

  test('rejects a key that Supabase would reject, as Supabase does', async () => {
    const store = createFakeObjectStore();
    await expect(store.put('o:x/合同.pdf', new Uint8Array(1), { contentType: 'application/pdf' })).rejects.toBeInstanceOf(ObjectStoreError);
    expect(store.keys()).toEqual([]);
  });
});

describe('artifacts', () => {
  test('saveArtifact and loadArtifact round-trip under the version prefix and record the key in the state', async () => {
    const store = createFakeObjectStore();
    setObjectStoreForTests(store);
    const ctx = artifactContext();
    const prefix = versionPrefix(ORG_KEY, LINEAGE, 2);

    const originalKeyValue = await saveArtifact(ctx, 'original.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');
    const parseKey = await saveArtifact(ctx, PARSE_ARTIFACT, new TextEncoder().encode('# parsed'), 'text/markdown');

    expect(originalKeyValue).toBe(`${prefix}original.pdf`);
    expect(parseKey).toBe(`${prefix}parse.md`);
    expect(store.keys()).toEqual([originalKeyValue, parseKey].sort());
    expect(ctx.state.artifacts).toEqual({ 'original.pdf': originalKeyValue, 'parse.md': parseKey });
    const loaded = await loadArtifact(ctx, PARSE_ARTIFACT);
    expect(new TextDecoder().decode(loaded?.bytes)).toBe('# parsed');
    expect(loaded?.contentType).toBe('text/markdown');
    expect(await loadArtifact(ctx, DOCLING_ARTIFACT)).toBeNull();
  });

  test('artifact names are fixed ASCII basenames; anything else is refused before the store is called', async () => {
    const store = createFakeObjectStore();
    setObjectStoreForTests(store);
    const ctx = artifactContext();
    for (const name of ['../parse.md', 'a/parse.md', '合同.pdf', 'original', 'original.', '.md', 'PARSE.MD', 'parse.markdownfile']) {
      await expect(saveArtifact(ctx, name, new Uint8Array(1), 'text/plain'), name).rejects.toThrow();
      await expect(loadArtifact(ctx, name), name).rejects.toThrow();
    }
    expect(store.calls).toEqual([]);
  });

  test('an artifact needs the tenant key and the version of the run; without them nothing is stored', async () => {
    const store = createFakeObjectStore();
    setObjectStoreForTests(store);
    await expect(saveArtifact(artifactContext({ identity: null }), PARSE_ARTIFACT, new Uint8Array(1), 'text/plain')).rejects.toThrow();
    await expect(saveArtifact(artifactContext({ document: null }), PARSE_ARTIFACT, new Uint8Array(1), 'text/plain')).rejects.toThrow();
    expect(store.calls).toEqual([]);
  });
});

interface FakeBucket extends StorageBucketApi {
  calls: Array<{ op: string; args: unknown[] }>;
}

function fakeStorage(results: Partial<Record<'upload' | 'download' | 'remove' | 'exists', unknown>> = {}) {
  const buckets: string[] = [];
  const bucket: FakeBucket = {
    calls: [],
    async upload(path, body, options) {
      bucket.calls.push({ op: 'upload', args: [path, body, options] });
      return (results.upload as never) ?? { data: { path }, error: null };
    },
    async download(path) {
      bucket.calls.push({ op: 'download', args: [path] });
      return (results.download as never) ?? { data: new Blob([new Uint8Array([7, 8, 9])], { type: 'application/pdf' }), error: null };
    },
    async remove(paths) {
      bucket.calls.push({ op: 'remove', args: [paths] });
      return (results.remove as never) ?? { data: [], error: null };
    },
    async exists(path) {
      bucket.calls.push({ op: 'exists', args: [path] });
      return (results.exists as never) ?? { data: true, error: null };
    },
  };
  const client: StorageClientLike = {
    storage: {
      from(name) {
        buckets.push(name);
        return bucket;
      },
    },
  };
  return { client, bucket, buckets };
}

describe('the Supabase store', () => {
  const key = `${ORG_KEY}/${LINEAGE}/1/original.pdf`;

  test('writes to the rag-originals bucket with upsert so a retried stage rewrites the same object', async () => {
    const { client, bucket, buckets } = fakeStorage();
    const store = createSupabaseObjectStore(() => client);
    await store.put(key, new Uint8Array([1, 2]), { contentType: 'application/pdf' });

    expect(ORIGINALS_BUCKET).toBe('rag-originals');
    expect(new Set(buckets)).toEqual(new Set(['rag-originals']));
    expect(bucket.calls).toHaveLength(1);
    expect(bucket.calls[0]).toMatchObject({ op: 'upload', args: [key, expect.any(Uint8Array), { contentType: 'application/pdf', upsert: true }] });
  });

  test('reads bytes and content type back, and maps a missing object to null', async () => {
    const found = createSupabaseObjectStore(() => fakeStorage().client);
    const stored = await found.get(key);
    expect(Array.from(stored?.bytes ?? [])).toEqual([7, 8, 9]);
    expect(stored?.contentType).toBe('application/pdf');

    for (const error of [
      { message: 'Object not found', status: 404, statusCode: '404' },
      { message: 'Object not found', statusCode: '404' },
      { message: 'x', originalError: { status: 400 } },
    ]) {
      const missing = createSupabaseObjectStore(() => fakeStorage({ download: { data: null, error } }).client);
      expect(await missing.get(key)).toBeNull();
    }
  });

  test('exists and remove go to the same bucket; a failed call is an ObjectStoreError carrying the operation and status only', async () => {
    const { client, bucket } = fakeStorage();
    const store = createSupabaseObjectStore(() => client);
    expect(await store.exists(key)).toBe(true);
    await store.remove(key);
    expect(bucket.calls.map((call) => call.op)).toEqual(['exists', 'remove']);

    const failing = createSupabaseObjectStore(
      () => fakeStorage({ upload: { data: null, error: { message: 'secret-looking detail for tenant', status: 503 } } }).client,
    );
    const failure = await failing.put(key, new Uint8Array(1), { contentType: 'text/plain' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ObjectStoreError);
    expect((failure as ObjectStoreError).op).toBe('put');
    expect((failure as ObjectStoreError).status).toBe(503);
    expect((failure as ObjectStoreError).message).not.toContain('secret-looking');
    expect((failure as ObjectStoreError).message).not.toContain(key);
  });

  test('refuses a bad key, an oversized original and a missing admin client without calling storage', async () => {
    const { client, bucket } = fakeStorage();
    const store = createSupabaseObjectStore(() => client);
    await expect(store.put('o:x/合同.pdf', new Uint8Array(1), { contentType: 'application/pdf' })).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.get('a/../b')).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.put(key, new Uint8Array(ORIGINALS_MAX_BYTES + 1), { contentType: 'application/pdf' })).rejects.toMatchObject({ status: 413 });
    expect(bucket.calls).toEqual([]);

    const unavailable = createSupabaseObjectStore(() => null);
    await expect(unavailable.put(key, new Uint8Array(1), { contentType: 'text/plain' })).rejects.toMatchObject({ op: 'put' });
  });

  test('a call whose signal is already aborted never reaches storage, and an abort during a call ends it', async () => {
    const { client, bucket } = fakeStorage();
    const store = createSupabaseObjectStore(() => client);
    const aborted = AbortSignal.abort();
    await expect(store.put(key, new Uint8Array(1), { contentType: 'text/plain', signal: aborted })).rejects.toThrow();
    expect(bucket.calls).toEqual([]);

    const controller = new AbortController();
    const hanging: StorageClientLike = {
      storage: { from: () => ({ ...bucket, download: () => new Promise(() => undefined) }) },
    };
    const pending = createSupabaseObjectStore(() => hanging).get(key, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('who can reach the bucket', () => {
  test('getObjectStore is the Supabase store unless a test installs another, and reset restores it', () => {
    const fake = createFakeObjectStore();
    setObjectStoreForTests(fake);
    expect(getObjectStore()).toBe(fake);
    resetObjectStoreForTests();
    expect(getObjectStore()).not.toBe(fake);
  });

  test('only object-store.ts names the bucket, so no other module can open it with another client', () => {
    const root = path.resolve(__dirname, '../../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry) && readFileSync(full, 'utf8').includes('rag-originals')) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders).toEqual([path.join('lib', 'rag', 'ingest', 'object-store.ts')]);
  });
});
