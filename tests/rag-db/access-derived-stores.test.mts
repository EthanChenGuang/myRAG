import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import { pgliteClient } from '../helpers/pglite-rest-client.ts';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';

// 04.3-13 (SEC-13, D-25, D-30, A-06, A-13): access_sets on rag_answer_records, rag_retrieval_log and rag_review_items, and the restrictive
// SELECT policies rag_retrieval_log_access_sets and rag_review_items_access_sets. Neutral synthetic data only.

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { insertAnswerRecord, readOwnedAnswerRecord } = await import('@/lib/answers/store');
const { getReviewItem, listReviewItems } = await import('@/lib/rag/feedback-loop/review-access');

const MIGRATION = fs.readFileSync(path.resolve('supabase/migrations/0934_access_derived_stores_sets.sql'), 'utf8');
const OWNER = '00000000-0000-4000-8000-00000000d0a0';
const MEMBER_A = '00000000-0000-4000-8000-00000000d0a1';
const OUTSIDER = '00000000-0000-4000-8000-00000000d0a2';
const ORG = '00000000-0000-4000-8000-00000000d0f1';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

type Row = Record<string, unknown>;

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** A direct authenticated read, as PostgREST runs it: role authenticated with the user's sub claim. */
async function asUser<T = Row>(db: PGlite, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await tx.exec('SET LOCAL ROLE authenticated');
    return (await tx.query<T>(sql, params)).rows;
  });
}

function citation(documentId: string) {
  return {
    n: 1,
    alias: 'S1',
    chunkIds: ['chunk-1'],
    documentId,
    documentName: 'record-1.md',
    documentVersion: 1,
    page: null,
    sectionPath: ['Part one'],
    quote: 'A neutral synthetic clause.',
    quoteHash: crypto.createHash('sha256').update('quote-1').digest('hex'),
    strategy: 'chunk-alias' as const,
  };
}

const PENDING = { status: 'pending' as const, scorer: null, score: null, label: null, threshold: null, thresholdSource: null, reason: null, truncated: false, latencyMs: null, checkedAt: null };

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantKey = multi ? `o:${ORG}` : 's:default';

  describe(`access_sets on derived stores (${mode})`, () => {
    let db: PGlite;
    let groupA: string;
    let scope: TenantScope;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      for (const id of [OWNER, MEMBER_A, OUTSIDER]) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, `user-${id.slice(-4)}@example.invalid`]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'derived-stores', $2, false)", [ORG, OWNER]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member') ON CONFLICT DO NOTHING",
          [ORG, OWNER, MEMBER_A, OUTSIDER],
        );
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-a', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
        scope = mintScope('org', MEMBER_A, ORG);
      } else {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-a', 'Group') RETURNING id"))[0]!.id;
        scope = mintScope('single', null, null);
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupA, MEMBER_A]);
      await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($1, $3)', [tenantKey, MEMBER_A, OUTSIDER]);
    });

    after(async () => {
      await db?.close();
    });

    describe('rag_answer_records', () => {
      test('the store writes the label sets as given and reads them back; keys only', async () => {
        const id = crypto.randomUUID();
        const sets = [[`g:${groupA}`], ['all']];
        const admin = createPgliteAdmin(db, { jsonColumns: ['citations', 'groundedness', 'feedback', 'access_sets'] }) as unknown as SupabaseClient;
        const { inserted } = await insertAnswerRecord(admin, {
          id,
          scope,
          userId: MEMBER_A,
          chatId: null,
          traceId: `trace-${id}`,
          modelId: 'placeholder/model',
          citationStrategy: 'chunk-alias',
          ragMode: 'strict',
          answerLanguage: 'en',
          invalidCitations: 0,
          citations: [citation(crypto.randomUUID())],
          groundedness: PENDING,
          accessSets: sets,
        } as Parameters<typeof insertAnswerRecord>[1]);
        assert.equal(inserted, true);
        const stored = (await rows<{ access_sets: unknown }>(db, 'SELECT access_sets FROM rag_answer_records WHERE id = $1', [id]))[0]!.access_sets;
        assert.deepEqual(stored, sets);
        assert.doesNotMatch(JSON.stringify(stored), /Group|group-a|clause/);
      });

      test('without sets (access off) the column stays NULL, as today', async () => {
        const id = crypto.randomUUID();
        const admin = createPgliteAdmin(db, { jsonColumns: ['citations', 'groundedness', 'feedback'] }) as unknown as SupabaseClient;
        await insertAnswerRecord(admin, {
          id,
          scope,
          userId: MEMBER_A,
          chatId: null,
          traceId: `trace-${id}`,
          modelId: 'placeholder/model',
          citationStrategy: 'chunk-alias',
          ragMode: 'strict',
          answerLanguage: 'en',
          invalidCitations: 0,
          citations: [citation(crypto.randomUUID())],
          groundedness: PENDING,
        });
        const stored = (await rows<{ access_sets: unknown }>(db, 'SELECT access_sets FROM rag_answer_records WHERE id = $1', [id]))[0]!;
        assert.equal(stored.access_sets, null);
      });

      test('the CHECK refuses a non-array value', async () => {
        await assert.rejects(
          db.query("UPDATE rag_answer_records SET access_sets = '{\"k\":1}'::jsonb WHERE user_id = $1", [MEMBER_A]),
          /rag_answer_records_access_sets_check/,
        );
      });

      test('A-13: the owner still reads their own record after leaving the group (no restrictive policy)', async () => {
        const id = crypto.randomUUID();
        const admin = createPgliteAdmin(db, { jsonColumns: ['citations', 'groundedness', 'feedback', 'access_sets'] }) as unknown as SupabaseClient;
        await insertAnswerRecord(admin, {
          id,
          scope,
          userId: MEMBER_A,
          chatId: null,
          traceId: `trace-${id}`,
          modelId: 'placeholder/model',
          citationStrategy: 'chunk-alias',
          ragMode: 'strict',
          answerLanguage: 'en',
          invalidCitations: 0,
          citations: [citation(crypto.randomUUID())],
          groundedness: PENDING,
          accessSets: [[`g:${crypto.randomUUID()}`]],
        });
        const policies = await rows(db, "SELECT policyname FROM pg_policies WHERE tablename = 'rag_answer_records' AND permissive = 'RESTRICTIVE'");
        assert.deepEqual(policies, []);
        const session = createPgliteAdmin(db, { jsonColumns: ['citations', 'groundedness', 'feedback'], asUser: MEMBER_A }) as unknown as SupabaseClient;
        const row = await readOwnedAnswerRecord(session, { id, userId: MEMBER_A });
        assert.equal(row?.id, id);
      });
    });

    describe('rag_review_items', () => {
      let restricted: string;
      let open: string;

      before(async () => {
        const insert = async (sets: unknown, minedAt: string): Promise<string> =>
          (
            await rows<{ id: string }>(
              db,
              `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window, mined_at, access_sets)
               VALUES ($1, $2, 'A synthetic question', $3, 'chat', 'answered', ARRAY['low_score'], $4::jsonb, '2026-11-23T00:00:00Z', $5, $6::jsonb) RETURNING id`,
              [
                tenantKey,
                crypto.randomUUID(),
                crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
                JSON.stringify([{ chunk_id: 'chunk-1', document_id: crypto.randomUUID(), rank: 1, similarity: 0.5, kept: true }]),
                minedAt,
                sets === null ? null : JSON.stringify(sets),
              ],
            )
          )[0]!.id;
        restricted = await insert([[`g:${groupA}`]], '2026-11-24T10:00:00Z');
        open = await insert(null, '2026-11-24T09:00:00Z');
      });

      test('the restrictive SELECT policy exists for authenticated', async () => {
        const policy = await rows<{ permissive: string; roles: string[]; cmd: string }>(
          db,
          "SELECT permissive, roles::text[] AS roles, cmd FROM pg_policies WHERE tablename = 'rag_review_items' AND policyname = 'rag_review_items_access_sets'",
        );
        assert.deepEqual(policy, [{ permissive: 'RESTRICTIVE', roles: ['authenticated'], cmd: 'SELECT' }]);
      });

      test('a member expert reads the restricted item directly; an outsider expert does not; NULL sets stay readable', async () => {
        const member = await asUser<{ id: string }>(db, MEMBER_A, 'SELECT id FROM rag_review_items ORDER BY mined_at DESC');
        assert.deepEqual(member.map((r) => r.id), [restricted, open]);
        const outsider = await asUser<{ id: string }>(db, OUTSIDER, 'SELECT id FROM rag_review_items ORDER BY mined_at DESC');
        assert.deepEqual(outsider.map((r) => r.id), [open]);
      });

      test('a tenant admin reads every set', async () => {
        await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenantKey, OWNER]);
        try {
          const owner = await asUser<{ id: string }>(db, OWNER, 'SELECT id FROM rag_review_items ORDER BY mined_at DESC');
          assert.deepEqual(owner.map((r) => r.id), [restricted, open]);
        } finally {
          await db.query('DELETE FROM rag_domain_experts WHERE tenant_key = $1 AND user_id = $2', [tenantKey, OWNER]);
        }
      });

      test('an outsider cannot label the restricted item directly', async () => {
        const updated = await asUser<{ id: string }>(db, OUTSIDER, "UPDATE rag_review_items SET status = 'triaged' WHERE id = $1 RETURNING id", [restricted]);
        assert.deepEqual(updated, []);
      });

      test('the server reader lists the hidden item masked for an in-tenant expert, in order', async () => {
        const calls: string[] = [];
        const ssr = pgliteClient(db, { role: 'authenticated', userId: OUTSIDER, label: 'ssr', calls }) as unknown as SupabaseClient;
        const admin = pgliteClient(db, { role: 'service_role', label: 'admin', calls }) as unknown as SupabaseClient;
        const plain = await listReviewItems(ssr, {});
        assert.ok(plain.ok);
        assert.deepEqual(plain.items.map((item) => item.id), [open]);
        const masked = await listReviewItems(ssr, {}, { admin, userId: OUTSIDER });
        assert.ok(masked.ok);
        assert.deepEqual(masked.items.map((item) => item.id), [restricted, open]);
        const hidden = masked.items[0]!;
        assert.equal(hidden.query_masked, null);
        assert.deepEqual(hidden.candidates, []);
        assert.equal(hidden.label, null);
        assert.equal(masked.items[1]!.query_masked, 'A synthetic question');
        const detail = await getReviewItem(ssr, admin, restricted, { admin, userId: OUTSIDER });
        assert.ok(detail.ok);
        assert.equal(detail.item.query_masked, null);
        assert.deepEqual(detail.item.candidates, []);
        const memberSsr = pgliteClient(db, { role: 'authenticated', userId: MEMBER_A, label: 'ssr', calls }) as unknown as SupabaseClient;
        const full = await listReviewItems(memberSsr, {}, { admin, userId: MEMBER_A });
        assert.ok(full.ok);
        assert.equal(full.items[0]!.query_masked, 'A synthetic question');
      });

      test('a user who is no expert of the tenant gets nothing, masked or not', async () => {
        const stranger = crypto.randomUUID();
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [stranger, 'stranger@example.invalid']);
        const calls: string[] = [];
        const ssr = pgliteClient(db, { role: 'authenticated', userId: stranger, label: 'ssr', calls }) as unknown as SupabaseClient;
        const admin = pgliteClient(db, { role: 'service_role', label: 'admin', calls }) as unknown as SupabaseClient;
        const listed = await listReviewItems(ssr, {}, { admin, userId: stranger });
        assert.ok(listed.ok);
        assert.deepEqual(listed.items, []);
        const detail = await getReviewItem(ssr, admin, restricted, { admin, userId: stranger });
        assert.deepEqual(detail, { ok: false, reason: 'not_found' });
      });
    });

    describe('rag_retrieval_log', () => {
      let logId: string;

      before(async () => {
        logId = (
          await rows<{ id: string }>(
            db,
            `INSERT INTO rag_retrieval_log (trace_id, user_id, organization_id, channel, pipeline, status, access_sets)
             VALUES ($1, $2, $3, 'chat', 'v2', 'ok', $4::jsonb) RETURNING id`,
            [`trace-${crypto.randomUUID()}`, MEMBER_A, multi ? ORG : null, JSON.stringify([[`g:${groupA}`]])],
          )
        )[0]!.id;
      });

      test('no client role has SELECT and no permissive policy exists; the restrictive policy is listed', async () => {
        const privileges = await rows<{ anon: boolean; authenticated: boolean }>(
          db,
          "SELECT has_table_privilege('anon', 'public.rag_retrieval_log', 'SELECT') AS anon, has_table_privilege('authenticated', 'public.rag_retrieval_log', 'SELECT') AS authenticated",
        );
        assert.deepEqual(privileges, [{ anon: false, authenticated: false }]);
        const policies = await rows<{ policyname: string; permissive: string; roles: string[]; cmd: string }>(
          db,
          "SELECT policyname, permissive, roles::text[] AS roles, cmd FROM pg_policies WHERE tablename = 'rag_retrieval_log' ORDER BY policyname",
        );
        assert.deepEqual(policies, [{ policyname: 'rag_retrieval_log_access_sets', permissive: 'RESTRICTIVE', roles: ['authenticated'], cmd: 'SELECT' }]);
      });

      test('after a simulated grant and permissive policy the row stays hidden from an outsider (rolled back)', async () => {
        await db.exec('BEGIN');
        try {
          await db.exec('GRANT SELECT ON public.rag_retrieval_log TO authenticated');
          await db.exec('CREATE POLICY simulated_open ON public.rag_retrieval_log FOR SELECT TO authenticated USING (true)');
          const read = async (userId: string): Promise<string[]> => {
            await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
            await db.exec('SET LOCAL ROLE authenticated');
            try {
              return (await db.query<{ id: string }>('SELECT id FROM public.rag_retrieval_log WHERE id = $1', [logId])).rows.map((r) => r.id);
            } finally {
              await db.exec('RESET ROLE');
            }
          };
          assert.deepEqual(await read(OUTSIDER), []);
          assert.deepEqual(await read(MEMBER_A), [logId]);
          assert.deepEqual(await read(OWNER), [logId]);
        } finally {
          await db.exec('ROLLBACK');
        }
        const after = await rows(db, "SELECT policyname FROM pg_policies WHERE tablename = 'rag_retrieval_log' AND policyname = 'simulated_open'");
        assert.deepEqual(after, []);
      });
    });

    describe('rag_caller_reads_access_sets', () => {
      test('is SECURITY DEFINER with an empty search_path, executable by authenticated and service_role only', async () => {
        const info = await rows<{ definer: boolean; config: string[]; anon: boolean; authenticated: boolean; service: boolean }>(
          db,
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_caller_reads_access_sets'`,
        );
        assert.deepEqual(info, [{ definer: true, config: ['search_path=""'], anon: false, authenticated: true, service: true }]);
      });

      test('fails closed on malformed sets and for a caller without identity', async () => {
        const check = async (userId: string, sets: string) =>
          (await asUser<{ ok: boolean }>(db, userId, 'SELECT public.rag_caller_reads_access_sets($1, $2::jsonb) AS ok', [tenantKey, sets]))[0]!.ok;
        assert.equal(await check(MEMBER_A, `[["g:${groupA}"]]`), true);
        assert.equal(await check(MEMBER_A, `[["g:${groupA}"],["g:${crypto.randomUUID()}"]]`), false);
        assert.equal(await check(MEMBER_A, '[["all"]]'), true);
        assert.equal(await check(MEMBER_A, `["g:${groupA}"]`), false);
        assert.equal(await check(MEMBER_A, '{"a":1}'), false);
        assert.equal(await check('', '[["all"]]'), false);
      });
    });
  });
}

describe('guarded path without the Phase 5.1.1 tables (D-30)', () => {
  let db: PGlite;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' }));
  });

  after(async () => {
    await db?.close();
  });

  test('0934 applies without the tables and completes when re-run after they exist', async () => {
    await db.exec('DROP TABLE public.rag_review_items, public.rag_retrieval_log CASCADE');
    await db.exec(MIGRATION);
    assert.deepEqual(await rows(db, "SELECT policyname FROM pg_policies WHERE policyname LIKE '%_access_sets'"), []);

    await db.exec(`
      CREATE TABLE public.rag_retrieval_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_key text NOT NULL);
      CREATE TABLE public.rag_review_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_key text NOT NULL);
      ALTER TABLE public.rag_retrieval_log ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.rag_review_items ENABLE ROW LEVEL SECURITY;
    `);
    await db.exec(MIGRATION);
    const columns = await rows<{ table_name: string }>(
      db,
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'access_sets' AND table_name IN ('rag_retrieval_log', 'rag_review_items') ORDER BY table_name",
    );
    assert.deepEqual(columns.map((c) => c.table_name), ['rag_retrieval_log', 'rag_review_items']);
    const policies = await rows<{ policyname: string }>(db, "SELECT policyname FROM pg_policies WHERE policyname LIKE '%_access_sets' ORDER BY policyname");
    assert.deepEqual(policies.map((p) => p.policyname), ['rag_retrieval_log_access_sets', 'rag_review_items_access_sets']);
    await db.exec(MIGRATION);
  });
});
