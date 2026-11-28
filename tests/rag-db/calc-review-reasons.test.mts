import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { migrationFiles } from '../../eval/harness/migrations.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0950_calc_review_reasons.sql';
const STRATA_MIGRATION = 'supabase/migrations/0967_rag_review_item_strata.sql';
// 0984 rebuilds both functions later in file order (access sets); re-running 0950 requires re-running it.
const ACCESS_SETS_MIGRATION = 'supabase/migrations/0984_review_items_access_sets.sql';
const CALC_REASONS = ['calc_mismatch', 'calc_unverified'];
const ANSWER_REASONS_BEFORE = ['feedback_negative', 'groundedness_flagged', 'claim_unsupported'];
const ITEM_REASONS_BEFORE = [
  'feedback_negative',
  'refusal_disputed',
  'groundedness_flagged',
  'refused_high_score',
  'zero_results',
  'low_score',
  'no_source_opened',
  'claim_unsupported',
  'output_guard',
  'version_conflict',
  'representative',
  're_review',
];
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

function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readMigration(relpath: string): string {
  const full = path.join(REPO_ROOT, relpath);
  assert.ok(fs.existsSync(full), `${relpath} exists`);
  return fs.readFileSync(full, 'utf8');
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

async function insertAnswerRecord(db: PGlite, reasons: string[]): Promise<void> {
  const userId = await createUser(db);
  await db.query("INSERT INTO rag_answer_records (id, user_id, rag_mode, review_reasons) VALUES ($1, $2, 'strict', $3)", [crypto.randomUUID(), userId, reasons]);
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

interface Source {
  tenantKey: string;
  documentId: string;
  chunkIds: string[];
}

async function createSource(db: PGlite): Promise<Source> {
  const owner = await createUser(db);
  const documentId = crypto.randomUUID();
  await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'fixture.txt', 'A neutral synthetic body.', $2)", [documentId, owner]);
  const chunkId = crypto.randomUUID();
  await db.query("INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, 'A neutral synthetic sentence.', 0, '{}'::jsonb)", [
    chunkId,
    documentId,
  ]);
  const tenantKey = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM documents WHERE id = $1', [documentId])).rows[0]?.tenant_key as string;
  return { tenantKey, documentId, chunkIds: [chunkId] };
}

function enqueueSql(): string {
  return 'SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb) AS id';
}

async function catalog(db: PGlite): Promise<string[]> {
  const rows = await db.query<Row>(
    `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid IN ('public.rag_answer_records'::regclass, 'public.rag_review_items'::regclass)
     UNION ALL
     SELECT 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, '') FROM pg_proc p
     WHERE p.proname IN ('rag_enqueue_review_item', 'rag_mine_failed_queries')`,
  );
  return rows.rows.map((row) => JSON.stringify(row)).sort();
}

interface FunctionState {
  anon: boolean;
  authenticated: boolean;
  service: boolean;
  definer: boolean;
  config: string[] | null;
}

async function functionState(db: PGlite, signature: string): Promise<FunctionState | undefined> {
  return (
    await db.query<FunctionState>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
       FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [`public.${signature}`],
    )
  ).rows[0];
}

describe('0950 is a common file and not folded into the setup files', () => {
  test('one common migration, absent from both setup files', () => {
    readMigration(MIGRATION);
    for (const mode of MODES) {
      assert.equal(migrationFiles(mode).filter((file) => file.includes('/0950_')).length, 1, mode);
    }
    for (const setup of ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql']) {
      const sql = fs.readFileSync(path.join(REPO_ROOT, setup), 'utf8');
      assert.equal(sql.includes('calc_unverified'), false, setup);
      assert.equal(sql.includes('calc_mismatch'), false, setup);
    }
  });
});

for (const mode of MODES) {
  describe(`0950 calculation review reasons (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db.close();
    });

    test('rag_answer_records.review_reasons accepts the calculation reasons and every earlier value, and refuses unknown ones', async () => {
      for (const reason of [...ANSWER_REASONS_BEFORE, ...CALC_REASONS]) {
        await insertAnswerRecord(db, [reason]);
      }
      await insertAnswerRecord(db, [...ANSWER_REASONS_BEFORE, ...CALC_REASONS]);
      for (const reason of ['calc_other', 'output_guard', 'low_score', 'spam']) {
        await rejectsWith(() => insertAnswerRecord(db, [reason]), '23514');
      }
    });

    test('rag_review_items.reasons accepts the calculation reasons and every earlier value, and refuses unknown ones', async () => {
      for (const reason of [...ITEM_REASONS_BEFORE, ...CALC_REASONS]) {
        await insertItem(db, [reason]);
      }
      await insertItem(db, ['claim_unsupported', ...CALC_REASONS]);
      for (const reason of ['calc_other', 'sampled', 'spam']) {
        await rejectsWith(() => insertItem(db, [reason]), '23514');
      }
    });

    test('applying 0950 and the later 0984 a second time succeeds and leaves the catalog unchanged', async () => {
      const once = await catalog(db);
      await db.exec(readMigration(MIGRATION));
      await db.exec(readMigration(ACCESS_SETS_MIGRATION));
      assert.deepEqual(await catalog(db), once);
    });

    test('re-running the later 0967 keeps the calculation reasons on rag_review_items', async () => {
      await db.exec(readMigration(STRATA_MIGRATION));
      for (const reason of CALC_REASONS) await insertItem(db, [reason]);
    });

    test('the service role enqueues a calculation item; the earlier reasons still enqueue and unknown ones are refused', async () => {
      const source = await createSource(db);
      const run = (reason: string) =>
        asRole(db, 'service_role', null, async () =>
          (await db.query<{ id: string | null }>(enqueueSql(), [source.tenantKey, reason, JSON.stringify({ chunk_ids: source.chunkIds, document_ids: [source.documentId] }), JSON.stringify({ detector: 'calc' })])).rows[0]?.id ?? null,
        );
      for (const reason of ['calc_unverified', 'calc_mismatch', 'claim_unsupported', 'output_guard', 'version_conflict']) {
        const id = await run(reason);
        assert.ok(id, reason);
        const item = (await db.query<Row>('SELECT reasons, snapshot FROM rag_review_items WHERE id = $1', [id])).rows[0] as Row;
        assert.deepEqual(item.reasons, [reason]);
        assert.equal((item.snapshot as Row).reason, reason);
      }
      for (const reason of ['low_score', 'calc_other', 'feedback_negative']) {
        await rejectsWith(() => run(reason), '22023');
      }
    });

    test('the replaced functions keep their security attributes, empty search_path and service-role-only grants', async () => {
      assert.deepEqual(await functionState(db, 'rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb)'), {
        anon: false,
        authenticated: false,
        service: true,
        definer: false,
        config: ['search_path=""'],
      });
      assert.deepEqual(await functionState(db, 'rag_mine_failed_queries(timestamptz, timestamptz, jsonb)'), {
        anon: false,
        authenticated: false,
        service: true,
        definer: true,
        config: ['search_path=""'],
      });
      const source = await createSource(db);
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith(
          () => asRole(db, role, null, () => db.query(enqueueSql(), [source.tenantKey, 'calc_unverified', JSON.stringify({ chunk_ids: source.chunkIds, document_ids: [] }), '{}'])),
          '42501',
        );
        await rejectsWith(
          () => asRole(db, role, null, () => db.query('SELECT * FROM public.rag_mine_failed_queries($1, $2, $3)', [SINCE, UNTIL, JSON.stringify(CONFIG)])),
          '42501',
        );
      }
      await assertNoClientCallableRagFunctions(db);
    });
  });
}

describe('rag_mine_failed_queries picks up the calculation reasons (multi-tenant)', () => {
  let db: PGlite;
  let tenantKey: string;
  let userId: string;
  let organizationId: string;
  let counter = 0;

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

  async function insertRecord(traceId: string, reviewReasons: string[], owner = { userId, organizationId }): Promise<void> {
    await db.query(
      `INSERT INTO rag_answer_records (id, user_id, organization_id, trace_id, rag_mode, review_reasons)
       VALUES ($1, $2, $3, $4, 'strict', $5)`,
      [crypto.randomUUID(), owner.userId, owner.organizationId, traceId, reviewReasons],
    );
  }

  async function mine(config: Row = CONFIG): Promise<Row[]> {
    return (await db.query<Row>('SELECT tenant_key, reason, inserted FROM public.rag_mine_failed_queries($1, $2, $3) ORDER BY tenant_key, reason', [SINCE, UNTIL, JSON.stringify(config)])).rows;
  }

  async function reasonsOf(traceId: string): Promise<string[] | undefined> {
    return (await db.query<{ reasons: string[] }>('SELECT reasons FROM rag_review_items WHERE trace_id = $1', [traceId])).rows[0]?.reasons;
  }

  test('a record with calc_mismatch or calc_unverified is mined with that reason, listed after claim_unsupported', async () => {
    const mismatch = await insertLog();
    await insertRecord(mismatch, ['calc_mismatch']);
    const unverified = await insertLog();
    await insertRecord(unverified, ['calc_unverified']);
    const all = await insertLog();
    await insertRecord(all, ['calc_unverified', 'claim_unsupported', 'calc_mismatch']);
    const counts = await mine();
    assert.deepEqual(await reasonsOf(mismatch), ['calc_mismatch']);
    assert.deepEqual(await reasonsOf(unverified), ['calc_unverified']);
    assert.deepEqual(await reasonsOf(all), ['claim_unsupported', 'calc_mismatch', 'calc_unverified']);
    assert.deepEqual(counts, [
      { tenant_key: tenantKey, reason: 'calc_mismatch', inserted: 2 },
      { tenant_key: tenantKey, reason: 'calc_unverified', inserted: 2 },
      { tenant_key: tenantKey, reason: 'claim_unsupported', inserted: 1 },
    ]);
  });

  test('selection priority: claim_unsupported, then calc_mismatch, then calc_unverified, then the retrieval reasons', async () => {
    const claim = await insertLog();
    await insertRecord(claim, ['claim_unsupported']);
    const mismatch = await insertLog();
    await insertRecord(mismatch, ['calc_mismatch']);
    const unverified = await insertLog();
    await insertRecord(unverified, ['calc_unverified']);
    const high = await insertLog({ outcome: 'refused_no_context', top_score: 0.9 });
    for (const [limit, expected] of [
      [1, [claim]],
      [2, [claim, mismatch]],
      [3, [claim, mismatch, unverified]],
    ] as const) {
      await db.query('DELETE FROM rag_review_items');
      await mine({ ...CONFIG, per_tenant_limit: limit });
      for (const trace of [claim, mismatch, unverified, high]) {
        assert.equal((await reasonsOf(trace)) !== undefined, (expected as readonly string[]).includes(trace), `limit ${limit}`);
      }
    }
  });

  test('a calculation record of another tenant on the same trace id is ignored', async () => {
    const trace = await insertLog();
    const otherUser = await createUser(db);
    const otherOrganization = crypto.randomUUID();
    await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [otherOrganization, 'Other org', `other-${otherOrganization.slice(0, 8)}`, otherUser]);
    await insertRecord(trace, ['calc_mismatch'], { userId: otherUser, organizationId: otherOrganization });
    await mine();
    assert.equal(await reasonsOf(trace), undefined);
  });
});
