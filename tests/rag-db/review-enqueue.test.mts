import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';
import { AUTHENTICATED_ALLOW_LIST, normalizeSignature } from '../helpers/security-definer-allow-list.ts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0944_rag_review_reasons_phase52.sql';
const GRANTS_MIGRATION = 'supabase/migrations/0410_security_definer_rpc_grants.sql';
const SIGNATURE = 'rag_enqueue_review_item(text, text, jsonb, jsonb)';
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/feedback-mining.json'), 'utf8')) as Row;
const SINCE = '2026-11-16T00:00:00Z';
const UNTIL = '2026-11-23T00:00:00Z';
const INSIDE = '2026-11-20T12:00:00Z';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

interface Source {
  tenantKey: string;
  documentId: string;
  chunkIds: string[];
}

async function createSource(db: PGlite, chunks = 2): Promise<Source> {
  const owner = await createUser(db);
  const documentId = crypto.randomUUID();
  await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'fixture.txt', 'A neutral synthetic body.', $2)", [documentId, owner]);
  const chunkIds: string[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, 'A neutral synthetic sentence.', $3, '{}'::jsonb)", [
      id,
      documentId,
      index,
    ]);
    chunkIds.push(id);
  }
  const tenantKey = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM documents WHERE id = $1', [documentId])).rows[0]?.tenant_key as string;
  return { tenantKey, documentId, chunkIds };
}

function sourceOf(source: Source, chunkIds = source.chunkIds): Row {
  return { chunk_ids: chunkIds, document_ids: [source.documentId] };
}

async function enqueue(db: PGlite, tenantKey: string, reason: string, source: Row, snapshot: Row = { detector: 'rules' }): Promise<string | null> {
  const rows = await asRole(db, 'service_role', null, async () =>
    (
      await db.query<{ id: string | null }>('SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb) AS id', [
        tenantKey,
        reason,
        JSON.stringify(source),
        JSON.stringify(snapshot),
      ])
    ).rows,
  );
  return rows[0]?.id ?? null;
}

async function itemById(db: PGlite, id: string): Promise<Row | undefined> {
  return (await db.query<Row>('SELECT * FROM rag_review_items WHERE id = $1', [id])).rows[0];
}

function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function insertItem(db: PGlite, reasons: string[]): Promise<void> {
  await db.query('INSERT INTO rag_review_items (tenant_key, query_masked, query_fingerprint, reasons, mining_window) VALUES ($1, $2, $3, $4, $5)', [
    's:default',
    'A synthetic question about the sample topic',
    fingerprintOf(crypto.randomUUID()),
    reasons,
    UNTIL,
  ]);
}

async function catalog(db: PGlite): Promise<string[]> {
  const rows = await db.query<Row>(
    `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid IN ('public.rag_answer_records'::regclass, 'public.rag_review_items'::regclass)
     UNION ALL
     SELECT 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, '') FROM pg_proc p
     WHERE p.proname IN ('rag_enqueue_review_item', 'rag_mine_failed_queries')
     UNION ALL
     SELECT 'col', column_name, data_type || is_nullable || coalesce(column_default, '') FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'rag_review_items'`,
  );
  return rows.rows.map((row) => JSON.stringify(row)).sort();
}

for (const mode of MODES) {
  describe(`0944 review reasons and rag_enqueue_review_item (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db.close();
    });

    test('the review-item reason check accepts the Phase 5.2 reasons and still refuses unknown ones', async () => {
      for (const reason of ['claim_unsupported', 'output_guard', 'version_conflict', 'low_score', 'groundedness_flagged']) {
        await insertItem(db, [reason]);
      }
      await rejectsWith(() => insertItem(db, ['spam']), '23514');
      await rejectsWith(() => insertItem(db, ['calc_mismatch']), '23514');
    });

    test('applying 0944 a second time succeeds and leaves the catalog unchanged', async () => {
      const once = await catalog(db);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      assert.deepEqual(await catalog(db), once);
    });

    test('an item is enqueued once per reason, source ids and week; the snapshot holds ids only', async () => {
      const source = await createSource(db);
      const id = await enqueue(db, source.tenantKey, 'output_guard', sourceOf(source), { detector: 'rules', trace_id: 'trace-0001' });
      assert.ok(id);
      const again = await enqueue(db, source.tenantKey, 'output_guard', sourceOf(source, [...source.chunkIds].reverse()), { detector: 'rules', trace_id: 'trace-0002' });
      assert.equal(again, id, 'same reason and ids in the same week returns the existing item');
      const count = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM rag_review_items WHERE tenant_key = $1 AND query_fingerprint = (SELECT query_fingerprint FROM rag_review_items WHERE id = $2)',
        [source.tenantKey, id],
      );
      assert.equal(count.rows[0]?.n, 1);

      const item = (await itemById(db, id)) as Row;
      assert.equal(item.tenant_key, source.tenantKey);
      assert.deepEqual(item.reasons, ['output_guard']);
      assert.equal(item.status, 'open');
      assert.equal(item.query_masked, '');
      assert.equal(item.user_id, null);
      assert.equal(item.chat_id, null);
      assert.equal(item.trace_id, 'trace-0001');
      const sortedChunks = [...source.chunkIds].sort();
      assert.equal(item.query_fingerprint, fingerprintOf(`output_guard\nchunks:${sortedChunks.join(',')}\ndocuments:${source.documentId}`));
      const window = await db.query<{ same: boolean }>("SELECT $1::timestamptz = date_trunc('week', now(), 'UTC') AS same", [item.mining_window]);
      assert.equal(window.rows[0]?.same, true);
      assert.deepEqual(item.snapshot, {
        reason: 'output_guard',
        detector: 'rules',
        trace_id: 'trace-0001',
        chunk_ids: sortedChunks,
        document_ids: [source.documentId],
      });
      assert.deepEqual(item.candidates, []);

      const otherReason = await enqueue(db, source.tenantKey, 'version_conflict', { chunk_ids: [], document_ids: [source.documentId] });
      assert.ok(otherReason);
      assert.notEqual(otherReason, id);
      const claim = await enqueue(db, source.tenantKey, 'claim_unsupported', sourceOf(source));
      assert.ok(claim);
      assert.notEqual(claim, id);
    });

    test('a text key, an unknown key or a malformed value in the snapshot or source is refused with 22023', async () => {
      const source = await createSource(db);
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', sourceOf(source), { detector: 'rules', text: 'A neutral sentence.' }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', sourceOf(source), { detector: 'rules', quote: 'A neutral sentence.' }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', sourceOf(source), { detector: 'Two words' }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', { ...sourceOf(source), text: 'x' }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', { chunk_ids: ['not-a-uuid'], document_ids: [] }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', { chunk_ids: [], document_ids: [] }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'low_score', sourceOf(source)), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'calc_mismatch', sourceOf(source)), '22023');
      await rejectsWith(() => enqueue(db, 'bogus', 'output_guard', sourceOf(source)), '22023');
    });

    test('ids of another tenant or of no stored row are refused', async () => {
      const source = await createSource(db);
      await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', { chunk_ids: [crypto.randomUUID()], document_ids: [] }), '22023');
      await rejectsWith(() => enqueue(db, source.tenantKey, 'version_conflict', { chunk_ids: [], document_ids: [crypto.randomUUID()] }), '22023');
      if (mode === 'multi-tenant') {
        const other = await createSource(db);
        assert.notEqual(other.tenantKey, source.tenantKey);
        await rejectsWith(() => enqueue(db, source.tenantKey, 'output_guard', { chunk_ids: other.chunkIds, document_ids: [] }), '22023');
        await rejectsWith(() => enqueue(db, source.tenantKey, 'version_conflict', { chunk_ids: [], document_ids: [source.documentId, other.documentId] }), '22023');
      } else {
        await rejectsWith(() => enqueue(db, `u:${crypto.randomUUID()}`, 'output_guard', sourceOf(source)), '22023');
      }
    });

    test('a tenant that turned its feedback loop off gets no row and a null result', async () => {
      const source = await createSource(db);
      await db.query("INSERT INTO rag_tenant_feedback_settings (tenant_key, retrieval_log) VALUES ($1, 'off') ON CONFLICT (tenant_key) DO UPDATE SET retrieval_log = 'off'", [
        source.tenantKey,
      ]);
      try {
        const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_review_items WHERE tenant_key = $1', [source.tenantKey]);
        assert.equal(await enqueue(db, source.tenantKey, 'output_guard', sourceOf(source)), null);
        const afterRows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_review_items WHERE tenant_key = $1', [source.tenantKey]);
        assert.equal(afterRows.rows[0]?.n, before.rows[0]?.n);
        await db.query("UPDATE rag_tenant_feedback_settings SET retrieval_log = 'ids' WHERE tenant_key = $1", [source.tenantKey]);
        assert.ok(await enqueue(db, source.tenantKey, 'output_guard', sourceOf(source)), 'ids keeps id-only items');
      } finally {
        await db.query('DELETE FROM rag_tenant_feedback_settings WHERE tenant_key = $1', [source.tenantKey]);
      }
    });

    test('experts of the item tenant see the item; experts of another tenant and other users do not', async () => {
      const source = await createSource(db);
      const id = (await enqueue(db, source.tenantKey, 'version_conflict', { chunk_ids: [], document_ids: [source.documentId] })) as string;
      const visible = async (userId: string) =>
        asRole(db, 'authenticated', userId, async () => (await db.query<{ id: string }>('SELECT id FROM rag_review_items WHERE id = $1', [id])).rows.length === 1);
      const outsider = await createUser(db);
      if (mode === 'single-tenant') {
        const admin = await createUser(db);
        await db.query('INSERT INTO admin_users (id) VALUES ($1)', [admin]);
        assert.equal(await visible(admin), true);
        assert.equal(await visible(outsider), false);
      } else {
        const expertA = await createUser(db);
        const expertB = await createUser(db);
        const other = await createSource(db);
        await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($3, $4)', [source.tenantKey, expertA, other.tenantKey, expertB]);
        assert.equal(await visible(expertA), true);
        assert.equal(await visible(expertB), false);
        assert.equal(await visible(outsider), false);
      }
    });

    test('the function is SECURITY INVOKER with an empty search_path, service_role only and absent from the allow-list', async () => {
      const row = (
        await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>(
          `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [`public.${SIGNATURE}`],
        )
      ).rows[0];
      assert.deepEqual(row, { anon: false, authenticated: false, service: true, definer: false, config: ['search_path=""'] });
      assert.equal(AUTHENTICATED_ALLOW_LIST[normalizeSignature(SIGNATURE)], undefined);
      const source = await createSource(db);
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith(
          () =>
            asRole(db, role, null, () =>
              db.query('SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb)', [source.tenantKey, 'output_guard', JSON.stringify(sourceOf(source)), '{}']),
            ),
          '42501',
        );
      }
      await assertNoClientCallableRagFunctions(db);
    });

    test('re-running 0410 after a stray grant restores the lock', async () => {
      await db.query(`GRANT EXECUTE ON FUNCTION public.${SIGNATURE} TO authenticated, anon`);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, GRANTS_MIGRATION), 'utf8'));
      const row = (
        await db.query<{ anon: boolean; authenticated: boolean }>(
          `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated`,
          [`public.${SIGNATURE}`],
        )
      ).rows[0];
      assert.deepEqual(row, { anon: false, authenticated: false });
      const sql = fs.readFileSync(path.join(REPO_ROOT, GRANTS_MIGRATION), 'utf8');
      const key = SIGNATURE;
      assert.ok(sql.includes(`to_regprocedure('public.${key}')`));
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${key} FROM PUBLIC, anon, authenticated;`));
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${key} TO service_role;`));
    });
  });
}

describe('rag_mine_failed_queries picks up claim_unsupported (multi-tenant)', () => {
  let db: PGlite;
  let tenantKey: string;
  let userId: string;
  let organizationId: string;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  });

  beforeEach(async () => {
    await db.query('DELETE FROM rag_review_items');
    await db.query('DELETE FROM rag_answer_records');
    await db.query('DELETE FROM rag_retrieval_log');
    userId = await createUser(db);
    organizationId = crypto.randomUUID();
    await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [organizationId, 'Fixture org', `fixture-${organizationId.slice(0, 8)}`, userId]);
    tenantKey = `o:${organizationId}`;
  });

  after(async () => {
    await db.close();
  });

  let counter = 0;
  async function insertLog(row: Row = {}): Promise<string> {
    counter += 1;
    const question = `Synthetic question number ${counter} about the sample topic`;
    const values: Row = {
      trace_id: crypto.randomUUID(),
      user_id: userId,
      organization_id: organizationId,
      channel: 'chat',
      pipeline: 'legacy',
      status: 'ok',
      outcome: 'answered',
      candidate_count: 3,
      top_score: 0.7,
      created_at: INSIDE,
      query_masked: question,
      query_fingerprint: fingerprintOf(question),
      ...row,
    };
    const names = Object.keys(values);
    const result = await db.query<{ trace_id: string }>(
      `INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING trace_id`,
      names.map((name) => values[name]),
    );
    return (result.rows[0] as { trace_id: string }).trace_id;
  }

  async function insertRecord(traceId: string, fields: { groundedness?: Row; reviewReasons?: string[] }): Promise<void> {
    await db.query(
      `INSERT INTO rag_answer_records (id, user_id, organization_id, trace_id, rag_mode, groundedness, review_reasons)
       VALUES ($1, $2, $3, $4, 'strict', $5, $6)`,
      [crypto.randomUUID(), userId, organizationId, traceId, JSON.stringify(fields.groundedness ?? {}), fields.reviewReasons ?? []],
    );
  }

  async function mine(config: Row = CONFIG): Promise<Row[]> {
    return (await db.query<Row>('SELECT tenant_key, reason, inserted FROM public.rag_mine_failed_queries($1, $2, $3) ORDER BY tenant_key, reason', [SINCE, UNTIL, JSON.stringify(config)])).rows;
  }

  async function reasonsOf(traceId: string): Promise<string[] | undefined> {
    return (await db.query<{ reasons: string[] }>('SELECT reasons FROM rag_review_items WHERE trace_id = $1', [traceId])).rows[0]?.reasons;
  }

  test('an answer record with claim_unsupported yields a claim_unsupported item; ordered after groundedness_flagged', async () => {
    const claim = await insertLog();
    await insertRecord(claim, { reviewReasons: ['claim_unsupported'] });
    const both = await insertLog();
    await insertRecord(both, { groundedness: { label: 'possibly_unreliable' }, reviewReasons: ['groundedness_flagged', 'claim_unsupported'] });
    const counts = await mine();
    assert.deepEqual(await reasonsOf(claim), ['claim_unsupported']);
    assert.deepEqual(await reasonsOf(both), ['groundedness_flagged', 'claim_unsupported']);
    assert.deepEqual(counts, [
      { tenant_key: tenantKey, reason: 'claim_unsupported', inserted: 2 },
      { tenant_key: tenantKey, reason: 'groundedness_flagged', inserted: 1 },
    ]);
  });

  test('claim_unsupported ranks right after groundedness_flagged and before the retrieval reasons', async () => {
    const grounded = await insertLog();
    await insertRecord(grounded, { groundedness: { label: 'possibly_unreliable' } });
    const claim = await insertLog();
    await insertRecord(claim, { reviewReasons: ['claim_unsupported'] });
    const high = await insertLog({ outcome: 'refused_no_context', top_score: 0.9 });
    const low = await insertLog({ top_score: 0.1 });
    await mine({ ...CONFIG, per_tenant_limit: 1 });
    assert.deepEqual(await reasonsOf(grounded), ['groundedness_flagged']);
    assert.equal(await reasonsOf(claim), undefined);
    await db.query('DELETE FROM rag_review_items');
    await mine({ ...CONFIG, per_tenant_limit: 2 });
    assert.deepEqual(await reasonsOf(claim), ['claim_unsupported']);
    assert.equal(await reasonsOf(high), undefined);
    assert.equal(await reasonsOf(low), undefined);
  });

  test('a claim_unsupported record of another tenant on the same trace id is ignored', async () => {
    const trace = await insertLog();
    const otherUser = await createUser(db);
    await db.query(`INSERT INTO rag_answer_records (id, user_id, trace_id, rag_mode, review_reasons) VALUES ($1, $2, $3, 'strict', '{claim_unsupported}')`, [
      crypto.randomUUID(),
      otherUser,
      trace,
    ]);
    await mine();
    assert.equal(await reasonsOf(trace), undefined);
  });
});
