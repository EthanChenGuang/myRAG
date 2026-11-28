import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { drainSlice } from '@/lib/rag/sync/drain';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorPoint, VectorStore } from '@/lib/rag/sync/stores/types';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ACTIVE = 'openai-3-small-1536';
const RETIRED = 'retired-neutral-profile';
const OTHER_KEY = 'u:00000000-0000-4000-8000-0000000000b7';
const ACTOR = 'purge-flow:test';
const REASON = 'lineage_deleted';

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
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
      access_groups: ['all'],
    },
  };
}

async function insertDocument(db: PGlite, mode: DeploymentMode, opts: { lineageId?: string; version?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const userId = mode === 'multi-tenant' ? FIXTURE_USER_ID : null;
  if (opts.lineageId) {
    await db.query(
      "INSERT INTO public.documents (id, filename, content, metadata, user_id, lineage_id, version, is_current) VALUES ($1, $2, 'purge fixture', '{}'::jsonb, $3::uuid, $4, $5, false)",
      [id, `purge-${id}.txt`, userId, opts.lineageId, opts.version ?? 2],
    );
  } else {
    await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'purge fixture', '{}'::jsonb, $3::uuid)", [
      id,
      `purge-${id}.txt`,
      userId,
    ]);
  }
  return id;
}

interface StatusRow {
  target: string;
  state: string;
  collections_checked: number | null;
  points_deleted: string | number | null;
}

async function status(db: PGlite, tenantKey: string, lineageId: string): Promise<Record<string, StatusRow>> {
  const rows = (await db.query<StatusRow>('SELECT * FROM public.rag_vector_sync_purge_status($1, $2::uuid)', [tenantKey, lineageId])).rows;
  return Object.fromEntries(rows.map((r) => [r.target, r]));
}

function ofDocs(store: FakeVectorStore, profileId: string, tenantKey: string, ids: string[]): VectorPoint[] {
  return store.points(profileId, tenantKey).filter((p) => ids.includes(p.payload.document_id));
}

for (const mode of MODES) {
  describe(`vector sync purge drain: a lineage purge leaves no point in any collection (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let client: RpcClient;
    const tenant = tenantFor(mode);

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      edge = await startFakeEdge({ db });
      const env = fixtureProcessEnv(edge.url);
      client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as RpcClient;
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec(
        'UPDATE public.rag_vector_sync_targets SET enabled = false; DELETE FROM public.vector_sync_outbox; DELETE FROM public.rag_backend_index_state; DELETE FROM public.vector_sync_purges;',
      );
    });

    /** Two versions of one lineage for the tenant, points in an active and a retired collection, another tenant's points beside them. */
    async function seed(): Promise<{ store: FakeVectorStore; lineageId: string; ids: string[]; otherDoc: string; seeded: number }> {
      const store = createFakeVectorStore('qdrant');
      await store.ensureCollection({ profileId: ACTIVE, dims: 4 });
      await store.ensureCollection({ profileId: RETIRED, dims: 4 });
      const lineageId = await insertDocument(db, mode);
      const v2 = await insertDocument(db, mode, { lineageId, version: 2 });
      const ids = [lineageId, v2];
      const otherDoc = crypto.randomUUID();
      let seeded = 0;
      for (const profileId of [ACTIVE, RETIRED]) {
        for (const documentId of ids) {
          await store.upsert(profileId, tenant, [point(tenant, documentId, 4), point(tenant, documentId, 4)]);
          seeded += 2;
        }
        // Another tenant's points, one of them naming the same document id: a purge must never reach them.
        await store.upsert(profileId, OTHER_KEY, [point(OTHER_KEY, otherDoc, 4), point(OTHER_KEY, lineageId, 4)]);
      }
      // The purge flow resolves the ids first, then deletes the rows (with every target off here: no document outbox rows).
      await db.query('DELETE FROM public.documents WHERE lineage_id = $1 OR id = $1', [lineageId]);
      await db.query("UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
      return { store, lineageId, ids, otherDoc, seeded };
    }

    async function enqueuePurge(lineageId: string, ids: string[]): Promise<string> {
      const r = await db.query<{ id: string | null }>('SELECT public.rag_vector_sync_enqueue_purge($1, $2::uuid, $3::uuid[], $4, $5) AS id', [
        tenant,
        lineageId,
        ids,
        ACTOR,
        REASON,
      ]);
      const id = r.rows[0]!.id;
      assert.ok(id, 'the purge was enqueued');
      return id;
    }

    test('one drainSlice deletes every point of both versions from every collection, keeps the other tenant, and reports done', async () => {
      const { store, lineageId, ids, otherDoc, seeded } = await seed();
      const purgeId = await enqueuePurge(lineageId, ids);
      const outbox = (await db.query<{ entity: string; entity_id: string }>('SELECT entity, entity_id FROM public.vector_sync_outbox')).rows;
      assert.deepEqual(outbox, [{ entity: 'purge', entity_id: purgeId }]);

      const lines: string[] = [];
      const report = await drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100, sink: (line) => lines.push(line), trace: false });
      assert.equal(report.failed, 0);
      assert.equal(report.claimed, 1);
      assert.equal(report.deleted, seeded);

      for (const profileId of [ACTIVE, RETIRED]) {
        assert.equal(ofDocs(store, profileId, tenant, ids).length, 0, `no point of the lineage is left in ${profileId}`);
        const other = store.points(profileId, OTHER_KEY).map((p) => p.payload.document_id).sort();
        assert.deepEqual(other, [lineageId, otherDoc].sort(), `the other tenant keeps its points in ${profileId}`);
      }

      const st = await status(db, tenant, lineageId);
      assert.equal(st.qdrant!.state, 'done');
      assert.equal(st.qdrant!.collections_checked, 2);
      assert.equal(Number(st.qdrant!.points_deleted), seeded);
      const done = (await db.query<{ status: string }>("SELECT status FROM public.vector_sync_outbox WHERE entity = 'purge'")).rows;
      assert.deepEqual(done, [{ status: 'done' }]);

      assert.equal(lines.length, 1);
      for (const secret of [purgeId, lineageId, ...ids, tenant, OTHER_KEY]) assert.ok(!lines[0]!.includes(secret), 'the slice line carries counts only');
    });

    test('purge_incomplete: a store that silently keeps a point fails the row and the status stays pending', async () => {
      const { store, lineageId, ids } = await seed();
      const leaky: VectorStore = {
        ...store,
        async deleteDocuments(collection: string, tenantKey: string, documentIds: string[]): Promise<number> {
          const kept = ofDocs(store, ACTIVE, tenantKey, documentIds)[0];
          const n = await store.deleteDocuments(collection, tenantKey, documentIds);
          if (kept && collection.endsWith(ACTIVE)) store.plant(ACTIVE, tenantKey, kept);
          return kept && collection.endsWith(ACTIVE) ? n - 1 : n;
        },
      };
      const purgeId = await enqueuePurge(lineageId, ids);
      const report = await drainSlice({ store: leaky, rpc: client, budgetMs: 30_000, batch: 100, sink: () => undefined, trace: false });
      assert.equal(report.failed, 1);
      const row = (await db.query<{ status: string; last_error: string | null }>(
        "SELECT status, last_error FROM public.vector_sync_outbox WHERE entity = 'purge' AND entity_id = $1",
        [purgeId],
      )).rows;
      assert.equal(row.length, 1);
      assert.equal(row[0]!.status, 'pending');
      assert.equal(row[0]!.last_error, 'purge_incomplete');
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'pending');
      assert.equal(ofDocs(store, ACTIVE, tenant, ids).length, 1, 'the kept point is still there');
    });
  });
}
