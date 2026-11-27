import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants';

type Row = Record<string, unknown>;

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const USER_A = '00000000-0000-4000-8000-0000000006a1';
const USER_B = '00000000-0000-4000-8000-0000000006b1';
const PLAIN = '00000000-0000-4000-8000-0000000006c1';

const SIGNATURES = [
  'public.rag_nango_owner_tenant_key(uuid)',
  'public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[])',
  'public.rag_source_reconcile_run_decide(uuid, uuid, text)',
  'public.rag_source_reconcile_run_finish(uuid, integer, integer)',
  'public.rag_source_sync_admin_connections(uuid, integer, integer)',
  'public.rag_source_sync_set_deletion_mode(uuid, uuid, text)',
];

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | undefined> {
  try {
    await db.query(sql, params);
    return undefined;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? 'unknown', message: e.message ?? '' };
  }
}

const recordSql =
  'SELECT * FROM public.rag_source_reconcile_run_record(p_tenant_key => $1, p_connection_id => $2, p_origin => $3, p_status => $4, p_counts => $5::jsonb, p_candidate_file_ids => $6::text[])';
const decideSql = 'SELECT * FROM public.rag_source_reconcile_run_decide(p_actor => $1, p_run_id => $2, p_decision => $3)';
const finishSql = 'SELECT * FROM public.rag_source_reconcile_run_finish(p_run_id => $1, p_removed => $2, p_failed => $3)';
const listSql = 'SELECT * FROM public.rag_source_sync_admin_connections(p_actor => $1, p_limit => $2, p_offset => $3)';
const modeSql = 'SELECT * FROM public.rag_source_sync_set_deletion_mode(p_actor => $1, p_connection_id => $2, p_mode => $3)';

for (const mode of MODES) {
  describe(`source reconcile runs and admin connection functions (${mode})`, () => {
    let db: PGlite;
    const keyOf = (user: string) => (mode === 'multi-tenant' ? `u:${user}` : 's:default');

    const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;
    const connection = async (owner: string): Promise<{ id: string; nangoId: string }> => {
      const id = crypto.randomUUID();
      const nangoId = `conn-${id}`;
      await db.query("INSERT INTO public.nango_connections (id, user_id, connection_id, provider, status, connected_at) VALUES ($1, $2, $3, $4, 'connected', now())", [
        id,
        owner,
        nangoId,
        `provider-${id.slice(0, 8)}`,
      ]);
      return { id, nangoId };
    };
    const connectionRow = async (id: string): Promise<Row> =>
      (await rows('SELECT deletion_mode, last_full_reconcile_at, last_reconcile_status FROM public.nango_connections WHERE id = $1', [id]))[0]!;
    const runRow = async (id: string): Promise<Row> => (await rows('SELECT * FROM public.rag_source_reconcile_runs WHERE id = $1', [id]))[0]!;
    const awaiting = async (owner: string, c: { id: string }, ids = ['file-1', 'file-2', 'file-3']): Promise<string> => {
      const r = await rows(recordSql, [keyOf(owner), c.id, 'scheduled', 'awaiting_confirmation', JSON.stringify({ listed: 4, total: 10, candidates: ids.length }), ids]);
      return String(r[0]!.run_id);
    };
    const addNangoDocument = async (owner: string, nangoId: string, current = true): Promise<void> => {
      const id = crypto.randomUUID();
      if (mode === 'multi-tenant') {
        await db.query(
          "INSERT INTO public.documents (id, filename, content, metadata, user_id, source, source_connection_id, source_file_id) VALUES ($1, $2, 'neutral', '{}'::jsonb, $3, 'nango', $4, $5)",
          [id, `doc-${id}.txt`, owner, nangoId, `file-${id}`],
        );
      } else {
        await db.query(
          "INSERT INTO public.documents (id, filename, content, metadata, source, source_connection_id, source_file_id) VALUES ($1, $2, 'neutral', '{}'::jsonb, 'nango', $3, $4)",
          [id, `doc-${id}.txt`, nangoId, `file-${id}`],
        );
      }
      if (!current) await db.query('UPDATE public.documents SET is_current = false WHERE id = $1', [id]);
    };

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
        USER_A,
        'source-a@example.invalid',
        USER_B,
        'source-b@example.invalid',
        PLAIN,
        'source-plain@example.invalid',
      ]);
      await db.query('INSERT INTO public.admin_users (id) VALUES ($1), ($2)', [USER_A, USER_B]);
    });

    after(async () => {
      await db?.close();
    });

    test('rag_nango_owner_tenant_key matches scopeKey(nangoOwnerScope) for the mode', async () => {
      const r = await rows('SELECT public.rag_nango_owner_tenant_key($1::uuid) AS k', [USER_A.toUpperCase()]);
      assert.equal(r[0]!.k, keyOf(USER_A));
    });

    test('a completed sync or scheduled run advances last_full_reconcile_at and sets ok', async () => {
      for (const origin of ['sync', 'scheduled']) {
        const c = await connection(USER_A);
        const r = await rows(recordSql, [keyOf(USER_A), c.id, origin, 'completed', JSON.stringify({ listed: 3, total: 3 }), []]);
        assert.equal(r.length, 1);
        assert.equal(r[0]!.expires_at, null);
        const conn = await connectionRow(c.id);
        assert.ok(conn.last_full_reconcile_at instanceof Date, `${origin}: timestamp moves`);
        assert.equal(conn.last_reconcile_status, 'ok');
        const run = await runRow(String(r[0]!.run_id));
        assert.equal(run.status, 'completed');
        assert.equal(run.origin, origin);
        assert.equal(run.tenant_key, keyOf(USER_A));
        assert.equal(run.listed_count, 3);
        assert.equal(run.total_count, 3);
        assert.equal(run.candidate_count, 0);
      }
    });

    test('incomplete and failed runs set the status without moving the timestamp', async () => {
      const c = await connection(USER_A);
      await rows(recordSql, [keyOf(USER_A), c.id, 'sync', 'completed', '{}', []]);
      const stamp = (await connectionRow(c.id)).last_full_reconcile_at as Date;
      for (const status of ['incomplete', 'failed']) {
        await rows(recordSql, [keyOf(USER_A), c.id, 'scheduled', status, JSON.stringify({ error_code: 'listing_error' }), []]);
        const conn = await connectionRow(c.id);
        assert.equal(conn.last_reconcile_status, status);
        assert.equal((conn.last_full_reconcile_at as Date).getTime(), stamp.getTime(), `${status} keeps the timestamp`);
      }
      const fresh = await connection(USER_A);
      await rows(recordSql, [keyOf(USER_A), fresh.id, 'change_feed', 'completed', '{}', []]);
      assert.equal((await connectionRow(fresh.id)).last_full_reconcile_at, null, 'a change-feed run is not a full listing');
    });

    test('an awaiting run pauses the connection, stores the candidates and expires 24 hours after creation', async () => {
      const c = await connection(USER_A);
      const runId = await awaiting(USER_A, c);
      const run = await runRow(runId);
      assert.equal(run.status, 'awaiting_confirmation');
      assert.deepEqual(run.candidate_file_ids, ['file-1', 'file-2', 'file-3']);
      assert.equal(run.candidate_count, 3);
      assert.equal((run.expires_at as Date).getTime() - (run.created_at as Date).getTime(), 24 * 3600 * 1000);
      assert.equal((await connectionRow(c.id)).last_reconcile_status, 'paused');
      assert.equal((await connectionRow(c.id)).last_full_reconcile_at, null);
    });

    test('record refuses bad arguments, foreign tenant keys and keys of the other mode', async () => {
      const c = await connection(USER_A);
      assert.match((await failure(db, recordSql, [keyOf(USER_A), c.id, 'webhook', 'completed', '{}', []]))!.message, /^invalid_argument$/);
      assert.match((await failure(db, recordSql, [keyOf(USER_A), c.id, 'sync', 'confirmed', '{}', []]))!.message, /^invalid_argument$/);
      assert.match((await failure(db, recordSql, [keyOf(USER_A), c.id, 'sync', 'completed', JSON.stringify({ listed: -1 }), []]))!.message, /^invalid_argument$/);
      const tooMany = Array.from({ length: 2001 }, (_, i) => `f-${i}`);
      assert.match((await failure(db, recordSql, [keyOf(USER_A), c.id, 'sync', 'awaiting_confirmation', '{}', tooMany]))!.message, /^invalid_argument$/);
      assert.match((await failure(db, recordSql, [keyOf(USER_A), crypto.randomUUID(), 'sync', 'completed', '{}', []]))!.message, /^not_found$/);
      const otherMode = mode === 'multi-tenant' ? 's:default' : `u:${USER_A}`;
      assert.equal((await failure(db, recordSql, [otherMode, c.id, 'sync', 'completed', '{}', []]))?.code, '22023');
      if (mode === 'multi-tenant') {
        assert.match((await failure(db, recordSql, [keyOf(USER_B), c.id, 'sync', 'completed', '{}', []]))!.message, /^tenant_mismatch$/);
      }
      assert.equal((await connectionRow(c.id)).last_reconcile_status, null, 'refused calls change nothing');
    });

    test('confirm within the window returns the candidates and marks the run confirmed; finish stores counts', async () => {
      const c = await connection(USER_A);
      const runId = await awaiting(USER_A, c);
      const r = await rows(decideSql, [USER_A, runId, 'confirm']);
      assert.equal(r.length, 1);
      assert.equal(r[0]!.connection_id, c.id);
      assert.equal(r[0]!.owner_user_id, USER_A);
      assert.equal(r[0]!.tenant_key, keyOf(USER_A));
      assert.deepEqual(r[0]!.candidate_file_ids, ['file-1', 'file-2', 'file-3']);
      const run = await runRow(runId);
      assert.equal(run.status, 'confirmed');
      assert.equal(run.decided_by, USER_A);
      assert.ok(run.decided_at instanceof Date);

      assert.match((await failure(db, decideSql, [USER_A, runId, 'confirm']))!.message, /^run_not_pending$/);
      assert.match((await failure(db, finishSql, [runId, -1, 0]))!.message, /^invalid_argument$/);

      await rows(finishSql, [runId, 3, 0]);
      const finished = await runRow(runId);
      assert.equal(finished.removed_count, 3);
      assert.equal(finished.failed_count, 0);
      assert.equal((await connectionRow(c.id)).last_reconcile_status, 'ok');
      assert.match((await failure(db, finishSql, [runId, 3, 0]))!.message, /^run_not_pending$/, 'a run is finished once');
      assert.match((await failure(db, finishSql, [crypto.randomUUID(), 0, 0]))!.message, /^not_found$/);
    });

    test('finish with failures keeps the connection paused', async () => {
      const c = await connection(USER_A);
      const runId = await awaiting(USER_A, c);
      await rows(decideSql, [USER_A, runId, 'confirm']);
      await rows(finishSql, [runId, 2, 1]);
      assert.equal((await connectionRow(c.id)).last_reconcile_status, 'paused');
      const pending = await awaiting(USER_A, c);
      assert.match((await failure(db, finishSql, [pending, 0, 0]))!.message, /^run_not_pending$/, 'only a confirmed run is finished');
    });

    test('dismiss marks the run dismissed and returns nothing to remove', async () => {
      const c = await connection(USER_A);
      const runId = await awaiting(USER_A, c);
      const r = await rows(decideSql, [USER_A, runId, 'dismiss']);
      assert.equal(r.length, 1);
      assert.deepEqual(r[0]!.candidate_file_ids, []);
      assert.equal((await runRow(runId)).status, 'dismissed');
      assert.match((await failure(db, decideSql, [USER_A, runId, 'maybe']))!.message, /^invalid_argument$/);
    });

    test('a confirmation more than 24 hours after the run is refused with confirmation_expired and the run becomes expired', async () => {
      const c = await connection(USER_A);
      const runId = await awaiting(USER_A, c);
      await db.query("UPDATE public.rag_source_reconcile_runs SET created_at = now() - interval '24 hours 1 second', expires_at = now() - interval '1 second' WHERE id = $1", [runId]);
      assert.match((await failure(db, decideSql, [USER_A, runId, 'confirm']))!.message, /^confirmation_expired$/);
      // The refusal rolls back its own statement; the next read of the connection list records the expiry.
      await rows(listSql, [USER_A, 100, 0]);
      assert.equal((await runRow(runId)).status, 'expired');
      assert.match((await failure(db, decideSql, [USER_A, runId, 'confirm']))!.message, /^run_not_pending$/);

      const edge = await awaiting(USER_A, c);
      await db.query("UPDATE public.rag_source_reconcile_runs SET created_at = now() - interval '23 hours 59 minutes', expires_at = now() + interval '1 minute' WHERE id = $1", [edge]);
      const ok = await rows(decideSql, [USER_A, edge, 'confirm']);
      assert.equal(ok.length, 1, 'inside 24 hours the confirmation is accepted');

      const dismissLate = await awaiting(USER_A, c);
      await db.query("UPDATE public.rag_source_reconcile_runs SET expires_at = now() - interval '1 second' WHERE id = $1", [dismissLate]);
      const d = await rows(decideSql, [USER_A, dismissLate, 'dismiss']);
      assert.equal(d[0]!.status, 'expired', 'dismissing a run past its window records it as expired');
      assert.equal((await runRow(dismissLate)).status, 'expired');
    });

    test('set_deletion_mode accepts NULL, soft and purge and nothing else, and changes nothing else', async () => {
      const c = await connection(USER_A);
      await rows(recordSql, [keyOf(USER_A), c.id, 'sync', 'completed', '{}', []]);
      const before = await connectionRow(c.id);
      for (const value of ['soft', 'purge', null]) {
        const r = await rows(modeSql, [USER_A, c.id, value]);
        assert.equal(r[0]!.deletion_mode, value);
        const now = await connectionRow(c.id);
        assert.equal(now.deletion_mode, value);
        assert.equal(now.last_reconcile_status, before.last_reconcile_status);
        assert.equal((now.last_full_reconcile_at as Date).getTime(), (before.last_full_reconcile_at as Date).getTime());
      }
      assert.match((await failure(db, modeSql, [USER_A, c.id, 'hard']))!.message, /^invalid_argument$/);
      assert.match((await failure(db, modeSql, [USER_A, crypto.randomUUID(), 'soft']))!.message, /^not_found$/);
      assert.match((await failure(db, modeSql, [PLAIN, c.id, 'soft']))!.message, /not_admin/);
    });

    test('admin_connections lists the admin tenant connections with counts and the newest awaiting run', async () => {
      const c = await connection(USER_A);
      await addNangoDocument(USER_A, c.nangoId);
      await addNangoDocument(USER_A, c.nangoId);
      await addNangoDocument(USER_A, c.nangoId, false);
      await awaiting(USER_A, c, ['old-1']);
      const newest = await awaiting(USER_A, c, ['new-1', 'new-2']);
      await db.query("UPDATE public.rag_source_reconcile_runs SET created_at = created_at + interval '1 second' WHERE id = $1", [newest]);
      const list = await rows(listSql, [USER_A, 100, 0]);
      const mine = list.find((row) => row.connection_id === c.id);
      assert.ok(mine, 'own connection listed');
      assert.equal(mine.owner_user_id, USER_A);
      assert.equal(mine.tenant_key, keyOf(USER_A));
      assert.equal(mine.status, 'connected');
      assert.equal(Number(mine.document_count), 2, 'current nango documents only');
      assert.equal(mine.awaiting_run_id, newest);
      assert.equal(mine.awaiting_candidate_count, 2);
      assert.equal(mine.awaiting_total_count, 10);
      assert.ok(mine.awaiting_expires_at instanceof Date);
      assert.equal(Number(mine.total_rows), list.length);
      assert.ok(!('provider_config_key' in mine));
      const paged = await rows(listSql, [USER_A, 1, 0]);
      assert.equal(paged.length, 1);
      assert.equal(Number(paged[0]!.total_rows), list.length);
      assert.match((await failure(db, listSql, [USER_A, 0, 0]))!.message, /^invalid_argument$/);
      assert.match((await failure(db, listSql, [USER_A, 10, -1]))!.message, /^invalid_argument$/);
      assert.match((await failure(db, listSql, [PLAIN, 10, 0]))!.message, /not_admin/);
    });

    if (mode === 'multi-tenant') {
      test('another tenant run or connection and an unknown id answer the same not_found', async () => {
        const b = await connection(USER_B);
        const bRun = await awaiting(USER_B, b);
        const unknown = crypto.randomUUID();
        const foreign = await failure(db, decideSql, [USER_A, bRun, 'confirm']);
        const missing = await failure(db, decideSql, [USER_A, unknown, 'confirm']);
        assert.equal(foreign?.message, 'not_found');
        assert.equal(missing?.message, foreign?.message);
        assert.equal(foreign?.code, missing?.code);
        assert.equal((await runRow(bRun)).status, 'awaiting_confirmation');

        assert.equal((await failure(db, modeSql, [USER_A, b.id, 'purge']))?.message, 'not_found');
        assert.equal((await connectionRow(b.id)).deletion_mode, null, 'another user keeps a NULL mode (D-41)');

        const listA = await rows(listSql, [USER_A, 100, 0]);
        assert.ok(listA.every((row) => row.owner_user_id === USER_A), 'only the admin own connections');
        assert.ok(!listA.some((row) => row.connection_id === b.id));
        const listB = await rows(listSql, [USER_B, 100, 0]);
        assert.ok(listB.some((row) => row.connection_id === b.id));
      });
    } else {
      test('single-tenant: every admin sees every connection of s:default', async () => {
        const b = await connection(USER_B);
        const list = await rows(listSql, [USER_A, 100, 0]);
        assert.ok(list.some((row) => row.connection_id === b.id));
        const r = await rows(modeSql, [USER_A, b.id, 'soft']);
        assert.equal(r[0]!.deletion_mode, 'soft');
      });
    }

    test('the runs table is server-only and stores no file names', async () => {
      const meta = await rows(
        `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c WHERE c.oid = 'public.rag_source_reconcile_runs'::regclass`,
      );
      assert.deepEqual(meta[0], { rls: true, policies: 0 });
      const columns = (await rows("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_source_reconcile_runs'")).map(
        (row) => String(row.column_name),
      );
      assert.ok(!columns.some((name) => /name|title|content|text/.test(name)), columns.join(','));
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          assert.equal((await failure(db, 'SELECT * FROM public.rag_source_reconcile_runs'))?.code, '42501');
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      await db.exec('SET ROLE service_role');
      try {
        assert.equal((await failure(db, 'SELECT count(*) FROM public.rag_source_reconcile_runs')), undefined);
        assert.equal(
          (await failure(db, "UPDATE public.rag_source_reconcile_runs SET status = 'confirmed'"))?.code,
          '42501',
          'writes go through the functions',
        );
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    test('anon and authenticated get 42501 on every function; each is SECURITY DEFINER with an empty search_path', async () => {
      const c = await connection(USER_A);
      const calls: Array<[string, unknown[]]> = [
        ['SELECT public.rag_nango_owner_tenant_key($1::uuid)', [USER_A]],
        [recordSql, [keyOf(USER_A), c.id, 'sync', 'completed', '{}', []]],
        [decideSql, [USER_A, crypto.randomUUID(), 'confirm']],
        [finishSql, [crypto.randomUUID(), 0, 0]],
        [listSql, [USER_A, 10, 0]],
        [modeSql, [USER_A, c.id, 'soft']],
      ];
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          for (const [sql, params] of calls) assert.equal((await failure(db, sql, params))?.code, '42501', `${role}: ${sql}`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      for (const signature of SIGNATURES) {
        const r = await rows(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [signature],
        );
        assert.equal(r.length, 1, `${signature} exists`);
        assert.equal(r[0]!.definer, true, `${signature} is SECURITY DEFINER`);
        assert.ok((r[0]!.config as string[]).some((entry) => entry === 'search_path=""'), `${signature} search_path`);
        assert.equal(r[0]!.service, true);
      }
      const overloads = await rows(
        "SELECT proname, count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'rag\\_source\\_%' OR proname = 'rag_nango_owner_tenant_key') GROUP BY proname HAVING count(*) > 1",
      );
      assert.deepEqual(overloads, []);
      await assertNoClientCallableRagFunctions(db);
    });
  });
}
