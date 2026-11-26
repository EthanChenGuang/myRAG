import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

type Role = 'anon' | 'authenticated' | 'service_role';

const FROZEN_COLUMNS: Record<string, string> = {
  tenant_key: 'text',
  created_at: 'timestamp with time zone',
  channel: 'text',
  rag_mode: 'text',
  status: 'text',
  outcome: 'text',
  refusal_decision: 'text',
  top_score: 'real',
  candidate_count: 'integer',
  latency_ms: 'integer',
  stage_latency: 'jsonb',
  feedback_vote: 'smallint',
  feedback_kind: 'text',
  feedback_reasons: 'ARRAY',
  feedback_at: 'timestamp with time zone',
  source_opened_count: 'integer',
  query_language: 'text',
  query_language_confidence: 'real',
  chunk_languages: 'ARRAY',
  answer_language: 'text',
};

const ALL_COLUMNS = [
  'id',
  'trace_id',
  'user_id',
  'organization_id',
  'chat_id',
  'answer_id',
  'tenant_key',
  'channel',
  'rag_mode',
  'pipeline',
  'retrieval_config_hash',
  'query_language',
  'query_language_confidence',
  'chunk_languages',
  'answer_language',
  'query_masked',
  'query_fingerprint',
  'status',
  'refusal_decision',
  'refusal_reason',
  'outcome',
  'candidates',
  'candidate_count',
  'top_score',
  'latency_ms',
  'stage_latency',
  'feedback_vote',
  'feedback_kind',
  'feedback_reasons',
  'feedback_at',
  'source_opened_count',
  'topk_redundancy',
  'created_at',
].sort();

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

async function createOrganization(db: PGlite, ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Fixture org', `fixture-${id.slice(0, 8)}`, ownerId]);
  return id;
}

async function createChat(db: PGlite, userId: string, id: string = crypto.randomUUID()): Promise<string> {
  await db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 'Fixture chat', '[]'::jsonb)", [id, userId]);
  return id;
}

type Row = Record<string, unknown>;

async function insertLog(db: PGlite, row: Row = {}): Promise<{ id: string; tenant_key: string }> {
  const values: Row = { trace_id: crypto.randomUUID(), channel: 'chat', pipeline: 'legacy', status: 'ok', ...row };
  const names = Object.keys(values);
  const result = await db.query<{ id: string; tenant_key: string }>(
    `INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, tenant_key`,
    names.map((name) => values[name]),
  );
  return result.rows[0] as { id: string; tenant_key: string };
}

async function countRows(db: PGlite, where: string, params: unknown[]): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM rag_retrieval_log WHERE ${where}`, params)).rows[0]?.n ?? -1;
}

for (const mode of MODES) {
  describe(`rag_retrieval_log schema (${mode})`, () => {
    let db: PGlite;
    let userId: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      userId = await createUser(db);
    });

    after(async () => {
      await db.close();
    });

    test('the table has exactly the D-03 and D-03a columns, and the frozen D-29 names keep their types', async () => {
      const rows = (
        await db.query<{ column_name: string; data_type: string }>(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_retrieval_log'",
        )
      ).rows;
      assert.deepEqual(rows.map((row) => row.column_name).sort(), ALL_COLUMNS);
      const types = Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]));
      for (const [column, type] of Object.entries(FROZEN_COLUMNS)) {
        assert.equal(types[column], type, `${column} is ${types[column]}, expected ${type}`);
      }
      const arrays = (
        await db.query<{ column_name: string; udt_name: string }>(
          "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_retrieval_log' AND data_type = 'ARRAY' ORDER BY column_name",
        )
      ).rows;
      assert.deepEqual(arrays, [
        { column_name: 'chunk_languages', udt_name: '_text' },
        { column_name: 'feedback_reasons', udt_name: '_text' },
      ]);
    });

    test('the (tenant_key, created_at desc), created_at, chat_id and negative-feedback indexes exist', async () => {
      const defs = (
        await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rag_retrieval_log'")
      ).rows.map((row) => row.indexdef);
      assert.ok(defs.some((def) => /\(tenant_key, created_at DESC\)$/.test(def)), defs.join('\n'));
      assert.ok(defs.some((def) => /\(created_at\)$/.test(def)), defs.join('\n'));
      assert.ok(defs.some((def) => /\(chat_id\)$/.test(def)), defs.join('\n'));
      assert.ok(defs.some((def) => /\(tenant_key, created_at\) WHERE \(feedback_vote = '?-1'?/.test(def)), defs.join('\n'));
      assert.ok(defs.some((def) => /UNIQUE INDEX .*\(trace_id\)$/.test(def)), defs.join('\n'));
    });

    test('tenant_key follows the scope key convention', async () => {
      const personal = await insertLog(db, { user_id: userId });
      assert.equal(personal.tenant_key, mode === 'multi-tenant' ? `u:${userId}` : 's:default');
      if (mode === 'multi-tenant') {
        const organizationId = await createOrganization(db, userId);
        const shared = await insertLog(db, { user_id: userId, organization_id: organizationId });
        assert.equal(shared.tenant_key, `o:${organizationId}`);
      }
      await rejectsWith(() => db.query("UPDATE rag_retrieval_log SET tenant_key = 's:default' WHERE id = $1", [personal.id]), '428C9');
    });

    test('defaults: no language values, empty candidates and feedback, outcome unknown', async () => {
      const { id } = await insertLog(db, { user_id: userId });
      const row = (
        await db.query<Row>(
          `SELECT query_language, query_language_confidence, chunk_languages, answer_language, candidates, candidate_count,
                  stage_latency, feedback_vote, feedback_reasons, source_opened_count, outcome
           FROM rag_retrieval_log WHERE id = $1`,
          [id],
        )
      ).rows[0];
      assert.deepEqual(row, {
        query_language: null,
        query_language_confidence: null,
        chunk_languages: [],
        answer_language: null,
        candidates: [],
        candidate_count: 0,
        stage_latency: {},
        feedback_vote: null,
        feedback_reasons: [],
        source_opened_count: 0,
        outcome: 'unknown',
      });
    });

    test('checks reject an unknown channel, outcome, status, pipeline, feedback value and a duplicate trace id', async () => {
      await rejectsWith(() => insertLog(db, { channel: 'media' }), '23514');
      await rejectsWith(() => insertLog(db, { outcome: 'maybe' }), '23514');
      await rejectsWith(() => insertLog(db, { status: 'fine' }), '23514');
      await rejectsWith(() => insertLog(db, { pipeline: 'v3' }), '23514');
      await rejectsWith(() => insertLog(db, { feedback_vote: 0 }), '23514');
      await rejectsWith(() => insertLog(db, { feedback_kind: 'thumbs' }), '23514');
      await rejectsWith(() => insertLog(db, { candidate_count: -1 }), '23514');
      await rejectsWith(() => insertLog(db, { source_opened_count: -1 }), '23514');
      await rejectsWith(() => insertLog(db, { topk_redundancy: 1.5 }), '23514');
      await rejectsWith(() => insertLog(db, { topk_redundancy: -0.1 }), '23514');
      await rejectsWith(() => insertLog(db, { candidates: '{}' }), '23514');
      await rejectsWith(() => insertLog(db, { candidates: JSON.stringify(Array.from({ length: 51 }, (_, rank) => ({ rank }))) }), '23514');
      await rejectsWith(() => insertLog(db, { query_fingerprint: 'not-a-hash' }), '23514');
      await rejectsWith(() => insertLog(db, { query_masked: 'x'.repeat(2001) }), '23514');
      const traceId = crypto.randomUUID();
      await insertLog(db, { trace_id: traceId, feedback_vote: -1, feedback_kind: 'refusal', channel: 'voice', pipeline: 'v2' });
      await rejectsWith(() => insertLog(db, { trace_id: traceId }), '23505');
    });

    test('query_language_confidence is a number between 0 and 1', async () => {
      await rejectsWith(() => insertLog(db, { query_language_confidence: 1.5 }), '23514');
      await rejectsWith(() => insertLog(db, { query_language_confidence: -0.1 }), '23514');
      for (const value of [0, 0.5, 1]) await insertLog(db, { query_language_confidence: value });
    });

    test('query_language and answer_language hold a language code, never text', async () => {
      for (const column of ['query_language', 'answer_language']) {
        for (const bad of ['This is a sentence.', 'English', 'EN', '', 'en-', 'e', 'en-x', 'en\n']) {
          await rejectsWith(() => insertLog(db, { [column]: bad }), '23514');
        }
        for (const good of ['en', 'zh-Hant', 'und', 'it', 'pt-BR']) await insertLog(db, { [column]: good });
      }
    });

    test('chunk_languages holds codes only, with no empty or null element', async () => {
      const ok = await insertLog(db, { chunk_languages: ['en', 'zh', 'und'] });
      const stored = (await db.query<{ chunk_languages: string[] }>('SELECT chunk_languages FROM rag_retrieval_log WHERE id = $1', [ok.id])).rows[0];
      assert.deepEqual(stored?.chunk_languages, ['en', 'zh', 'und']);
      await insertLog(db, { chunk_languages: ['zh-Hant'] });
      await insertLog(db, { chunk_languages: [] });
      for (const bad of [['A sentence here'], ['en', ''], ['en', null], [null], ['en,zh'], ['en;zh'], ['EN'], ['en', 'Text']]) {
        await rejectsWith(() => insertLog(db, { chunk_languages: bad }), '23514');
      }
      await rejectsWith(() => db.query("INSERT INTO rag_retrieval_log (trace_id, channel, pipeline, status, chunk_languages) VALUES ($1, 'chat', 'legacy', 'ok', '{{en},{zh}}')", [crypto.randomUUID()]), '23514');
    });

    test('a row can be written before its chat exists, and deleting the chat later deletes the row', async () => {
      const chatId = crypto.randomUUID();
      const early = await insertLog(db, { user_id: userId, chat_id: chatId });
      const other = await insertLog(db, { user_id: userId, chat_id: crypto.randomUUID() });
      await createChat(db, userId, chatId);
      await db.query('DELETE FROM chats WHERE id = $1', [chatId]);
      assert.equal(await countRows(db, 'id = $1', [early.id]), 0);
      assert.equal(await countRows(db, 'id = $1', [other.id]), 1);
    });

    test('deleting the user deletes their rows', async () => {
      const doomed = await createUser(db);
      const { id } = await insertLog(db, { user_id: doomed });
      const kept = await insertLog(db, { user_id: userId });
      await db.query('DELETE FROM auth.users WHERE id = $1', [doomed]);
      assert.equal(await countRows(db, 'id = $1', [id]), 0);
      assert.equal(await countRows(db, 'id = $1', [kept.id]), 1);
    });

    if (mode === 'multi-tenant') {
      test('deleting the organization deletes its rows', async () => {
        const organizationId = await createOrganization(db, userId);
        const { id } = await insertLog(db, { user_id: userId, organization_id: organizationId });
        await db.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
        assert.equal(await countRows(db, 'id = $1', [id]), 0);
      });
    }

    test('anon and authenticated can neither read nor write; service_role can', async () => {
      const { id } = await insertLog(db, { user_id: userId });
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith(() => asRole(db, role, userId, () => db.query('SELECT id FROM rag_retrieval_log')), '42501');
        await rejectsWith(
          () => asRole(db, role, userId, () => db.query("INSERT INTO rag_retrieval_log (trace_id, channel, pipeline, status) VALUES ($1, 'chat', 'legacy', 'ok')", [crypto.randomUUID()])),
          '42501',
        );
        await rejectsWith(() => asRole(db, role, userId, () => db.query('UPDATE rag_retrieval_log SET feedback_vote = 1 WHERE id = $1', [id])), '42501');
        await rejectsWith(() => asRole(db, role, userId, () => db.query('DELETE FROM rag_retrieval_log WHERE id = $1', [id])), '42501');
      }
      const seen = await asRole(db, 'service_role', null, () => db.query('SELECT id FROM rag_retrieval_log WHERE id = $1', [id]));
      assert.equal(seen.rows.length, 1);
      await asRole(db, 'service_role', null, () =>
        db.query("INSERT INTO rag_retrieval_log (trace_id, channel, pipeline, status, user_id) VALUES ($1, 'embed', 'v2', 'empty', $2)", [crypto.randomUUID(), userId]),
      );
      const privileges = (
        await db.query<Record<string, boolean>>(
          `SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_retrieval_log'::regclass) AS rls,
                  (SELECT count(*) = 0 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rag_retrieval_log') AS no_policy,
                  (SELECT coalesce(bool_or(acl.grantee = 0), false) FROM pg_class c, aclexplode(c.relacl) acl
                    WHERE c.oid = 'public.rag_retrieval_log'::regclass) AS public_grant`,
        )
      ).rows[0];
      assert.deepEqual(privileges, { rls: true, no_policy: true, public_grant: false });
    });

    test('the chat-delete trigger function is SECURITY DEFINER with an empty search_path and not executable by clients', async () => {
      const row = (
        await db.query<Record<string, unknown>>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
           FROM pg_proc p WHERE p.oid = 'public.rag_feedback_loop_on_chat_delete()'::regprocedure`,
        )
      ).rows[0];
      assert.deepEqual(row, { definer: true, config: ['search_path=""'], anon_exec: false, auth_exec: false });
    });

    test('applying 0531 and 0532 a second time is a no-op', async () => {
      const before = await countRows(db, 'true', []);
      await applyMigrationFiles(db, [
        'supabase/migrations/0531_rag_retrieval_log.sql',
        `supabase/migrations/0532_rag_retrieval_log_tenant.${mode}.sql`,
      ]);
      assert.equal(await countRows(db, 'true', []), before);
      const triggers = (
        await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.chats'::regclass AND tgname = 'rag_feedback_loop_chats_delete'")
      ).rows[0]?.n;
      assert.equal(triggers, 1);
    });
  });
}
