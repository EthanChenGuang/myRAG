import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION = 'supabase/migrations/0707_vector_sync_reconcile.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY = 'openai-3-small-1536';
const HALFVEC = 'voyage-4-large-1024';

/** Golden ids shared with tests/rag/sync/reconcile.test.ts: bucket and signed 64-bit hash of md5(id). */
const GOLDEN_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '7f3c2a10-1b2c-4d5e-8f60-0123456789ab',
] as const;
const ZERO = BigInt(0);
const GOLDEN_BUCKETS = [5, 25, 60];
const GOLDEN_HASHES = ['5016017787118691403', '-7398545041996669218', '4332796155272647876'];

function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

function bucketOf(id: string): number {
  return parseInt(md5(id).slice(0, 2), 16) % 64;
}

function hash64(hex: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`));
}

function contentHash64(id: string, contentHash: string | null, lexicalVersion: number | null): bigint {
  return hash64(md5(`${id}:${contentHash ?? ''}:${lexicalVersion === null ? '' : String(lexicalVersion)}`));
}

interface Tenant {
  key: string;
  userId: string | null;
}

interface SummaryRow {
  bucket: number;
  row_count: string | number;
  id_xor: string;
  content_xor: string;
}

interface BucketRow {
  chunk_id: string;
  document_id: string;
  content_hash: string | null;
  lexical_version: number | null;
}

const FUNCTIONS: Array<{ sql: string; params: (key: string) => unknown[] }> = [
  { sql: 'SELECT * FROM rag_vector_sync_reconcile_summary($1, $2)', params: (key) => [key, LEGACY] },
  { sql: 'SELECT * FROM rag_vector_sync_bucket_rows($1, $2, 0, NULL, 10)', params: (key) => [key, LEGACY] },
  { sql: "SELECT * FROM rag_vector_sync_tenants('qdrant', $1)", params: () => [LEGACY] },
  { sql: "SELECT rag_vector_sync_enqueue_repair('qdrant', 'tenant', $1, $1, NULL)", params: (key) => [key] },
  { sql: "SELECT rag_set_backend_index_state('qdrant', $2, $1, 'ready', 0, 0, NULL)", params: (key) => [key, LEGACY] },
  { sql: 'SELECT rag_vector_sync_prune(7)', params: () => [] },
];

async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) };
  }
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function halfvec(seed: number): string {
  return `[${Array.from({ length: 1024 }, (_, i) => (((i * 31 + seed) % 97) / 97).toFixed(4)).join(',')}]`;
}

for (const mode of MODES) {
  describe(`vector sync reconcile RPCs 0707 (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null = null;
    let docA: string;
    const own: string[] = [];

    async function insertDoc(tenant: Tenant, opts: { status?: string } = {}): Promise<string> {
      const id = crypto.randomUUID();
      if (mode === 'multi-tenant') {
        await db.query('INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type) VALUES ($1, $2, $3, $4, true, $5, $6)', [
          id,
          `reconcile-${id}.md`,
          'reconcile fixture',
          tenant.userId,
          opts.status ?? 'ready',
          'general',
        ]);
      } else {
        await db.query('INSERT INTO documents (id, filename, content, is_current, status, doc_type) VALUES ($1, $2, $3, true, $4, $5)', [
          id,
          `reconcile-${id}.md`,
          'reconcile fixture',
          opts.status ?? 'ready',
          'general',
        ]);
      }
      return id;
    }

    async function insertChunk(docId: string, tenant: Tenant, opts: { id?: string; status?: string; embedding?: boolean } = {}): Promise<string> {
      const id = opts.id ?? crypto.randomUUID();
      const body = `reconcile synthetic sentence ${id}`;
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, embedding, lexical_text, tenant_key, doc_type, is_current, status,
                                      chunking_profile_id, chunk_kind, content_hash)
         VALUES ($1, $2, $3, '{}'::jsonb, 0, $4::vector, $3, $5, 'general', true, $6, 'legacy', 'text', $7)`,
        [id, docId, body, opts.embedding === false ? null : vec(body), tenant.key, opts.status ?? 'ready', md5(body)],
      );
      return id;
    }

    async function summary(key: string, profile = LEGACY): Promise<SummaryRow[]> {
      return (await db.query<SummaryRow>('SELECT * FROM rag_vector_sync_reconcile_summary($1, $2)', [key, profile])).rows;
    }

    async function bucketRows(key: string, bucket: number, profile = LEGACY): Promise<BucketRow[]> {
      const out: BucketRow[] = [];
      let after: string | null = null;
      for (;;) {
        const page: BucketRow[] = (
          await db.query<BucketRow>('SELECT chunk_id::text, document_id::text, content_hash, lexical_version FROM rag_vector_sync_bucket_rows($1, $2, $3, $4, 2)', [
            key,
            profile,
            bucket,
            after,
          ])
        ).rows;
        out.push(...page);
        if (page.length < 2) return out;
        after = page[page.length - 1]!.chunk_id;
      }
    }

    async function servableCount(key: string): Promise<number> {
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM rag_servable_chunks s JOIN document_chunks c ON c.id = s.chunk_id
          WHERE s.tenant_key = $1 AND c.embedding IS NOT NULL`,
        [key],
      );
      return Number(r.rows[0]?.n);
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
      docA = await insertDoc(a);
      for (const id of GOLDEN_IDS) own.push(await insertChunk(docA, a, { id }));
      own.push(await insertChunk(docA, a));
      await insertChunk(docA, a, { embedding: false });
      const quarantined = await insertDoc(a, { status: 'quarantined' });
      await insertChunk(quarantined, a, { status: 'quarantined' });
      if (b) {
        const docB = await insertDoc(b);
        await insertChunk(docB, b);
      }
    });

    after(async () => {
      await db?.close();
    });

    test('summary returns 64 buckets whose counts add up to the servable vector-holding rows of the tenant only', async () => {
      const rows = await summary(a.key);
      assert.deepEqual(
        rows.map((row) => row.bucket),
        Array.from({ length: 64 }, (_, i) => i),
      );
      const total = rows.reduce((sum, row) => sum + Number(row.row_count), 0);
      assert.equal(total, await servableCount(a.key));
      assert.ok(total >= own.length);
      for (const row of rows) if (Number(row.row_count) === 0) assert.equal(row.id_xor, '0');
    });

    test('the hash definition: a bucket recomputed from its listed ids gives the same id_xor and content_xor', async () => {
      const rows = await summary(a.key);
      const bucket = bucketOf(GOLDEN_IDS[2]);
      const listed = await bucketRows(a.key, bucket);
      assert.ok(listed.some((row) => row.chunk_id === GOLDEN_IDS[2]), 'the golden id is listed in its bucket');
      assert.equal(listed.length, Number(rows[bucket]!.row_count));
      let idXor = ZERO;
      let contentXor = ZERO;
      for (const row of listed) {
        assert.equal(bucketOf(row.chunk_id), bucket);
        idXor ^= hash64(md5(row.chunk_id));
        contentXor ^= contentHash64(row.chunk_id, row.content_hash, row.lexical_version);
      }
      assert.equal(rows[bucket]!.id_xor, BigInt.asIntN(64, idXor).toString());
      assert.equal(rows[bucket]!.content_xor, BigInt.asIntN(64, contentXor).toString());
    });

    test('golden ids land in their golden buckets', async () => {
      for (const id of GOLDEN_IDS) {
        const listed = await bucketRows(a.key, bucketOf(id));
        assert.ok(listed.some((row) => row.chunk_id === id), id);
      }
      assert.deepEqual(
        GOLDEN_IDS.map((id) => bucketOf(id)),
        GOLDEN_BUCKETS,
      );
      assert.deepEqual(
        GOLDEN_IDS.map((id) => hash64(md5(id)).toString()),
        GOLDEN_HASHES,
      );
      // The SQL hash of one golden id, isolated: the bucket's XOR with every other listed id taken out.
      const bucket = GOLDEN_BUCKETS[2]!;
      const listed = await bucketRows(a.key, bucket);
      let others = ZERO;
      for (const row of listed) if (row.chunk_id !== GOLDEN_IDS[2]) others ^= hash64(md5(row.chunk_id));
      const sqlXor = BigInt((await summary(a.key))[bucket]!.id_xor);
      assert.equal(BigInt.asIntN(64, sqlXor ^ others).toString(), GOLDEN_HASHES[2]);
    });

    test('a content_hash or lexical_version change moves only content_xor of that bucket', async () => {
      const id = GOLDEN_IDS[0];
      const bucket = bucketOf(id);
      const before = (await summary(a.key))[bucket]!;
      await db.query("UPDATE document_chunks SET content_hash = 'changed-hash' WHERE id = $1", [id]);
      const afterHash = (await summary(a.key))[bucket]!;
      assert.equal(afterHash.id_xor, before.id_xor);
      assert.notEqual(afterHash.content_xor, before.content_xor);
      await db.query('UPDATE document_chunks SET lexical_version = coalesce(lexical_version, 0) + 1 WHERE id = $1', [id]);
      const afterVersion = (await summary(a.key))[bucket]!;
      assert.notEqual(afterVersion.content_xor, afterHash.content_xor);
    });

    test('foreign rows: another tenant\'s chunks are never counted or listed', { skip: mode === 'single-tenant' }, async () => {
      assert.ok(b);
      const foreign = (await db.query<{ id: string }>('SELECT id::text FROM document_chunks WHERE tenant_key = $1', [b.key])).rows.map((r) => r.id);
      assert.ok(foreign.length > 0);
      for (const id of foreign) {
        const listed = await bucketRows(a.key, bucketOf(id));
        assert.equal(listed.some((row) => row.chunk_id === id), false);
      }
      const totalB = (await summary(b.key)).reduce((sum, row) => sum + Number(row.row_count), 0);
      assert.equal(totalB, await servableCount(b.key));
    });

    test('halfvec profile: only chunks with a chunk_embeddings row of that profile are counted', async () => {
      const before = (await summary(a.key, HALFVEC)).reduce((sum, row) => sum + Number(row.row_count), 0);
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         VALUES ($1, $2, $3, $4::halfvec, 'voyage-4-large', 1024)`,
        [GOLDEN_IDS[1], HALFVEC, a.key, halfvec(7)],
      );
      const afterRows = await summary(a.key, HALFVEC);
      assert.equal(afterRows.reduce((sum, row) => sum + Number(row.row_count), 0), before + 1);
      const listed = await bucketRows(a.key, bucketOf(GOLDEN_IDS[1]), HALFVEC);
      assert.ok(listed.some((row) => row.chunk_id === GOLDEN_IDS[1]));
    });

    test('argument checks: malformed or wrong-mode tenant key, unknown profile, bucket and limit out of range are 22023', async () => {
      const wrongMode = mode === 'multi-tenant' ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;
      for (const key of ['U:NOT-A-KEY', wrongMode]) {
        assert.equal((await errorOf(db, 'SELECT * FROM rag_vector_sync_reconcile_summary($1, $2)', [key, LEGACY]))?.code, '22023', key);
      }
      assert.equal((await errorOf(db, 'SELECT * FROM rag_vector_sync_reconcile_summary($1, $2)', [a.key, 'no-such-profile']))?.code, '22023');
      assert.equal((await errorOf(db, 'SELECT * FROM rag_vector_sync_bucket_rows($1, $2, 64, NULL, 10)', [a.key, LEGACY]))?.code, '22023');
      assert.equal((await errorOf(db, 'SELECT * FROM rag_vector_sync_bucket_rows($1, $2, 0, NULL, 1001)', [a.key, LEGACY]))?.code, '22023');
    });

    test('tenants: nothing while the target is disabled; enabled lists the tenant, least recently reconciled first', async () => {
      await db.query("UPDATE rag_vector_sync_targets SET enabled = false WHERE target = 'qdrant'");
      assert.equal((await db.query("SELECT * FROM rag_vector_sync_tenants('qdrant', $1)", [LEGACY])).rows.length, 0);
      await db.query("UPDATE rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
      const listed = (await db.query<{ tenant_key: string }>("SELECT tenant_key FROM rag_vector_sync_tenants('qdrant', $1)", [LEGACY])).rows.map(
        (row) => row.tenant_key,
      );
      assert.ok(listed.includes(a.key));
      if (b) {
        assert.ok(listed.includes(b.key));
        await db.query("SELECT rag_set_backend_index_state('qdrant', $1, $2, 'ready', 0, 0, NULL)", [LEGACY, a.key]);
        const order = (await db.query<{ tenant_key: string }>("SELECT tenant_key FROM rag_vector_sync_tenants('qdrant', $1)", [LEGACY])).rows.map(
          (row) => row.tenant_key,
        );
        assert.ok(order.indexOf(b.key) < order.indexOf(a.key), 'a never reconciled tenant comes first');
      }
      assert.equal((await errorOf(db, "SELECT * FROM rag_vector_sync_tenants('pinecone', $1)", [LEGACY]))?.code, '22023');
    });

    test('enqueue_repair inserts one row, deduplicates a fresh pending row, and rejects unknown targets and entities', async () => {
      await db.query("UPDATE rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
      await db.query("DELETE FROM vector_sync_outbox WHERE entity_id = $1", [docA]);
      const first = await db.query<{ n: number }>("SELECT rag_vector_sync_enqueue_repair('qdrant', 'document', $1, $2, $3) AS n", [docA, a.key, LEGACY]);
      assert.equal(Number(first.rows[0]?.n), 1);
      const again = await db.query<{ n: number }>("SELECT rag_vector_sync_enqueue_repair('qdrant', 'document', $1, $2, $3) AS n", [docA, a.key, LEGACY]);
      assert.equal(Number(again.rows[0]?.n), 0);
      const rows = (
        await db.query<{ entity: string; tenant_key: string; profile_id: string; status: string }>(
          'SELECT entity, tenant_key, profile_id, status FROM vector_sync_outbox WHERE entity_id = $1',
          [docA],
        )
      ).rows;
      assert.deepEqual(rows, [{ entity: 'document', tenant_key: a.key, profile_id: LEGACY, status: 'pending' }]);

      const bad: Array<[string, string, string]> = [
        ['pinecone', 'document', docA],
        ['qdrant', 'profile', docA],
        ['qdrant', 'everything', docA],
        ['qdrant', 'chunk', 'not-a-uuid'],
        ['qdrant', 'tenant', 'u:00000000-0000-4000-8000-000000000999'],
      ];
      for (const [target, entity, entityId] of bad) {
        const error = await errorOf(db, 'SELECT rag_vector_sync_enqueue_repair($1, $2, $3, $4, NULL)', [target, entity, entityId, a.key]);
        assert.equal(error?.code, '22023', `${target}/${entity}/${entityId}`);
      }
      assert.equal((await errorOf(db, "SELECT rag_vector_sync_enqueue_repair('qdrant', 'chunk', $1, 'U:BAD', NULL)", [own[0]]))?.code, '22023');
      await db.query("UPDATE rag_vector_sync_targets SET enabled = false WHERE target = 'weaviate'");
      const disabled = await db.query<{ n: number }>("SELECT rag_vector_sync_enqueue_repair('weaviate', 'chunk', $1, $2, NULL) AS n", [own[0], a.key]);
      assert.equal(Number(disabled.rows[0]?.n), 0, 'a disabled target gets no repair row');
    });

    test('index state: a mismatch keeps a new tenant building, ready on a match, stale afterwards, failed with a code only', async () => {
      const key = mode === 'multi-tenant' ? `o:${crypto.randomUUID()}` : a.key;
      await db.query("DELETE FROM rag_backend_index_state WHERE target = 'weaviate' AND tenant_key = $1", [key]);
      const set = async (state: string, error: string | null = null): Promise<string> =>
        (await db.query<{ s: string }>("SELECT rag_set_backend_index_state('weaviate', $1, $2, $3, 5, 4, $4) AS s", [LEGACY, key, state, error])).rows[0]!.s;
      assert.equal(await set('stale'), 'building');
      assert.equal(await set('stale'), 'building');
      assert.equal(await set('ready'), 'ready');
      assert.equal(await set('stale'), 'stale');
      assert.equal(await set('failed', 'Some message with chunk text'), 'failed');
      const row = (
        await db.query<{ state: string; last_error: string; supabase_count: string; backend_count: string; last_reconciled_at: Date | null }>(
          "SELECT state, last_error, supabase_count, backend_count, last_reconciled_at FROM rag_backend_index_state WHERE target = 'weaviate' AND tenant_key = $1",
          [key],
        )
      ).rows[0]!;
      assert.equal(row.last_error, 'store_error');
      assert.equal(Number(row.supabase_count), 5);
      assert.equal(Number(row.backend_count), 4);
      assert.ok(row.last_reconciled_at);
      assert.equal(await set('failed', 'store_error:timeout'), 'failed');
      assert.equal(await set('ready'), 'ready');
      const cleared = await db.query<{ last_error: string | null }>(
        "SELECT last_error FROM rag_backend_index_state WHERE target = 'weaviate' AND tenant_key = $1",
        [key],
      );
      assert.equal(cleared.rows[0]?.last_error, null);
      for (const bad of ['building', 'unknown', null]) {
        assert.equal(
          (await errorOf(db, "SELECT rag_set_backend_index_state('weaviate', $1, $2, $3, 0, 0, NULL)", [LEGACY, key, bad]))?.code,
          '22023',
          String(bad),
        );
      }
      assert.equal((await errorOf(db, "SELECT rag_set_backend_index_state('weaviate', $1, $2, 'ready', -1, 0, NULL)", [LEGACY, key]))?.code, '22023');
    });

    test('prune deletes done rows older than the window and never dead or pending rows', async () => {
      const ids: Record<string, string> = {};
      for (const [name, status, age] of [
        ['oldDone', 'done', '10 days'],
        ['newDone', 'done', '1 day'],
        ['oldDead', 'dead', '30 days'],
        ['oldPending', 'pending', '30 days'],
        ['oldLeased', 'leased', '30 days'],
      ] as const) {
        const r = await db.query<{ id: string }>(
          `INSERT INTO vector_sync_outbox (target, entity, entity_id, tenant_key, status, enqueued_at)
           VALUES ('qdrant', 'chunk', $1, $2, $3, now() - $4::interval) RETURNING id::text`,
          [crypto.randomUUID(), a.key, status, age],
        );
        ids[name] = r.rows[0]!.id;
      }
      const pruned = await db.query<{ n: number }>('SELECT rag_vector_sync_prune(7) AS n');
      assert.ok(Number(pruned.rows[0]?.n) >= 1);
      const left = new Set(
        (await db.query<{ id: string }>('SELECT id::text FROM vector_sync_outbox WHERE id = ANY($1::bigint[])', [Object.values(ids)])).rows.map((r) => r.id),
      );
      assert.equal(left.has(ids.oldDone!), false);
      for (const name of ['newDone', 'oldDead', 'oldPending', 'oldLeased']) assert.ok(left.has(ids[name]!), name);
      for (const days of [0, null, 4000]) assert.equal((await errorOf(db, 'SELECT rag_vector_sync_prune($1)', [days]))?.code, '22023', String(days));
    });

    test('SET ROLE anon and authenticated get 42501 on every function; service_role succeeds', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          for (const fn of FUNCTIONS) assert.equal((await errorOf(db, fn.sql, fn.params(a.key)))?.code, '42501', `${role}: ${fn.sql}`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      await db.exec('SET ROLE service_role');
      try {
        for (const fn of FUNCTIONS) assert.equal(await errorOf(db, fn.sql, fn.params(a.key)), null, fn.sql);
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    test('every 0707 function is SECURITY INVOKER with an empty search_path and no PUBLIC grant', async () => {
      const rows = (
        await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; public_exec: boolean }>(
          `SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`,
          [
            [
              'rag_vector_sync_reconcile_summary',
              'rag_vector_sync_bucket_rows',
              'rag_vector_sync_tenants',
              'rag_vector_sync_enqueue_repair',
              'rag_set_backend_index_state',
              'rag_vector_sync_prune',
            ],
          ],
        )
      ).rows;
      assert.equal(rows.length, 6);
      for (const row of rows) {
        assert.equal(row.prosecdef, false, row.proname);
        assert.ok((row.proconfig ?? []).includes('search_path=""'), row.proname);
        assert.equal(row.public_exec, false, row.proname);
      }
    });

    test('re-applying 0707 is idempotent and keeps the summary', async () => {
      const before = await summary(a.key);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      assert.deepEqual(await summary(a.key), before);
    });
  });
}

describe('vector sync reconcile RPCs through the fake edge (multi-tenant)', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: RpcClient;
  const key = `u:${TWO_TENANT_IDS.userA}`;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
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

  test('summary, tenants and prune answer with their registered argument names; checksums arrive as exact decimal text', async () => {
    const summary = await client.rpc('rag_vector_sync_reconcile_summary', { p_tenant_key: key, p_profile_id: LEGACY });
    assert.equal(summary.error, null);
    const rows = summary.data as SummaryRow[];
    assert.equal(rows.length, 64);
    for (const row of rows) assert.match(row.id_xor, /^-?[0-9]+$/);
    const direct = (await db.query<SummaryRow>('SELECT * FROM rag_vector_sync_reconcile_summary($1, $2)', [key, LEGACY])).rows;
    assert.deepEqual(
      rows.map((row) => [row.bucket, Number(row.row_count), row.id_xor, row.content_xor]),
      direct.map((row) => [row.bucket, Number(row.row_count), row.id_xor, row.content_xor]),
    );
    const prune = await client.rpc('rag_vector_sync_prune', { p_days: 7 });
    assert.equal(prune.error, null);
  });

  test('an argument outside the registered list is rejected', async () => {
    const response = await client.rpc('rag_vector_sync_reconcile_summary', { p_tenant_key: key, p_profile_id: LEGACY, p_extra: 1 });
    assert.notEqual(response.error, null);
  });
});
