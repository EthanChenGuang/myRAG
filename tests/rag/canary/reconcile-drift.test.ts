import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import { reconcileSlice } from '@/lib/rag/sync/reconcile';
import { toPoint, type SyncRow } from '@/lib/rag/sync/servable';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { CANARY_SENTENCE, LEGACY_PROFILE, canaryBackends, createCanaryEnv, isExternalBackend, type CanaryEnv } from './factory';
import { canaryText, ingestCanaryDocument, markerFor } from './seed';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 180_000;
const CASE_TIMEOUT = 120_000;

interface Drift {
  deleted: string;
  overwritten: string;
  foreign: string;
}

function quiet(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

async function storeIdSet(env: CanaryEnv, tenantKey: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page = await env.store!.scanTenant(LEGACY_PROFILE, tenantKey, { after, limit: 500 });
    for (const point of page.points) ids.add(String(point.id).toLowerCase());
    if (!page.next) return ids;
    after = page.next;
  }
}

async function servableRow(env: CanaryEnv, tenantKey: string, chunkId: string): Promise<SyncRow> {
  const response = await env.client
    .rpc('rag_vector_sync_chunk_row', { p_tenant_key: tenantKey, p_chunk_id: chunkId, p_profile_id: LEGACY_PROFILE })
    .abortSignal(new AbortController().signal);
  expect(response.error, 'rag_vector_sync_chunk_row answers').toBeNull();
  const rows = (Array.isArray(response.data) ? response.data : [response.data]) as SyncRow[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function reconcileOnce(env: CanaryEnv) {
  return reconcileSlice({ stores: [env.store!], rpc: env.client, budgetMs: 60_000, trace: false, sink: () => undefined });
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  if (!isExternalBackend(backend)) continue;
  describe.runIf(ENABLED.includes(backend))(`reconcile repairs drift written straight into the store (${backend})`, () => {
    let env: CanaryEnv;
    let servable: string[];
    let drift: Drift;

    beforeAll(async () => {
      quiet();
      env = await createCanaryEnv(backend, 'multi-tenant');
      const a = env.tenants.a!;
      const second = await ingestCanaryDocument(env, {
        scope: a.scope,
        filename: `canary-adrift-${env.nonce}.md`,
        text: canaryText(markerFor(env, 'adrift')),
        uploaderId: a.userId,
      });
      expect(second.status).toBe('ready');
      await env.settle();
      servable = [...a.chunkIds, ...second.chunkIds].map((id) => id.toLowerCase()).sort();
      expect(servable.length).toBeGreaterThanOrEqual(2);
      drift = { deleted: a.chunkIds[0]!.toLowerCase(), overwritten: second.chunkIds[0]!.toLowerCase(), foreign: crypto.randomUUID().toLowerCase() };
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
      vi.restoreAllMocks();
    });

    it('control: after seeding, every tenant is ready and the store holds exactly the servable set', async () => {
      const { reports } = await reconcileOnce(env);
      const own = reports.find((r) => r.tenant_key === env.tenants.a!.tenantKey && r.profile_id === LEGACY_PROFILE);
      expect(own).toMatchObject({ target: backend, missing: 0, stale: 0, extra: 0, state: 'ready' });
      expect(reports.every((r) => r.state === 'ready')).toBe(true);
      expect([...(await storeIdSet(env, env.tenants.a!.tenantKey))].sort()).toEqual(servable);
    }, CASE_TIMEOUT);

    it('detects a deleted point, an overwritten content_hash and a foreign point, and one drain plus a second reconcile repairs them', async () => {
      const a = env.tenants.a!;
      const store = env.store!;
      // Drift injection is the point of this test: direct writes with the write handle, bypassing the outbox.
      expect(await store.deleteIds(LEGACY_PROFILE, a.tenantKey, [drift.deleted])).toBe(1);
      const row = await servableRow(env, a.tenantKey, drift.overwritten);
      const tampered = toPoint(row);
      tampered.payload.content_hash = crypto.createHash('sha256').update(`drift-${env.nonce}`).digest('hex');
      expect(tampered.payload.content_hash).not.toBe(row.content_hash);
      const foreign: VectorPoint = {
        id: drift.foreign,
        vector: env.queryVector(CANARY_SENTENCE),
        payload: { ...tampered.payload, document_id: crypto.randomUUID().toLowerCase(), content_hash: null },
      };
      expect(await store.upsert(LEGACY_PROFILE, a.tenantKey, [tampered, foreign])).toBe(2);

      const before = await storeIdSet(env, a.tenantKey);
      expect(before.has(drift.deleted)).toBe(false);
      expect(before.has(drift.foreign)).toBe(true);

      const first = await reconcileOnce(env);
      const detected = first.reports.find((r) => r.tenant_key === a.tenantKey && r.profile_id === LEGACY_PROFILE);
      expect(detected).toMatchObject({ target: backend, missing: 1, stale: 1, extra: 1, state: 'stale' });
      expect(detected!.repairs_enqueued).toBeGreaterThanOrEqual(3);
      for (const other of first.reports.filter((r) => r.tenant_key !== a.tenantKey)) expect(other.state, `${other.tenant_key} untouched`).toBe('ready');

      await env.drain();
      const second = await reconcileOnce(env);
      const repaired = second.reports.find((r) => r.tenant_key === a.tenantKey && r.profile_id === LEGACY_PROFILE);
      expect(repaired).toMatchObject({ target: backend, missing: 0, stale: 0, extra: 0, state: 'ready' });
      expect(second.reports.every((r) => r.state === 'ready')).toBe(true);

      const after = await storeIdSet(env, a.tenantKey);
      expect([...after].sort()).toEqual(servable);
      const scanned = await store.scanTenant(LEGACY_PROFILE, a.tenantKey, { after: null, limit: 500 });
      const restored = scanned.points.find((point) => String(point.id).toLowerCase() === drift.overwritten);
      expect(restored?.contentHash).toBe(row.content_hash);
    }, CASE_TIMEOUT);
  });
}
