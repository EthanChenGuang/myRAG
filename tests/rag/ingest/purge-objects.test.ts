import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetObjectStoreForTests, setObjectStoreForTests } from '@/lib/rag/ingest/object-store';
import { resetPublicImageStoreForTests, setPublicImageStoreForTests } from '@/lib/rag/ingest/images/public-store';
import * as purge from '@/lib/rag/ingest/purge';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createFakeObjectStore, type FakeObjectStore } from '../../helpers/fake-object-store';
import { createFakePublicImageStore, type FakePublicImageStore } from '../../helpers/fake-public-image-store';

type Row = Record<string, unknown>;

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000b2';
const TENANT = `u:${OWNER}`;
const OTHER_TENANT = `u:${OTHER_OWNER}`;
const DOC = '00000000-0000-4000-8000-0000000000d1';
const V1 = '00000000-0000-4000-8000-0000000000c1';
const V2 = DOC;
const AUDIT = '00000000-0000-4000-8000-0000000000e1';
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const SYNTHETIC_NAME = 'synthetic_upload_name';

const DB_STORES = ['documents', 'chunks', 'vectors', 'parents', 'ingestion_jobs', 'parse_cache', 'semantic_cache', 'answer_citations', 'chat_messages', 'sync_records'];

const lineage = crypto.randomUUID();
const otherLineage = crypto.randomUUID();
const versionKey = (version: number, name: string, tenant = TENANT, id = lineage) => `${tenant}/${id}/${version}/${name}`;
const parsePrefix = `${TENANT}/_parse-cache/${SHA}/docling-1-abcd/`;
const sharedParsePrefix = `${TENANT}/_parse-cache/${OTHER_SHA}/docling-1-abcd/`;
const imagePrefix = `rag/${TENANT}/${lineage}/`;
const uploadKey = `${OWNER}/${SYNTHETIC_NAME}_1700000000000_abc123.png`;
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

interface World {
  rpc: Array<{ fn: string; args: Row }>;
  finishes: Row[];
  verifyRows: Row[];
  documents: Array<{ id: string; source: string | null; sourceFileId: string | null }>;
  pendingRows: Row[];
  objectKeys: string[];
}

let world: World;
let store: FakeObjectStore;
let pictures: FakePublicImageStore;
let invalidate: ReturnType<typeof vi.fn>;
let cacheOn: boolean;
let onPurge: (() => void) | null = null;

function rpcClient() {
  return {
    rpc(fn: string, args: Row) {
      world.rpc.push({ fn, args });
      let data: unknown = [];
      switch (fn) {
        case 'rag_purge_admin_target':
          data = [{ tenant_key: TENANT, lineage_id: lineage, is_connector: false }];
          break;
        case 'rag_purge_lineage':
          onPurge?.();
          data = [
            {
              audit_id: AUDIT,
              counts: Object.fromEntries(DB_STORES.map((store) => [store, store === 'documents' ? 2 : 1])),
              object_keys: world.objectKeys,
              parse_cache_prefixes: [parsePrefix, `${OTHER_TENANT}/_parse-cache/${SHA}/docling-1-abcd/`],
              image_prefixes: [imagePrefix],
            },
          ];
          break;
        case 'rag_purge_verify':
          data = world.verifyRows;
          break;
        case 'rag_purge_audit_finish':
          world.finishes.push(args);
          data = true;
          break;
        case 'rag_purge_audit_pending':
          data = world.pendingRows;
          break;
        case 'rag_purge_scrub_chats':
          data = 1;
          break;
        case 'rag_purge_tombstone_exists':
          data = true;
          break;
      }
      const request = {
        abortSignal: () => request,
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve, reject),
      };
      return request;
    },
  };
}

async function seedObjects(): Promise<void> {
  for (const version of [1, 2]) {
    for (const name of ['original.pdf', 'parse.md']) await store.put(versionKey(version, name), new Uint8Array([1]), { contentType: 'text/plain' });
  }
  // Stored by the run but never recorded on the row: the lineage sweep still removes it.
  await store.put(versionKey(2, 'chunks.json'), new Uint8Array([1]), { contentType: 'application/json' });
  await store.put(`${parsePrefix}result.json`, new Uint8Array([1]), { contentType: 'application/json' });
  await store.put(`${parsePrefix}docling.json`, new Uint8Array([1]), { contentType: 'application/json' });
  await store.put(`${sharedParsePrefix}result.json`, new Uint8Array([1]), { contentType: 'application/json' });
  await store.put(versionKey(1, 'original.pdf', TENANT, otherLineage), new Uint8Array([1]), { contentType: 'text/plain' });
  await store.put(versionKey(1, 'original.pdf', OTHER_TENANT, lineage), new Uint8Array([1]), { contentType: 'text/plain' });
  await store.put(`${OTHER_TENANT}/_parse-cache/${SHA}/docling-1-abcd/result.json`, new Uint8Array([1]), { contentType: 'application/json' });
  for (const name of ['1/p1-1.png', '2/p3-1.png']) await pictures.put(`${imagePrefix}${name}`, new Uint8Array([1]), { contentType: 'image/png' });
  await pictures.put(`rag/${TENANT}/${otherLineage}/1/p1-1.png`, new Uint8Array([1]), { contentType: 'image/png' });
  world.objectKeys = [versionKey(1, 'original.pdf'), versionKey(1, 'parse.md'), versionKey(2, 'original.pdf'), versionKey(2, 'parse.md')];
}

const lastFinish = () => world.finishes[world.finishes.length - 1] as { p_pending: string[]; p_result: string; p_verification: Row; p_object_counts: Row };

async function adminPurge() {
  return purge.purgeDocumentAsAdmin({ documentId: DOC, actorUserId: ADMIN, reasonCode: 'owner_request', reasonNote: null, signal: new AbortController().signal });
}

describe('purge objects after commit (D-15, D-37)', () => {
  beforeEach(async () => {
    world = {
      rpc: [],
      finishes: [],
      verifyRows: DB_STORES.map((store) => ({ store, remaining: 0, state: null })),
      documents: [
        { id: V1, source: 'config_upload', sourceFileId: null },
        { id: V2, source: 'config_upload', sourceFileId: null },
      ],
      pendingRows: [],
      objectKeys: [],
    };
    store = createFakeObjectStore();
    pictures = createFakePublicImageStore();
    setObjectStoreForTests(store);
    setPublicImageStoreForTests(pictures);
    invalidate = vi.fn(async () => 1);
    cacheOn = false;
    purge.setPurgeDepsForTests({
      db: () => rpcClient() as never,
      lineageDocuments: async () => world.documents,
      cacheTarget: () => (cacheOn ? { invalidateTenant: invalidate as never } : null),
      scopeOf: async () => mintScope('personal', OWNER, null),
    });
    await seedObjects();
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    onPurge = null;
    purge.resetPurgeDepsForTests();
    resetObjectStoreForTests();
    resetPublicImageStoreForTests();
    vi.restoreAllMocks();
  });

  it('removes every object of the lineage in the three locations and keeps other lineages and a shared parse-cache entry', async () => {
    const result = await adminPurge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.keys().filter((key) => key.startsWith(`${TENANT}/${lineage}/`))).toEqual([]);
    expect(store.keys().filter((key) => key.startsWith(parsePrefix))).toEqual([]);
    expect(pictures.keys().filter((key) => key.startsWith(imagePrefix))).toEqual([]);
    expect(store.keys()).toContain(`${sharedParsePrefix}result.json`);
    expect(store.keys()).toContain(versionKey(1, 'original.pdf', TENANT, otherLineage));
    expect(pictures.keys()).toContain(`rag/${TENANT}/${otherLineage}/1/p1-1.png`);
    expect(result.removed).toMatchObject({ original_files: 5, parse_cache_files: 2, page_images: 2 });
    expect(result.check.result).toBe('verified');
    expect(result.check.left).toMatchObject({ original_files: 0, parse_cache_files: 0, page_images: 0 });
    expect(lastFinish().p_pending).toEqual([]);
    expect(lastFinish().p_result).toBe('verified');
  });

  it('never deletes a key outside the purged tenant and lineage, even when the SQL answer names one', async () => {
    world.objectKeys.push(versionKey(1, 'original.pdf', OTHER_TENANT, lineage), versionKey(1, 'original.pdf', TENANT, otherLineage));
    const result = await adminPurge();
    expect(result.ok).toBe(true);
    expect(store.keys()).toContain(versionKey(1, 'original.pdf', OTHER_TENANT, lineage));
    expect(store.keys()).toContain(versionKey(1, 'original.pdf', TENANT, otherLineage));
    expect(store.keys()).toContain(`${OTHER_TENANT}/_parse-cache/${SHA}/docling-1-abcd/result.json`);
    expect(store.calls.filter((call) => call.op === 'remove' && !call.key.startsWith(`${TENANT}/${lineage}/`) && !call.key.startsWith(parsePrefix))).toEqual([]);
  });

  it('refuses a public removal outside the lineage prefix before anything is removed', async () => {
    await expect(pictures.remove([`rag/${TENANT}/${otherLineage}/1/p1-1.png`], { within: imagePrefix })).rejects.toThrow();
    await expect(pictures.remove([`${imagePrefix}1/p1-1.png`], { within: `rag/${TENANT}/` })).rejects.toThrow();
    expect(pictures.removals).toEqual([]);
  });

  it('records a failing removal as a pending path, reads pending, and a retry removes it and reads verified', async () => {
    store.failIf((op, key) => op === 'remove' && key === versionKey(2, 'parse.md'));
    pictures.failRemoveIf((key) => key.endsWith('p3-1.png'));
    const result = await adminPurge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check.result).toBe('pending');
    expect(result.check.pendingFiles).toBe(2);
    const pending = lastFinish().p_pending;
    expect(pending).toEqual([`original_files:${TENANT}/${lineage}/`, `page_images:${imagePrefix}`]);
    expect(lastFinish().p_result).toBe('pending');

    store.heal();
    pictures.failRemoveIf(null);
    world.pendingRows = [{ id: AUDIT, tenant_key: TENANT, lineage_id: lineage, version_ids: [V1, V2], pending_object_paths: pending, finished_at: new Date().toISOString(), result: 'pending' }];
    const retried = await purge.retryPendingPurgeObjects({ limit: 50, signal: new AbortController().signal });
    expect(retried).toMatchObject({ ok: true, records: 1, cleared: 2, stillPending: 0 });
    expect(store.keys().filter((key) => key.startsWith(`${TENANT}/${lineage}/`))).toEqual([]);
    expect(pictures.keys().filter((key) => key.startsWith(imagePrefix))).toEqual([]);
    expect(lastFinish().p_pending).toEqual([]);
    expect(lastFinish().p_result).toBe('verified');
  });

  it('removes the uploaded image of an image_upload lineage and stores only a hash of its key while it is pending', async () => {
    pictures.putUpload(uploadKey, new Uint8Array([1]));
    world.documents = [{ id: V2, source: 'image_upload', sourceFileId: uploadKey }];
    pictures.failRemoveIf((key) => key === uploadKey);
    const first = await adminPurge();
    expect(first.ok && first.check.result).toBe('pending');
    const pending = lastFinish().p_pending;
    expect(pending).toEqual([`uploaded_image:${OWNER}/sha256:${sha256(uploadKey)}`]);
    expect(JSON.stringify(world.finishes)).not.toContain(SYNTHETIC_NAME);

    pictures.failRemoveIf(null);
    world.pendingRows = [{ id: AUDIT, tenant_key: TENANT, lineage_id: lineage, version_ids: [V2], pending_object_paths: pending, finished_at: new Date().toISOString(), result: 'pending' }];
    const retried = await purge.retryPendingPurgeObjects({ limit: 50, signal: new AbortController().signal });
    expect(retried).toMatchObject({ ok: true, cleared: 1, stillPending: 0 });
    expect(pictures.keys()).not.toContain(uploadKey);
    expect(lastFinish().p_result).toBe('verified');
  });

  it('removes the uploaded image right away when storage answers', async () => {
    pictures.putUpload(uploadKey, new Uint8Array([1]));
    world.documents = [{ id: V2, source: 'image_upload', sourceFileId: uploadKey }];
    const result = await adminPurge();
    expect(result.ok && result.check.result).toBe('verified');
    expect(result.ok && result.removed.uploaded_image).toBe(1);
    expect(pictures.keys()).not.toContain(uploadKey);
  });

  it('invalidates the RedisVL cache of the tenant with the version ids, records a failure as pending, and calls nothing without that backend', async () => {
    await adminPurge();
    expect(invalidate).not.toHaveBeenCalled();

    cacheOn = true;
    await seedObjects();
    await adminPurge();
    expect(invalidate).toHaveBeenCalledTimes(1);
    const [scope, ids] = invalidate.mock.calls[0] as [unknown, string[]];
    expect((scope as { userId: string }).userId).toBe(OWNER);
    expect([...ids].sort()).toEqual([V1, V2].sort());

    invalidate.mockRejectedValueOnce(new Error('cache down'));
    await seedObjects();
    const failed = await adminPurge();
    expect(failed.ok && failed.check.result).toBe('pending');
    expect(lastFinish().p_pending).toEqual(['semantic_cache:redisvl']);
  });

  it('answers remaining for a database row left or a dead external target, and pending for a queued target', async () => {
    world.verifyRows = [...DB_STORES.map((store) => ({ store, remaining: 0, state: null })), { store: 'external:qdrant', remaining: 1, state: 'pending' }];
    const queued = await adminPurge();
    expect(queued.ok && queued.check).toMatchObject({ result: 'pending', queuedExternal: 1 });

    await seedObjects();
    world.verifyRows = [...DB_STORES.map((store) => ({ store, remaining: 0, state: null })), { store: 'external:qdrant', remaining: 1, state: 'dead' }];
    const dead = await adminPurge();
    expect(dead.ok && dead.check.result).toBe('remaining');
    expect(lastFinish().p_result).toBe('failed');

    await seedObjects();
    world.verifyRows = DB_STORES.map((store) => ({ store, remaining: store === 'chunks' ? 3 : 0, state: null }));
    const left = await adminPurge();
    expect(left.ok && left.check).toMatchObject({ result: 'remaining', left: { chunks: 3 } });
  });

  it('re-runs the chat scrub for purge records of the last 7 days only', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    world.pendingRows = [
      { id: AUDIT, tenant_key: TENANT, lineage_id: lineage, version_ids: [V1, V2], pending_object_paths: [], finished_at: recent, result: 'verified' },
      { id: crypto.randomUUID(), tenant_key: TENANT, lineage_id: otherLineage, version_ids: [V1], pending_object_paths: ['original_files:x/'], finished_at: old, result: 'pending' },
    ];
    const result = await purge.rescrubRecentPurges({ signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: true, records: 1 });
    const scrubs = world.rpc.filter((call) => call.fn === 'rag_purge_scrub_chats');
    expect(scrubs).toHaveLength(1);
    expect(scrubs[0]?.args).toMatchObject({ p_tenant_key: TENANT, p_lineage_id: lineage, p_document_ids: [V1, V2] });
  });

  it('still removes the objects and stores the check when the request is aborted while the purge commits', async () => {
    const request = new AbortController();
    onPurge = () => request.abort();
    const result = await purge.purgeDocumentAsAdmin({ documentId: DOC, actorUserId: ADMIN, reasonCode: 'owner_request', reasonNote: null, signal: request.signal });
    expect(result.ok && result.check.result).toBe('verified');
    expect(store.keys().filter((key) => key.startsWith(`${TENANT}/${lineage}/`))).toEqual([]);
    expect(world.finishes).toHaveLength(1);
  });

  it('checks a connector tombstone with the tenant of the minted scope', async () => {
    const answer = await purge.isPurgeTombstoned(mintScope('personal', OWNER, null), 'conn-1', 'file-1', { signal: new AbortController().signal });
    expect(answer).toEqual({ ok: true, tombstoned: true });
    expect(world.rpc.find((call) => call.fn === 'rag_purge_tombstone_exists')?.args).toEqual({ p_tenant_key: TENANT, p_source_connection_id: 'conn-1', p_source_key: 'file-1' });
  });
});
