import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { reconcileSlice } from '@/lib/rag/sync/reconcile';
import { toPoint, type SyncRow } from '@/lib/rag/sync/servable';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import {
  CANARY_ACTOR,
  CANARY_SENTENCE,
  LEGACY_PROFILE,
  SECOND_PROFILE,
  SECOND_PROFILE_DIMS,
  canaryBackends,
  createCanaryEnv,
  isExternalBackend,
  leaked,
  type CanaryEnv,
} from './factory';
import { canaryText, ingestCanaryDocument, markerFor } from './seed';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 240_000;
const CASE_TIMEOUT = 120_000;
const REASON = 'lineage_deleted';
const PROFILES = [LEGACY_PROFILE, SECOND_PROFILE] as const;

interface Lineage {
  lineageId: string;
  documentIds: string[];
  marker: string;
}

interface StatusRow {
  target: string;
  state: string;
  collections_checked: number | null;
  points_deleted: string | number | null;
}

function silenceLogs(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function fakeSecondProvider(): EmbeddingProvider {
  const vectors = (texts: string[], dims: number | undefined) => texts.map((text) => embedText(text, dims ?? SECOND_PROFILE_DIMS));
  return {
    id: 'voyage',
    model: 'voyage-4-large',
    maxInputTokens: 32_000,
    supportedDims: [SECOND_PROFILE_DIMS],
    normalize: true,
    async embedDocuments(texts, opts) {
      return { vectors: vectors(texts, opts.dims), model: 'voyage-4-large', host: 'canary-fake', usage: { tokens: texts.length } };
    },
    async embedQuery(text, opts) {
      return { vectors: vectors([text], opts.dims), model: 'voyage-4-large', host: 'canary-fake', usage: { tokens: 1 } };
    },
  };
}

/** Two versions of one lineage of tenant a: the same file written twice with different text. */
async function seedLineage(env: CanaryEnv, label: string): Promise<Lineage> {
  const a = env.tenants.a!;
  const marker = markerFor(env, label);
  const filename = `canary-${label}-${env.nonce}.md`;
  const first = await ingestCanaryDocument(env, { scope: a.scope, filename, text: canaryText(marker, 'First version.'), uploaderId: a.userId });
  const second = await ingestCanaryDocument(env, { scope: a.scope, filename, text: canaryText(marker, 'Second version with one more line.'), uploaderId: a.userId });
  expect([first.status, second.status]).toEqual(['ready', 'ready']);
  const rows = await env.sql<{ id: string; lineage_id: string }>('SELECT id, lineage_id FROM public.documents WHERE id = ANY($1::uuid[]) ORDER BY id', [
    [first.documentId, second.documentId],
  ]);
  expect(rows).toHaveLength(2);
  const lineageIds = new Set(rows.map((row) => String(row.lineage_id)));
  expect(lineageIds.size, 'both writes are versions of one lineage').toBe(1);
  return { lineageId: [...lineageIds][0]!, documentIds: rows.map((row) => String(row.id).toLowerCase()).sort(), marker };
}

/** Points of the given documents in one tenant over every chunk collection the live store lists. */
async function lineagePoints(env: CanaryEnv, tenantKey: string, documentIds: string[]): Promise<number> {
  let total = 0;
  for (const collection of await env.store!.listCollections()) total += await env.store!.countDocumentPoints(collection, tenantKey, documentIds);
  return total;
}

async function pointsPerProfile(env: CanaryEnv, tenantKey: string, documentIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const profile of PROFILES) {
    let n = 0;
    for (const id of documentIds) n += (await env.store!.listDocumentIds(profile, tenantKey, id)).length;
    out[profile] = n;
  }
  return out;
}

/** Tenant b's points (both profiles) and its search hits: what a purge of tenant a must leave as it was. */
async function tenantBSnapshot(env: CanaryEnv): Promise<{ points: Record<string, string[]>; hits: string[] }> {
  const b = env.tenants.b!;
  const points: Record<string, string[]> = {};
  for (const profile of PROFILES) points[profile] = (await env.store!.listDocumentIds(profile, b.tenantKey, b.documentId)).map((id) => id.toLowerCase()).sort();
  const result = await env.search(b.scope, CANARY_SENTENCE);
  return { points, hits: result.hits.map((hit) => `${hit.chunkId}:${hit.content}`).sort() };
}

async function deleteLineage(env: CanaryEnv, lineage: Lineage): Promise<void> {
  await env.sql('DELETE FROM public.documents WHERE lineage_id = $1', [lineage.lineageId]);
  expect(await env.sql('SELECT id FROM public.documents WHERE lineage_id = $1', [lineage.lineageId])).toEqual([]);
}

/** What the Phase 6.3 purge flow does after it deleted the rows (0727 rag_purge_lineage). */
async function enqueuePurge(env: CanaryEnv, lineage: Lineage): Promise<string> {
  const rows = await env.sql<{ id: string | null }>('SELECT public.rag_vector_sync_enqueue_purge($1, $2::uuid, $3::uuid[], $4, $5) AS id', [
    env.tenants.a!.tenantKey,
    lineage.lineageId,
    lineage.documentIds,
    CANARY_ACTOR,
    REASON,
  ]);
  const id = rows[0]?.id ?? null;
  expect(id, 'the purge was enqueued').not.toBeNull();
  return String(id);
}

async function purgeStatus(env: CanaryEnv, lineage: Lineage): Promise<Record<string, StatusRow>> {
  const rows = await env.sql<StatusRow>('SELECT * FROM public.rag_vector_sync_purge_status($1, $2::uuid)', [env.tenants.a!.tenantKey, lineage.lineageId]);
  return Object.fromEntries(rows.map((row) => [row.target, row]));
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

describe.runIf(ENABLED.includes('pgvector'))('purge canary, pgvector leg (no external index)', () => {
  let env: CanaryEnv;

  beforeAll(async () => {
    silenceLogs();
    env = await createCanaryEnv('pgvector', 'multi-tenant');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await env?.close();
    vi.restoreAllMocks();
  });

  beforeEach(silenceLogs);

  it(
    'a request for tenant a returns nothing of the lineage right after its rows are deleted',
    async () => {
      const a = env.tenants.a!;
      const lineage = await seedLineage(env, 'pglin');
      const query = `${CANARY_SENTENCE} ${lineage.marker}`;
      const before = await env.search(a.scope, query);
      expect(leaked(before.hits, [lineage.marker]).length, 'negative control: the lineage is found before the delete').toBeGreaterThan(0);

      await deleteLineage(env, lineage);
      const enqueued = await env.sql<{ id: string | null }>('SELECT public.rag_vector_sync_enqueue_purge($1, $2::uuid, $3::uuid[], $4, $5) AS id', [
        a.tenantKey,
        lineage.lineageId,
        lineage.documentIds,
        CANARY_ACTOR,
        REASON,
      ]);
      expect(enqueued[0]?.id ?? null, 'no external target: nothing to purge outside Supabase').toBeNull();

      const after = await env.search(a.scope, query);
      expect(after.selection.backend).toBe('pgvector');
      expect(leaked(after.hits, [lineage.marker])).toEqual([]);
      expect(after.hits.some((hit) => hit.content.includes(a.marker)), 'the tenant still finds its other document').toBe(true);
    },
    CASE_TIMEOUT,
  );
});

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  if (!isExternalBackend(backend)) continue;
  describe.runIf(ENABLED.includes(backend))(`purge canary, every version in every collection (${backend})`, () => {
    let env: CanaryEnv;
    let enabledLineage: Lineage;
    let disabledLineage: Lineage;

    beforeAll(async () => {
      silenceLogs();
      env = await createCanaryEnv(backend, 'multi-tenant');
      enabledLineage = await seedLineage(env, 'plin');
      disabledLineage = await seedLineage(env, 'pdis');
      await env.settle();
      // A backfilling second profile, so the tenant has points in two collections.
      const [{ runReembed }, registry] = await Promise.all([import('@/lib/rag/ingest/reembed/run'), import('@/lib/rag/embeddings/registry')]);
      registry.setEmbeddingProvidersForTests({ voyage: fakeSecondProvider() });
      const report = await runReembed({ db: env.client, profileId: SECOND_PROFILE, actor: CANARY_ACTOR, signal: new AbortController().signal });
      expect(report.status, report.reason ?? '').toBe('completed');
      await env.settle();
      expect((await env.store!.listCollections()).length, 'two chunk collections exist').toBeGreaterThanOrEqual(2);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
      vi.restoreAllMocks();
    });

    beforeEach(silenceLogs);

    it(
      'removes every point of the lineage from both profile collections, reports done, and leaves tenant b unchanged',
      async () => {
        const a = env.tenants.a!;
        const perProfile = await pointsPerProfile(env, a.tenantKey, enabledLineage.documentIds);
        for (const profile of PROFILES) expect(perProfile[profile], `negative control: ${profile} holds the lineage before the drain`).toBeGreaterThan(0);
        expect(await lineagePoints(env, a.tenantKey, enabledLineage.documentIds)).toBeGreaterThan(0);
        const bBefore = await tenantBSnapshot(env);
        expect(Object.values(bBefore.points).every((ids) => ids.length > 0), 'tenant b has points in both collections').toBe(true);

        await deleteLineage(env, enabledLineage);
        await enqueuePurge(env, enabledLineage);
        expect((await purgeStatus(env, enabledLineage))[backend]?.state).toBe('pending');

        await env.drain();
        expect(await lineagePoints(env, a.tenantKey, enabledLineage.documentIds), 'no point of any version is left').toBe(0);
        expect(await pointsPerProfile(env, a.tenantKey, enabledLineage.documentIds)).toEqual({ [LEGACY_PROFILE]: 0, [SECOND_PROFILE]: 0 });
        const status = await purgeStatus(env, enabledLineage);
        expect(status[backend]).toMatchObject({ target: backend, state: 'done' });
        for (const [target, row] of Object.entries(status)) {
          if (target !== backend) expect(row.state, `${target} never synced this tenant`).toBe('not_applicable');
        }
        expect(Number(status[backend]!.collections_checked)).toBeGreaterThanOrEqual(2);

        expect(await tenantBSnapshot(env), 'tenant b: same points, same results').toEqual(bBefore);
        const result = await env.search(a.scope, `${CANARY_SENTENCE} ${enabledLineage.marker}`);
        expect(leaked(result.hits, [enabledLineage.marker])).toEqual([]);
      },
      CASE_TIMEOUT,
    );

    it(
      'a purged document written back into the store is found by reconcile, which re-opens the purge; one drain and one reconcile return to ready',
      async () => {
        const a = env.tenants.a!;
        const purgedId = enabledLineage.documentIds[0]!;
        const template = toPoint(await servableRow(env, a.tenantKey, a.chunkIds[0]!));
        const reappeared: VectorPoint = {
          id: crypto.randomUUID().toLowerCase(),
          vector: env.queryVector(CANARY_SENTENCE),
          payload: { ...template.payload, document_id: purgedId, content_hash: null },
        };
        // The drift under test: a direct write with the write handle, bypassing the outbox.
        expect(await env.store!.upsert(LEGACY_PROFILE, a.tenantKey, [reappeared])).toBe(1);
        expect(await lineagePoints(env, a.tenantKey, [purgedId]), 'negative control: the point is back in the store').toBe(1);

        const first = await reconcileOnce(env);
        const own = first.reports.filter((report) => report.tenant_key === a.tenantKey);
        expect(own.length).toBeGreaterThan(0);
        expect(own.every((report) => report.state === 'stale'), 'tenant a is marked stale').toBe(true);
        expect((await purgeStatus(env, enabledLineage))[backend]?.state, 'the purge is re-opened').toBe('pending');
        const states = await env.sql<{ state: string }>('SELECT state FROM public.rag_backend_index_state WHERE target = $1 AND tenant_key = $2', [
          backend,
          a.tenantKey,
        ]);
        expect(states.length).toBeGreaterThan(0);
        expect(states.every((row) => row.state === 'stale')).toBe(true);
        for (const other of first.reports.filter((report) => report.tenant_key !== a.tenantKey)) expect(other.state, `${other.tenant_key} untouched`).toBe('ready');

        await env.drain();
        expect(await lineagePoints(env, a.tenantKey, [purgedId]), 'the drain removes it').toBe(0);
        const second = await reconcileOnce(env);
        expect(second.reports.every((report) => report.state === 'ready'), 'every tenant is ready again').toBe(true);
        expect((await purgeStatus(env, enabledLineage))[backend]?.state).toBe('done');
      },
      CASE_TIMEOUT,
    );

    // Last in the file: it disables the target.
    it(
      'a disabled target that still holds points is purged too and reports done',
      async () => {
        const a = env.tenants.a!;
        const perProfile = await pointsPerProfile(env, a.tenantKey, disabledLineage.documentIds);
        for (const profile of PROFILES) expect(perProfile[profile], `negative control: ${profile} holds the lineage before the drain`).toBeGreaterThan(0);
        const bBefore = await tenantBSnapshot(env);

        await env.sql('SELECT public.rag_vector_sync_set_target($1, false, $2)', [backend, CANARY_ACTOR]);
        await deleteLineage(env, disabledLineage);
        const purgeId = await enqueuePurge(env, disabledLineage);
        const pending = await env.sql<{ entity: string; entity_id: string }>(
          "SELECT entity, entity_id FROM public.vector_sync_outbox WHERE target = $1 AND status = 'pending'",
          [backend],
        );
        expect(pending, 'with the target disabled only the purge row is written, so the purge alone must clear both collections').toEqual([
          { entity: 'purge', entity_id: purgeId },
        ]);
        expect(await pointsPerProfile(env, a.tenantKey, disabledLineage.documentIds)).toEqual(perProfile);

        await env.drain();
        expect(await lineagePoints(env, a.tenantKey, disabledLineage.documentIds)).toBe(0);
        expect(await pointsPerProfile(env, a.tenantKey, disabledLineage.documentIds)).toEqual({ [LEGACY_PROFILE]: 0, [SECOND_PROFILE]: 0 });
        expect((await purgeStatus(env, disabledLineage))[backend]).toMatchObject({ target: backend, state: 'done' });
        const bAfter = await tenantBSnapshot(env);
        expect(bAfter.points, 'tenant b keeps its points').toEqual(bBefore.points);
      },
      CASE_TIMEOUT,
    );
  });
}
