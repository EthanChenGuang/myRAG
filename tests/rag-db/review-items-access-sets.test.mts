import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { pgliteClient } from '../helpers/pglite-rest-client.ts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';
import { AUTHENTICATED_ALLOW_LIST, normalizeSignature } from '../helpers/security-definer-allow-list.ts';

// 0984: the review-queue writers rag_mine_failed_queries and rag_enqueue_review_item carry access_sets, so 0934's restrictive policy
// rag_review_items_access_sets hides a new item from an expert outside the document's access group. Neutral synthetic data only.

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { getReviewItemChunks } = await import('@/lib/rag/feedback-loop/review-access');

type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0984_review_items_access_sets.sql';
const GRANTS_MIGRATION = 'supabase/migrations/0410_security_definer_rpc_grants.sql';
const ENQUEUE = 'rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb)';
const OLD_ENQUEUE = 'rag_enqueue_review_item(text, text, jsonb, jsonb)';
const HELPER = 'rag_review_access_sets(text, jsonb, uuid[], boolean)';
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/feedback-mining.json'), 'utf8')) as Row;
const SINCE = '2026-11-16T00:00:00Z';
const UNTIL = '2026-11-23T00:00:00Z';
const INSIDE = '2026-11-20T12:00:00Z';
const OWNER = '00000000-0000-4000-8000-00000000e0a0';
const MEMBER = '00000000-0000-4000-8000-00000000e0a1';
const OUTSIDER = '00000000-0000-4000-8000-00000000e0a2';
const ORG = '00000000-0000-4000-8000-00000000e0f1';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asUser<T = Row>(db: PGlite, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await tx.exec('SET LOCAL ROLE authenticated');
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function asService<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return (await tx.query<T>(sql, params)).rows;
  });
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function setEnforced(db: PGlite, enforced: boolean): Promise<void> {
  await db.query('UPDATE public.rag_access_group_settings SET enforced = $1 WHERE id', [enforced]);
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantKey = multi ? `o:${ORG}` : 's:default';

  describe(`review-queue writers carry access_sets (${mode})`, () => {
    let db: PGlite;
    let groupA: string;
    let restrictedDoc: string;
    let restrictedChunk: string;
    let openDoc: string;
    let openChunk: string;
    let counter = 0;

    async function createDocument(labels: string[]): Promise<{ documentId: string; chunkId: string }> {
      const documentId = crypto.randomUUID();
      const chunkId = crypto.randomUUID();
      await db.query(
        "INSERT INTO documents (id, filename, content, user_id, organization_id) VALUES ($1, 'fixture.txt', 'A neutral synthetic body.', $2, $3)",
        [documentId, OWNER, multi ? ORG : null],
      );
      await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [documentId, labels]);
      await db.query(
        "INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, 'A neutral synthetic sentence.', 0, '{}'::jsonb)",
        [chunkId, documentId],
      );
      await db.query('UPDATE document_chunks SET access_groups = $2::text[] WHERE id = $1', [chunkId, labels]);
      return { documentId, chunkId };
    }

    async function enqueue(reason: string, source: Row): Promise<string> {
      const result = await asService<{ id: string }>(db, 'SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb) AS id', [
        tenantKey,
        reason,
        JSON.stringify(source),
        JSON.stringify({ detector: 'rules' }),
      ]);
      return result[0]!.id;
    }

    async function setsOf(id: string): Promise<unknown> {
      return (await rows<{ access_sets: unknown }>(db, 'SELECT access_sets FROM rag_review_items WHERE id = $1', [id]))[0]?.access_sets;
    }

    async function visibleTo(userId: string, id: string): Promise<boolean> {
      return (await asUser(db, userId, 'SELECT id FROM public.rag_review_items WHERE id = $1', [id])).length === 1;
    }

    async function insertLog(fields: Row): Promise<string> {
      counter += 1;
      const question = `Synthetic question number ${counter} about the sample topic`;
      const values: Row = {
        trace_id: crypto.randomUUID(),
        user_id: OWNER,
        organization_id: multi ? ORG : null,
        channel: 'chat',
        pipeline: 'legacy',
        status: 'ok',
        outcome: 'answered',
        candidate_count: 1,
        top_score: 0.01,
        created_at: INSIDE,
        query_masked: question,
        query_fingerprint: fingerprintOf(question),
        ...fields,
      };
      const names = Object.keys(values);
      const inserted = await rows<{ id: string }>(
        db,
        `INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((name, i) => (name === 'candidates' || name === 'access_sets' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')}) RETURNING id`,
        names.map((name) => (name === 'candidates' || name === 'access_sets' ? JSON.stringify(values[name]) : values[name])),
      );
      return inserted[0]!.id;
    }

    async function mine(): Promise<void> {
      await db.query('SELECT * FROM public.rag_mine_failed_queries($1, $2, $3)', [SINCE, UNTIL, JSON.stringify(CONFIG)]);
    }

    async function minedItem(logId: string): Promise<{ id: string; access_sets: unknown }> {
      const found = await rows<{ id: string; access_sets: unknown }>(db, 'SELECT id, access_sets FROM rag_review_items WHERE retrieval_log_id = $1', [logId]);
      assert.equal(found.length, 1, 'mining wrote one item for the log row');
      return found[0]!;
    }

    function candidate(documentId: string, chunkId: string): Row {
      return { chunk_id: chunkId, document_id: documentId, rank: 1, similarity: 0.01 };
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      for (const id of [OWNER, MEMBER, OUTSIDER]) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, `user-${id.slice(-4)}@example.invalid`]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'review-sets', $2, false)", [ORG, OWNER]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member') ON CONFLICT DO NOTHING",
          [ORG, OWNER, MEMBER, OUTSIDER],
        );
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-a', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
      } else {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-a', 'Group') RETURNING id"))[0]!.id;
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupA, MEMBER]);
      await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($1, $3), ($1, $4) ON CONFLICT DO NOTHING', [tenantKey, MEMBER, OUTSIDER, OWNER]);
      ({ documentId: restrictedDoc, chunkId: restrictedChunk } = await createDocument([`g:${groupA}`]));
      ({ documentId: openDoc, chunkId: openChunk } = await createDocument(['all']));
    });

    beforeEach(async () => {
      await db.query('DELETE FROM rag_review_items');
      await db.query('DELETE FROM rag_retrieval_log');
      await setEnforced(db, true);
    });

    after(async () => {
      await db?.close();
    });

    describe('rag_enqueue_review_item', () => {
      test('with access on, an item about a restricted chunk carries its document label set and is hidden from an outside expert', async () => {
        const id = await enqueue('output_guard', { chunk_ids: [restrictedChunk] });
        assert.deepEqual(await setsOf(id), [[`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, id), false);
        assert.equal(await visibleTo(MEMBER, id), true);
        assert.equal(await visibleTo(OWNER, id), true);
      });

      test('one sorted set per document, for chunk and document ids together', async () => {
        const id = await enqueue('version_conflict', { chunk_ids: [openChunk], document_ids: [restrictedDoc] });
        assert.deepEqual(await setsOf(id), [['all'], [`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, id), false);
      });

      test('p_access_sets given by the caller is normalised and merged with the label sets read in SQL', async () => {
        const other = crypto.randomUUID();
        const given = [[`g:${other}`, `g:${groupA}`, `g:${other}`]];
        const result = await asService<{ id: string }>(
          db,
          'SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb, $5::jsonb) AS id',
          [tenantKey, 'output_guard', JSON.stringify({ chunk_ids: [openChunk] }), '{}', JSON.stringify(given)],
        );
        const expected = [['all'], [`g:${groupA}`, `g:${other}`].sort()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(await setsOf(result[0]!.id), expected);
      });

      test('malformed p_access_sets is refused with 22023 and writes nothing', async () => {
        for (const bad of ['{"a":1}', '["all"]', '[[]]', '[["Group name"]]', '[[1]]']) {
          await assert.rejects(
            () =>
              asService(db, 'SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)', [
                tenantKey,
                'output_guard',
                JSON.stringify({ chunk_ids: [restrictedChunk] }),
                '{}',
                bad,
              ]),
            (error: unknown) => sqlState(error) === '22023',
            bad,
          );
        }
        assert.equal((await rows(db, 'SELECT id FROM rag_review_items')).length, 0);
      });

      test('with access off the item is written with access_sets NULL and every expert of the tenant sees it, as today', async () => {
        await setEnforced(db, false);
        const id = await enqueue('output_guard', { chunk_ids: [restrictedChunk] });
        assert.equal(await setsOf(id), null);
        assert.equal(await visibleTo(OUTSIDER, id), true);
        assert.equal(await visibleTo(MEMBER, id), true);
      });
    });

    describe('rag_mine_failed_queries', () => {
      test('copies the log row access_sets onto the mined item', async () => {
        const logId = await insertLog({ candidates: [candidate(openDoc, openChunk)], access_sets: [[`g:${groupA}`]] });
        await mine();
        const item = await minedItem(logId);
        assert.deepEqual(item.access_sets, [['all'], [`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, item.id), false);
        assert.equal(await visibleTo(MEMBER, item.id), true);
      });

      test('a log row written without sets still gets the candidates label sets while access is on', async () => {
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)] });
        await mine();
        const item = await minedItem(logId);
        assert.deepEqual(item.access_sets, [[`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, item.id), false);
      });

      test('the chunks route gives an outside expert nothing for the restricted item; the member gets the evidence', async () => {
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)] });
        await mine();
        const item = await minedItem(logId);
        const admin = pgliteClient(db, { role: 'service_role', label: 'admin', calls: [] }) as unknown as SupabaseClient;
        const outsider = pgliteClient(db, { role: 'authenticated', userId: OUTSIDER, label: 'ssr', calls: [] }) as unknown as SupabaseClient;
        assert.deepEqual(await getReviewItemChunks(outsider, admin, item.id, OUTSIDER), { ok: false, reason: 'not_found' });
        const member = pgliteClient(db, { role: 'authenticated', userId: MEMBER, label: 'ssr', calls: [] }) as unknown as SupabaseClient;
        const served = await getReviewItemChunks(member, admin, item.id, MEMBER);
        assert.ok(served.ok);
        assert.equal(served.chunks.filter((chunk) => chunk.available).length, 1);
      });

      test('with access off a log row without sets yields an item with access_sets NULL, visible to every expert, as today', async () => {
        await setEnforced(db, false);
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)] });
        await mine();
        const item = await minedItem(logId);
        assert.equal(item.access_sets, null);
        assert.equal(await visibleTo(OUTSIDER, item.id), true);
      });
    });

    describe('catalog and grants', () => {
      test('the old four-argument signature is gone; the new one and the helper are SECURITY INVOKER, empty search_path, service_role only', async () => {
        assert.deepEqual(await rows(db, 'SELECT to_regprocedure($1) AS fn', [`public.${OLD_ENQUEUE}`]), [{ fn: null }]);
        for (const signature of [ENQUEUE, HELPER]) {
          const info = await rows(
            db,
            `SELECT p.prosecdef AS definer, p.proconfig AS config,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [`public.${signature}`],
          );
          assert.deepEqual(info, [{ definer: false, config: ['search_path=""'], anon: false, authenticated: false, service: true }], signature);
          assert.equal(AUTHENTICATED_ALLOW_LIST[normalizeSignature(signature)], undefined);
        }
        const mining = await rows(
          db,
          "SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p WHERE p.oid = 'public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb)'::regprocedure",
        );
        assert.deepEqual(mining, [{ definer: true, config: ['search_path=""'] }]);
        await assertNoClientCallableRagFunctions(db);
      });

      test('0410 locks the new signatures again after a stray grant', async () => {
        await db.query(`GRANT EXECUTE ON FUNCTION public.${ENQUEUE} TO authenticated, anon`);
        await db.query(`GRANT EXECUTE ON FUNCTION public.${HELPER} TO authenticated, anon`);
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, GRANTS_MIGRATION), 'utf8'));
        for (const signature of [ENQUEUE, HELPER]) {
          const info = await rows(
            db,
            "SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated",
            [`public.${signature}`],
          );
          assert.deepEqual(info, [{ anon: false, authenticated: false }], signature);
        }
      });

      test('re-running 0984 is idempotent, and re-running 0950 then 0984 restores one enqueue signature', async () => {
        const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
        await db.exec(sql);
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0950_calc_review_reasons.sql'), 'utf8'));
        await db.exec(sql);
        const signatures = await rows<{ sig: string }>(db, "SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'rag_enqueue_review_item'");
        assert.deepEqual(signatures.map((s) => s.sig.replace(/,(?! )/g, ', ')), [ENQUEUE]);
        const id = await enqueue('output_guard', { chunk_ids: [restrictedChunk] });
        assert.deepEqual(await setsOf(id), [[`g:${groupA}`]]);
      });
    });
  });
}
