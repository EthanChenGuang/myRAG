import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { drainSlice } from '@/lib/rag/sync/drain';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { MODES, adminActor, createWorld, purge, rows, seedLineage, type PurgeWorld } from '../helpers/purge-fixture.mts';

// RET-05, DATA-24 (07-37 Task 3): the Phase 6.3 purge (rag_purge_lineage, 0727) reaches the Phase 7 outbox through the seam fixed by
// plan 07-35 (rag_vector_sync_enqueue_purge, 0740). Phase 7 does not edit the Phase 6.3 purge flow; this file only checks it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PURGE_SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0727_purge_lineage.sql'), 'utf8');
const SEAM_SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0740_vector_sync_purge.sql'), 'utf8');
const SEAM_ARGS = ['p_tenant_key', 'p_lineage_id', 'p_document_ids', 'p_actor', 'p_reason_code'];
const PROFILE = 'openai-3-small-1536';

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf('AS $$', start);
  const close = sql.indexOf('$$;', open + 5);
  assert.ok(open > start && close > open, `${name} has a body`);
  return sql.slice(start, close);
}

function point(tenantKey: string, documentId: string, dims: number): VectorPoint {
  return {
    id: crypto.randomUUID(),
    vector: Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0)),
    payload: {
      tenant_key: tenantKey,
      document_id: documentId,
      doc_type: 'general',
      doc_date: null,
      language: 'en',
      source: 'upload',
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: 'neutral sample words',
      content_hash: 'h',
      lexical_version: 1,
    },
  };
}

describe('the Phase 6.3 purge calls the 07-35 seam (static)', () => {
  const body = functionBody(PURGE_SQL, 'rag_purge_lineage');

  test('the seam signature names exactly p_tenant_key, p_lineage_id, p_document_ids, p_actor and p_reason_code', () => {
    const seam = SEAM_SQL.match(/CREATE OR REPLACE FUNCTION public\.rag_vector_sync_enqueue_purge\(([\s\S]*?)\)\s*RETURNS/);
    assert.ok(seam, 'rag_vector_sync_enqueue_purge is defined in 0740');
    const names = seam[1]!.split(',').map((part) => part.trim().split(/\s+/)[0]);
    assert.deepEqual(names, SEAM_ARGS);
  });

  test('rag_purge_lineage passes the five arguments in signature order, the tenant key from its own checked argument', () => {
    const call = body.match(
      /EXECUTE 'SELECT public\.rag_vector_sync_enqueue_purge\(\$1, \$2, \$3, \$4, \$5\)'\s+USING\s+([^;]+);/,
    );
    assert.ok(call, 'the seam is called with five positional arguments');
    const using = call[1]!.split(',').map((part) => part.trim());
    assert.equal(using.length, 5);
    // $1 → p_tenant_key, $2 → p_lineage_id, $3 → p_document_ids, $4 → p_actor, $5 → p_reason_code.
    assert.equal(using[0], 'p_tenant_key');
    assert.equal(using[1], 'p_lineage_id');
    assert.equal(using[2], 'v_ids');
    assert.match(using[3]!, /^v_actor_kind \|\| ':' \|\| v_actor_id::text$/);
    assert.equal(using[4], 'v_reason_code');
    // The tenant key is asserted first and the lineage lock is tenant-scoped; nothing comes from a request body.
    const guard = body.search(/PERFORM public\.rag_(?:ingest_)?assert_tenant_key\(p_tenant_key\)/);
    assert.ok(guard >= 0, 'the tenant guard runs');
    assert.ok(guard < body.indexOf('rag_vector_sync_enqueue_purge'));
    assert.match(body, /WHERE d\.lineage_id = p_lineage_id AND d\.tenant_key = p_tenant_key[\s\S]*FOR UPDATE/);
  });

  test('the call runs after the version ids are resolved and before any row is deleted', () => {
    const resolved = body.indexOf('INTO v_ids');
    const seam = body.indexOf('rag_vector_sync_enqueue_purge');
    const firstDelete = body.indexOf('DELETE FROM');
    assert.ok(resolved > 0 && seam > resolved, 'v_ids is resolved first');
    assert.ok(firstDelete > seam, 'no delete runs before the seam');
  });
});

for (const mode of MODES) {
  describe(`the Phase 6.3 purge reaches the outbox and the store (${mode})`, () => {
    let world: PurgeWorld;
    let edge: FakeEdge;
    let client: RpcClient;

    before(async () => {
      world = await createWorld(mode);
      edge = await startFakeEdge({ db: world.db });
      const env = fixtureProcessEnv(edge.url);
      client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as RpcClient;
    });

    after(async () => {
      await edge?.close();
      await world?.db.close();
    });

    beforeEach(async () => {
      await world.db.exec(
        'UPDATE public.rag_vector_sync_targets SET enabled = false; DELETE FROM public.vector_sync_outbox; DELETE FROM public.vector_sync_purges; DELETE FROM public.rag_backend_index_state;',
      );
    });

    async function seedPoints(store: FakeVectorStore, tenantKey: string, ids: string[]): Promise<number> {
      // A collection for every embedding profile, so the document rows the deletes enqueue drain as well.
      let dims = 0;
      for (const row of await rows(world.db, 'SELECT id, dims FROM public.embedding_profiles')) {
        await store.ensureCollection({ profileId: String(row.id), dims: Number(row.dims) });
        if (row.id === PROFILE) dims = Number(row.dims);
      }
      let seeded = 0;
      for (const documentId of ids) {
        await store.upsert(PROFILE, tenantKey, [point(tenantKey, documentId, dims), point(tenantKey, documentId, dims)]);
        seeded += 2;
      }
      return seeded;
    }

    test('qdrant enabled: one purge ledger row with both versions, one purge outbox row, one drain removes every point and status is done', async () => {
      await world.db.query("UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
      const seeded = await seedLineage(world, world.tenantA);
      assert.equal(seeded.versionIds.length, 2);
      const store = createFakeVectorStore('qdrant');
      await seedPoints(store, world.tenantA.key, seeded.versionIds);
      const otherKey = world.tenantB?.key ?? null;
      if (otherKey) await seedPoints(store, otherKey, [seeded.lineageId]);
      await world.db.exec('DELETE FROM public.vector_sync_outbox');

      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));

      const ledger = await rows(world.db, 'SELECT id, tenant_key, lineage_id, document_ids FROM public.vector_sync_purges');
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.tenant_key, world.tenantA.key);
      assert.equal(ledger[0]!.lineage_id, seeded.lineageId);
      assert.deepEqual([...(ledger[0]!.document_ids as string[])].sort(), [...seeded.versionIds].sort());
      const purgeRows = await rows(world.db, "SELECT target, status FROM public.vector_sync_outbox WHERE entity = 'purge' AND entity_id = $1", [
        String(ledger[0]!.id),
      ]);
      assert.deepEqual(purgeRows, [{ target: 'qdrant', status: 'pending' }]);

      const report = await drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100, sink: () => undefined, trace: false });
      assert.equal(report.failed, 0);
      assert.deepEqual(await rows(world.db, "SELECT entity, status FROM public.vector_sync_outbox WHERE status <> 'done'"), []);
      const left = store.points(PROFILE, world.tenantA.key).filter((p) => seeded.versionIds.includes(p.payload.document_id));
      assert.equal(left.length, 0, 'no point of either version is left');
      if (otherKey) assert.equal(store.points(PROFILE, otherKey).length, 2, 'the other tenant keeps its points');

      const status = await rows(world.db, 'SELECT target, state FROM public.rag_vector_sync_purge_status($1, $2::uuid)', [
        world.tenantA.key,
        seeded.lineageId,
      ]);
      assert.deepEqual(status.find((row) => row.target === 'qdrant')?.state, 'done');
    });

    test('no target enabled and no index state: the purge writes no Phase 7 row', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      await world.db.exec('DELETE FROM public.vector_sync_outbox');
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.deepEqual(await rows(world.db, 'SELECT id FROM public.vector_sync_purges'), []);
      assert.deepEqual(await rows(world.db, 'SELECT id FROM public.vector_sync_outbox'), []);
    });
  });
}
