import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { drainSlice } from '@/lib/rag/sync/drain';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION_0705 = path.join(REPO_ROOT, 'supabase/migrations/0705_vector_sync_reads.sql');
const MIGRATION_0742 = path.join(REPO_ROOT, 'supabase/migrations/0742_vector_sync_access_groups.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const PROFILE = 'openai-3-small-1536';
const HALFVEC = 'voyage-4-large-1024';
/** Fixed fixture uuids of a group and a user of tenant A, and a group of tenant B. */
const GA = '0a000000-0000-4000-8000-00000000a701';
const UA = '0a000000-0000-4000-8000-00000000a702';
const GB = '0b000000-0000-4000-8000-00000000b701';
const PAYLOAD_FIELDS = [
  'access_groups',
  'chunking_profile_id',
  'content_hash',
  'doc_date',
  'doc_type',
  'document_id',
  'language',
  'lexical_text',
  'lexical_version',
  'parent_id',
  'source',
  'tenant_key',
].sort();
const VALIDATE_SQL = 'SELECT chunk_id::text AS id FROM rag_validate_chunks($1, $2::uuid[], $3) ORDER BY 1';
const VALIDATE_GROUPS_SQL = 'SELECT chunk_id::text AS id FROM rag_validate_chunks_for_groups($1, $2::uuid[], $3, $4::text[]) ORDER BY 1';

interface Tenant {
  key: string;
  userId: string | null;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { code: codeOf(error), message: error instanceof Error ? error.message : String(error) };
  }
}

async function outboxCount(db: PGlite): Promise<number> {
  return Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.vector_sync_outbox')).rows[0]?.n);
}

async function pendingRows(db: PGlite, entity: string, entityId?: string): Promise<Array<{ entity_id: string; tenant_key: string | null }>> {
  const r = await db.query<{ entity_id: string; tenant_key: string | null }>(
    `SELECT entity_id, tenant_key FROM public.vector_sync_outbox
      WHERE target = 'qdrant' AND entity = $1 AND status = 'pending' AND ($2::text IS NULL OR entity_id = $2)
      ORDER BY entity_id`,
    [entity, entityId ?? null],
  );
  return r.rows;
}

/** The catalog shape 0742 owns: function bodies, grants and triggers. */
async function catalog(db: PGlite): Promise<string> {
  const fns = await db.query<{ def: string; acl: string | null }>(
    `SELECT pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('rag_vector_sync_document_rows', 'rag_vector_sync_chunk_row', 'rag_validate_chunks_for_groups',
        'rag_vector_sync_documents_access_groups', 'rag_vector_sync_chunks_access_groups')
      ORDER BY p.proname`,
  );
  const triggers = await db.query<{ t: string }>(
    `SELECT tgrelid::regclass::text || ':' || tgname || ':' || pg_get_triggerdef(oid) AS t FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE 'rag_vector_sync_%' ORDER BY 1`,
  );
  return JSON.stringify({ fns: fns.rows, triggers: triggers.rows.map((row) => row.t) });
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

for (const mode of MODES) {
  describe(`vector sync access groups 0742 (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let client: RpcClient;
    let store: FakeVectorStore;
    let a: Tenant;
    let b: Tenant | null = null;
    let docId: string;

    async function insertDoc(tenant: Tenant, groups: string[], opts: { docType?: string } = {}): Promise<string> {
      const id = crypto.randomUUID();
      const filename = `access-sync-${id}.md`;
      if (mode === 'multi-tenant') {
        await db.query(
          `INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type, access_groups)
           VALUES ($1, $2, 'access sync fixture', $3, true, 'ready', $4, $5::text[])`,
          [id, filename, tenant.userId, opts.docType ?? 'general', groups],
        );
      } else {
        await db.query(
          `INSERT INTO documents (id, filename, content, is_current, status, doc_type, access_groups)
           VALUES ($1, $2, 'access sync fixture', true, 'ready', $3, $4::text[])`,
          [id, filename, opts.docType ?? 'general', groups],
        );
      }
      return id;
    }

    async function insertChunks(id: string, tenant: Tenant, n: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const chunkId = crypto.randomUUID();
        const body = `neutral synthetic sentence ${chunkId}`;
        await db.query(
          `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, embedding, lexical_text, tenant_key, doc_type, is_current, status,
                                        chunking_profile_id, chunk_kind)
           VALUES ($1, $2, $3, '{}'::jsonb, $4, $5::vector, $3, $6, 'general', true, 'ready', 'legacy', 'text')`,
          [chunkId, id, body, i, vec(body), tenant.key],
        );
        ids.push(chunkId);
      }
      return ids.sort();
    }

    async function drainUntilEmpty(): Promise<void> {
      for (let i = 0; i < 50; i += 1) {
        const report = await drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100 });
        assert.equal(report.failed, 0, 'no drain row fails');
        if (report.claimed === 0) return;
      }
      assert.fail('the outbox did not drain');
    }

    function pointsOf(id: string): VectorPoint[] {
      return store
        .points(PROFILE, a.key)
        .filter((point) => point.payload.document_id === id)
        .sort((x, y) => (x.id < y.id ? -1 : 1));
    }

    async function setTarget(enabled: boolean): Promise<void> {
      await db.query("UPDATE public.rag_vector_sync_targets SET enabled = $1 WHERE target = 'qdrant'", [enabled]);
    }

    before(async () => {
      if (mode === 'multi-tenant') {
        db = (await createTwoTenantDatabase()).db;
        a = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
        b = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };
      } else {
        db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS })).db;
        a = { key: 's:default', userId: null };
      }
      edge = await startFakeEdge({ db });
      const env = fixtureProcessEnv(edge.url);
      client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as RpcClient;
      store = createFakeVectorStore('qdrant');
      const enabled = await client
        .rpc('rag_vector_sync_set_target', { p_target: 'qdrant', p_enabled: true, p_actor: 'access-groups-test' })
        .abortSignal(new AbortController().signal);
      assert.equal(enabled.error, null);
      await drainUntilEmpty();
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    test('a document published with a group reaches the store with that group in the payload, and only the D-03 fields plus access_groups', async () => {
      docId = await insertDoc(a, [`g:${GA}`]);
      const chunkIds = await insertChunks(docId, a, 2);
      assert.ok((await pendingRows(db, 'document', docId)).length >= 1, 'the write enqueued the document');
      await drainUntilEmpty();
      const points = pointsOf(docId);
      assert.deepEqual(
        points.map((point) => point.id),
        chunkIds,
      );
      for (const point of points) {
        assert.deepEqual(Object.keys(point.payload).sort(), PAYLOAD_FIELDS);
        assert.deepEqual(point.payload.access_groups, [`g:${GA}`]);
      }
    });

    test('a group change enqueues one document row and the next drain rewrites only access_groups', async () => {
      const before = pointsOf(docId);
      assert.equal((await pendingRows(db, 'document', docId)).length, 0);
      await db.query("UPDATE public.documents SET access_groups = '{all}' WHERE id = $1", [docId]);
      const rows = await pendingRows(db, 'document', docId);
      assert.equal(rows.length, 1, 'one document row for the group change');
      assert.equal(rows[0]!.tenant_key, a.key);
      await drainUntilEmpty();
      const afterChange = pointsOf(docId);
      assert.equal(afterChange.length, before.length);
      for (let i = 0; i < afterChange.length; i += 1) {
        assert.deepEqual(afterChange[i]!.payload.access_groups, ['all']);
        const { access_groups: _was, ...restBefore } = before[i]!.payload;
        const { access_groups: _now, ...restAfter } = afterChange[i]!.payload;
        assert.deepEqual(restAfter, restBefore, 'nothing else in the payload changes');
        assert.deepEqual(afterChange[i]!.vector, before[i]!.vector);
      }
    });

    test('a group change with every target disabled enqueues nothing', async () => {
      await setTarget(false);
      try {
        const count = await outboxCount(db);
        await db.query(`UPDATE public.documents SET access_groups = ARRAY['g:${GA}'] WHERE id = $1`, [docId]);
        assert.equal(await outboxCount(db), count);
        await db.query("UPDATE public.documents SET access_groups = '{all}' WHERE id = $1", [docId]);
      } finally {
        await setTarget(true);
      }
    });

    test('an update that changes no label enqueues nothing through the group triggers', async () => {
      const count = await outboxCount(db);
      await db.query("UPDATE public.documents SET filename = filename || '-renamed' WHERE id = $1", [docId]);
      await db.query("UPDATE public.document_chunks SET metadata = '{\"note\":1}'::jsonb WHERE document_id = $1", [docId]);
      assert.equal(await outboxCount(db), count);
    });

    test('re-applying 0742 enqueues nothing and leaves the catalog unchanged', async () => {
      await drainUntilEmpty();
      const shape = await catalog(db);
      const count = await outboxCount(db);
      await db.exec(fs.readFileSync(MIGRATION_0742, 'utf8'));
      assert.equal(await outboxCount(db), count);
      assert.equal(await catalog(db), shape);
    });

    test('a default install (no target enabled) gets no row when 0742 replaces the 0705 reads', async () => {
      await setTarget(false);
      try {
        await db.exec(fs.readFileSync(MIGRATION_0705, 'utf8'));
        const count = await outboxCount(db);
        await db.exec(fs.readFileSync(MIGRATION_0742, 'utf8'));
        assert.equal(await outboxCount(db), count);
      } finally {
        await setTarget(true);
      }
    });

    test('replacing the 0705 reads enqueues one tenant row per enabled target and tenant with index state, once', async () => {
      await drainUntilEmpty();
      await db.exec(fs.readFileSync(MIGRATION_0705, 'utf8'));
      await db.exec(fs.readFileSync(MIGRATION_0742, 'utf8'));
      const expected = (
        await db.query<{ k: string }>("SELECT DISTINCT tenant_key AS k FROM public.rag_backend_index_state WHERE target = 'qdrant' ORDER BY 1")
      ).rows.map((row) => row.k);
      assert.ok(expected.includes(a.key));
      assert.deepEqual(
        (await pendingRows(db, 'tenant')).map((row) => row.entity_id),
        expected,
      );
      await drainUntilEmpty();
      const count = await outboxCount(db);
      await db.exec(fs.readFileSync(MIGRATION_0742, 'utf8'));
      assert.equal(await outboxCount(db), count, 'a re-run enqueues nothing');
      for (const point of pointsOf(docId)) assert.deepEqual(point.payload.access_groups, ['all']);
    });

    describe('rag_validate_chunks_for_groups', () => {
      const ids: Record<string, string[]> = {};

      before(async () => {
        const docGroup = await insertDoc(a, [`g:${GA}`]);
        ids.group = await insertChunks(docGroup, a, 1);
        const docAll = await insertDoc(a, ['all']);
        ids.all = await insertChunks(docAll, a, 1);
        const docUser = await insertDoc(a, [`u:${UA}`]);
        ids.user = await insertChunks(docUser, a, 1);
        if (b) {
          const docB = await insertDoc(b, ['all']);
          ids.foreign = await insertChunks(docB, b, 1);
          const docBGroup = await insertDoc(b, [`g:${GB}`]);
          ids.foreignGroup = await insertChunks(docBGroup, b, 1);
        } else {
          ids.foreign = [];
          ids.foreignGroup = [];
        }
      });

      function every(): string[] {
        return [...ids.group, ...ids.all, ...ids.user, ...ids.foreign, ...ids.foreignGroup];
      }

      async function validateGroups(key: string, chunkIds: string[], groups: string[] | null, profile = PROFILE): Promise<string[]> {
        return (await db.query<{ id: string }>(VALIDATE_GROUPS_SQL, [key, chunkIds, profile, groups])).rows.map((row) => row.id);
      }

      test("chunks outside the caller's groups are not returned", async () => {
        assert.deepEqual(await validateGroups(a.key, every(), ['all']), [...ids.all].sort());
        assert.deepEqual(await validateGroups(a.key, every(), ['all', `g:${GA}`]), [...ids.group, ...ids.all].sort());
        assert.deepEqual(await validateGroups(a.key, every(), [`u:${UA}`]), [...ids.user].sort());
        assert.deepEqual(await validateGroups(a.key, every(), [`g:${GB}`]), []);
      });

      test('ids of another tenant are never returned, whatever the groups', async () => {
        const groups = ['all', `g:${GA}`, `u:${UA}`, `g:${GB}`];
        const returned = await validateGroups(a.key, every(), groups);
        for (const id of [...ids.foreign, ...ids.foreignGroup]) assert.ok(!returned.includes(id));
        if (b) {
          const fromB = await validateGroups(b.key, every(), groups);
          assert.deepEqual(fromB, [...ids.foreign, ...ids.foreignGroup].sort());
        }
      });

      test('NULL and empty groups raise 22023; more than 500 ids raise; malformed and other-mode keys raise', async () => {
        assert.equal((await errorOf(db, VALIDATE_GROUPS_SQL, [a.key, every(), PROFILE, null]))?.code, '22023');
        assert.equal((await errorOf(db, VALIDATE_GROUPS_SQL, [a.key, every(), PROFILE, []]))?.code, '22023');
        const many = Array.from({ length: 501 }, () => crypto.randomUUID());
        assert.equal((await errorOf(db, VALIDATE_GROUPS_SQL, [a.key, many, PROFILE, ['all']]))?.code, '22023');
        assert.notEqual(await errorOf(db, VALIDATE_GROUPS_SQL, ['not-a-key', every(), PROFILE, ['all']]), null);
        const otherMode = mode === 'multi-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;
        assert.notEqual(await errorOf(db, VALIDATE_GROUPS_SQL, [otherMode, every(), PROFILE, ['all']]), null);
        assert.equal((await errorOf(db, VALIDATE_GROUPS_SQL, [a.key, every(), 'no-such-profile', ['all']]))?.code, '22023');
      });

      test('anon and authenticated get 42501; service_role succeeds', async () => {
        for (const role of ['anon', 'authenticated']) {
          await db.exec(`SET ROLE ${role}`);
          try {
            assert.equal((await errorOf(db, VALIDATE_GROUPS_SQL, [a.key, every(), PROFILE, ['all']]))?.code, '42501', role);
          } finally {
            await db.exec('RESET ROLE');
          }
        }
        await db.exec('SET ROLE service_role');
        try {
          assert.deepEqual(await validateGroups(a.key, every(), ['all']), [...ids.all].sort());
        } finally {
          await db.exec('RESET ROLE');
        }
      });

      test('parity: with all and every group of the fixture the result equals rag_validate_chunks', async () => {
        for (const tenant of b ? [a, b] : [a]) {
          const groups = ['all', `g:${GA}`, `u:${UA}`, `g:${GB}`];
          const plain = (await db.query<{ id: string }>(VALIDATE_SQL, [tenant.key, every(), PROFILE])).rows.map((row) => row.id);
          assert.deepEqual(await validateGroups(tenant.key, every(), groups), plain);
          const plainHalf = (await db.query<{ id: string }>(VALIDATE_SQL, [tenant.key, every(), HALFVEC])).rows.map((row) => row.id);
          assert.deepEqual(await validateGroups(tenant.key, every(), groups, HALFVEC), plainHalf);
        }
      });
    });
  });
}
