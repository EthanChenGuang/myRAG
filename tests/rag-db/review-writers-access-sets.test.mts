import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

// 0988: the Phase 5.3 review-queue writers rag_review_items_enqueue (0967) and rag_review_items_enqueue_re_review (0974) carry
// access_sets, so 0934's restrictive policy rag_review_items_access_sets hides an item from an expert outside the source document's
// access group. With access off both write access_sets NULL, as before. Neutral synthetic data only.

type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0988_review_items_writers_access_sets.sql';
const GRANTS_MIGRATION = 'supabase/migrations/0410_security_definer_rpc_grants.sql';
const ENQUEUE = 'rag_review_items_enqueue(text, text, jsonb)';
const RE_REVIEW = 'rag_review_items_enqueue_re_review(text, jsonb)';
const WINDOW = '2026-11-23T00:00:00Z';
const OWNER = '00000000-0000-4000-8000-00000000e1a0';
const MEMBER = '00000000-0000-4000-8000-00000000e1a1';
const OUTSIDER = '00000000-0000-4000-8000-00000000e1a2';
const ORG = '00000000-0000-4000-8000-00000000e1f1';
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

  describe(`Phase 5.3 review writers carry access_sets (${mode})`, () => {
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

    function question(): { query_masked: string; query_fingerprint: string } {
      counter += 1;
      const text = `Synthetic question number ${counter} about the sample topic`;
      return { query_masked: text, query_fingerprint: fingerprintOf(text) };
    }

    function queueRow(extra: Row = {}): Row {
      return { ...question(), language: 'en', mining_window: WINDOW, reasons: ['representative'], stratum: 'c1|en|chat', sampling_weight: 1, ...extra };
    }

    async function insertLog(fields: Row): Promise<string> {
      const q = question();
      const values: Row = {
        trace_id: crypto.randomUUID(),
        user_id: OWNER,
        organization_id: multi ? ORG : null,
        channel: 'chat',
        pipeline: 'legacy',
        status: 'ok',
        outcome: 'answered',
        candidate_count: 1,
        top_score: 0.5,
        created_at: '2026-11-20T12:00:00Z',
        ...q,
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

    function candidate(documentId: string, chunkId: string): Row {
      return { chunk_id: chunkId, document_id: documentId, rank: 1, similarity: 0.5 };
    }

    async function enqueue(row: Row): Promise<string> {
      const n = await asService<{ n: number }>(db, 'SELECT public.rag_review_items_enqueue($1, $2, $3::jsonb) AS n', [tenantKey, 'representative', JSON.stringify([row])]);
      assert.equal(n[0]!.n, 1);
      return (await rows<{ id: string }>(db, 'SELECT id FROM rag_review_items WHERE query_fingerprint = $1', [row.query_fingerprint]))[0]!.id;
    }

    async function reReview(row: Row): Promise<string> {
      const n = await asService<{ n: number }>(db, 'SELECT public.rag_review_items_enqueue_re_review($1, $2::jsonb) AS n', [tenantKey, JSON.stringify([row])]);
      assert.equal(n[0]!.n, 1);
      return (await rows<{ id: string }>(db, 'SELECT id FROM rag_review_items WHERE query_fingerprint = $1', [row.query_fingerprint]))[0]!.id;
    }

    async function setsOf(id: string): Promise<unknown> {
      return (await rows<{ access_sets: unknown }>(db, 'SELECT access_sets FROM rag_review_items WHERE id = $1', [id]))[0]?.access_sets;
    }

    async function visibleTo(userId: string, id: string): Promise<boolean> {
      return (await asUser(db, userId, 'SELECT id FROM public.rag_review_items WHERE id = $1', [id])).length === 1;
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      for (const id of [OWNER, MEMBER, OUTSIDER]) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, `user-${id.slice(-4)}@example.invalid`]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'review-writers', $2, false)", [ORG, OWNER]);
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
      await db.query('DELETE FROM rag_golden_evidence_index');
      await setEnforced(db, true);
    });

    after(async () => {
      await db?.close();
    });

    describe('rag_review_items_enqueue', () => {
      test('with access on, a row whose log row retrieved a restricted document carries its label set and is hidden from an outside expert', async () => {
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)] });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        assert.deepEqual(await setsOf(id), [[`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, id), false);
        assert.equal(await visibleTo(MEMBER, id), true);
        assert.equal(await visibleTo(OWNER, id), true);
      });

      test('the log row access_sets are merged with the candidates label sets', async () => {
        const logId = await insertLog({ candidates: [candidate(openDoc, openChunk)], access_sets: [[`g:${groupA}`]] });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        assert.deepEqual(await setsOf(id), [['all'], [`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, id), false);
      });

      test('caller access_sets and document_ids in a row are normalised and merged', async () => {
        const other = crypto.randomUUID();
        const id = await enqueue(queueRow({ document_ids: [openDoc], access_sets: [[`g:${other}`, `g:${groupA}`, `g:${other}`]] }));
        const expected = [['all'], [`g:${groupA}`, `g:${other}`].sort()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(await setsOf(id), expected);
        assert.equal(await visibleTo(OUTSIDER, id), false);
      });

      test('malformed access_sets, malformed document_ids or a document of another tenant are refused with 22023 and write nothing', async () => {
        const foreign = crypto.randomUUID();
        for (const extra of [{ access_sets: [[]] }, { access_sets: ['all'] }, { document_ids: ['not-a-uuid'] }, { document_ids: [foreign] }]) {
          await assert.rejects(
            () => asService(db, 'SELECT public.rag_review_items_enqueue($1, $2, $3::jsonb)', [tenantKey, 'representative', JSON.stringify([queueRow(), queueRow(extra)])]),
            (error: unknown) => sqlState(error) === '22023',
            JSON.stringify(extra),
          );
        }
        assert.equal((await rows(db, 'SELECT id FROM rag_review_items')).length, 0);
      });

      test("a row without any source stores '[]' while access is enforced (0990) and is visible to every expert", async () => {
        const id = await enqueue(queueRow());
        assert.deepEqual(await setsOf(id), []);
        assert.equal(await visibleTo(OUTSIDER, id), true);
      });

      test('with access off the item is written with access_sets NULL and every expert sees it, as today', async () => {
        await setEnforced(db, false);
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)], access_sets: [[`g:${groupA}`]] });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        assert.equal(await setsOf(id), null);
        assert.equal(await visibleTo(OUTSIDER, id), true);
        assert.equal(await visibleTo(MEMBER, id), true);
        const strata = await rows(db, 'SELECT source, stratum, sampling_weight FROM rag_review_item_strata WHERE review_item_id = $1', [id]);
        assert.deepEqual(strata, [{ source: 'representative', stratum: 'c1|en|chat', sampling_weight: 1 }]);
      });
    });

    describe('rag_review_items_enqueue_re_review', () => {
      function reRow(extra: Row = {}): Row {
        return { ...question(), language: 'en', mining_window: WINDOW, ...extra };
      }

      test('with access on, a golden item whose evidence is a restricted document carries its label set and is hidden from an outside expert', async () => {
        await db.query("INSERT INTO rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256) VALUES ($1, 'set-1', 'item-1', $2, $3)", [
          tenantKey,
          restrictedDoc,
          'a'.repeat(64),
        ]);
        const id = await reReview(reRow({ item_ids: ['item-1'] }));
        assert.deepEqual(await setsOf(id), [[`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, id), false);
        assert.equal(await visibleTo(MEMBER, id), true);
      });

      test('document_ids and access_sets given in a row are merged', async () => {
        const id = await reReview(reRow({ document_ids: [restrictedDoc], access_sets: [['all']] }));
        assert.deepEqual(await setsOf(id), [['all'], [`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, id), false);
      });

      test('malformed keys or a document of another tenant are refused with 22023 and write nothing', async () => {
        for (const extra of [{ access_sets: [[1]] }, { document_ids: 'x' }, { document_ids: [crypto.randomUUID()] }, { item_ids: [''] }]) {
          await assert.rejects(
            () => asService(db, 'SELECT public.rag_review_items_enqueue_re_review($1, $2::jsonb)', [tenantKey, JSON.stringify([reRow(), reRow(extra)])]),
            (error: unknown) => sqlState(error) === '22023',
            JSON.stringify(extra),
          );
        }
        assert.equal((await rows(db, 'SELECT id FROM rag_review_items')).length, 0);
      });

      test('with access off the item is written with access_sets NULL, as today', async () => {
        await setEnforced(db, false);
        await db.query("INSERT INTO rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256) VALUES ($1, 'set-1', 'item-2', $2, $3)", [
          tenantKey,
          restrictedDoc,
          'b'.repeat(64),
        ]);
        const id = await reReview(reRow({ item_ids: ['item-2'], document_ids: [restrictedDoc] }));
        assert.equal(await setsOf(id), null);
        assert.equal(await visibleTo(OUTSIDER, id), true);
        const plain = await reReview(reRow());
        assert.equal(await setsOf(plain), null);
      });
    });

    describe('backfill, catalog and grants', () => {
      test('re-applying 0988 with access on backfills a NULL item from its retrieval log row', async () => {
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)] });
        const q = question();
        await db.query('INSERT INTO rag_review_items (tenant_key, retrieval_log_id, query_masked, query_fingerprint, reasons, mining_window) VALUES ($1, $2, $3, $4, $5, $6)', [
          tenantKey,
          logId,
          q.query_masked,
          q.query_fingerprint,
          ['representative'],
          WINDOW,
        ]);
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
        const item = (await rows<{ id: string; access_sets: unknown }>(db, 'SELECT id, access_sets FROM rag_review_items WHERE retrieval_log_id = $1', [logId]))[0]!;
        assert.deepEqual(item.access_sets, [[`g:${groupA}`]]);
        assert.equal(await visibleTo(OUTSIDER, item.id), false);
      });

      test('both writers stay SECURITY INVOKER with an empty search_path, service_role only, and 0410 locks them after a stray grant', async () => {
        for (const signature of [ENQUEUE, RE_REVIEW]) {
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
          await db.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated, anon`);
        }
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, GRANTS_MIGRATION), 'utf8'));
        for (const signature of [ENQUEUE, RE_REVIEW]) {
          const info = await rows(
            db,
            "SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated",
            [`public.${signature}`],
          );
          assert.deepEqual(info, [{ anon: false, authenticated: false }], signature);
        }
        await assertNoClientCallableRagFunctions(db);
      });

      test('re-running 0988 is idempotent; re-running 0967 and 0974 then 0988 restores the access-aware writers', async () => {
        const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
        await db.exec(sql);
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0967_rag_review_item_strata.sql'), 'utf8'));
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0974_rag_review_items_re_review.sql'), 'utf8'));
        await db.exec(sql);
        const names = await rows<{ n: number }>(db, "SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('rag_review_items_enqueue', 'rag_review_items_enqueue_re_review')");
        assert.equal(names[0]!.n, 2);
        const logId = await insertLog({ candidates: [candidate(restrictedDoc, restrictedChunk)] });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        assert.deepEqual(await setsOf(id), [[`g:${groupA}`]]);
      });
    });
  });
}
