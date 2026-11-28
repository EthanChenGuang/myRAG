import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0807_effective_dates.sql';
const LEGACY = 'openai-3-small-1536';
const TOKEN = 'effwindowprobe';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const TENANT_O = `o:${TWO_TENANT_IDS.orgO}`;
const ORG_ADMIN = '00000000-0000-4000-8000-0000000046a1';
const MEMBER = '00000000-0000-4000-8000-0000000046a2';

type Row = Record<string, unknown>;

const vec = (text: string): string => `[${embedText(text).join(',')}]`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

const SET_SQL = `SELECT * FROM rag_set_document_effective_dates($1::uuid, $2, $3::date, $4::date, $5, $6::real, $7::uuid)`;

function setDates(db: PGlite, documentId: string, tenantKey: string, from: string | null, to: string | null, origin: string, confidence: number | null, actor: string | null) {
  return rows(db, SET_SQL, [documentId, tenantKey, from, to, origin, confidence, actor]);
}

const PROPOSE_SQL = `SELECT * FROM rag_propose_document_effective_dates($1::uuid, $2, $3::date, $4::date, $5::real, $6, $7)`;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function seedDocument(db: PGlite, userId: string, organizationId: string | null, label: string, chunks = 2): Promise<{ docId: string; chunkIds: string[] }> {
  const docId = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, user_id, organization_id, is_current, status, ingest_fingerprint)
     VALUES ($1, $2, $3, $4, $5, true, 'ready', $6)`,
    [docId, `${label}.md`, `${TOKEN} ${label}`, userId, organizationId, `fp-${docId}`],
  );
  const tenantKey = organizationId ? `o:${organizationId}` : `u:${userId}`;
  const chunkIds: string[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const chunkId = crypto.randomUUID();
    const text = `${TOKEN} ${label} neutral sample sentence ${index}`;
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, chunk_index, is_current, status, organization_id)
       VALUES ($1, $2, $3, $4::vector, $3, $5, $6, true, 'ready', $7)`,
      [chunkId, docId, text, vec(text), tenantKey, index, organizationId],
    );
    chunkIds.push(chunkId);
  }
  return { docId, chunkIds };
}

async function documentRow(db: PGlite, docId: string): Promise<Row> {
  const found = await rows(
    db,
    `SELECT effective_from, effective_to, effective_dates_origin, effective_dates_confidence, ingest_fingerprint, metadata FROM documents WHERE id = $1`,
    [docId],
  );
  assert.equal(found.length, 1);
  return found[0] as Row;
}

async function chunkDates(db: PGlite, docId: string): Promise<Array<[string | null, string | null]>> {
  return (await rows(db, 'SELECT effective_from, effective_to FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [docId])).map((row) => [
    iso(row.effective_from),
    iso(row.effective_to),
  ]);
}

async function insertCacheRow(db: PGlite, tenantKey: string, documentId: string): Promise<string> {
  const result = await rows(
    db,
    `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, 'p1', '[1,0,0]'::halfvec, 'masked query placeholder', '{}'::jsonb, $3::jsonb, false, now() + interval '1 hour') RETURNING id`,
    [tenantKey, crypto.randomUUID(), JSON.stringify([{ document_id: documentId, version: 1 }])],
  );
  return String(result[0]?.id);
}

async function search(db: PGlite, tenantKey: string, docIds: string[], effectiveOn: string): Promise<Set<string>> {
  const found = await rows(
    db,
    `SELECT DISTINCT chunk_id::text AS chunk_id FROM hybrid_search_chunks(
       p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
       p_dense_limit => 50, p_lexical_limit => 50, p_document_ids => $5::uuid[], p_exact_scan_cutoff => 0, p_effective_on => $6::date)`,
    [tenantKey, LEGACY, vec(`${TOKEN} query`), [TOKEN], docIds, effectiveOn],
  );
  return new Set(found.map((row) => String(row.chunk_id)));
}

describe('0807 effective dates (two tenants, multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
      ORG_ADMIN,
      'org-admin@example.invalid',
      MEMBER,
      'member@example.invalid',
    ]);
    await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [TWO_TENANT_IDS.userA, TWO_TENANT_IDS.userB]);
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member') ON CONFLICT DO NOTHING`,
      [TWO_TENANT_IDS.orgO, ORG_ADMIN, MEMBER],
    );
  });

  after(async () => {
    await db.close();
  });

  test('an admin sets a window: four document columns, every chunk, no fingerprint change, the cache row is gone, one audit row', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'admin-set');
    const before = await documentRow(db, docId);
    const cacheId = await insertCacheRow(db, TENANT_A, docId);
    const otherDoc = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'admin-untouched', 1);
    const otherCache = await insertCacheRow(db, TENANT_A, otherDoc.docId);

    const result = await asRole(db, 'service_role', () => setDates(db, docId, TENANT_A, '2025-01-01', '2025-12-31', 'admin', null, TWO_TENANT_IDS.userA));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.outcome, 'set');
    assert.equal(result[0]?.chunks_updated, 2);

    const after = await documentRow(db, docId);
    assert.equal(iso(after.effective_from), '2025-01-01');
    assert.equal(iso(after.effective_to), '2025-12-31');
    assert.equal(after.effective_dates_origin, 'admin');
    assert.equal(after.effective_dates_confidence, null);
    assert.equal(after.ingest_fingerprint, before.ingest_fingerprint);
    assert.deepEqual(await chunkDates(db, docId), [
      ['2025-01-01', '2025-12-31'],
      ['2025-01-01', '2025-12-31'],
    ]);
    assert.equal((await rows(db, 'SELECT 1 FROM rag_semantic_cache WHERE id = $1', [cacheId])).length, 0);
    assert.equal((await rows(db, 'SELECT 1 FROM rag_semantic_cache WHERE id = $1', [otherCache])).length, 1, 'only the edited document is invalidated');
    const audit = await rows(db, `SELECT actor::text AS actor, tenant_key FROM rag_admin_audit WHERE action = 'set_effective_dates' AND document_id = $1`, [docId]);
    assert.deepEqual(audit, [{ actor: TWO_TENANT_IDS.userA, tenant_key: TENANT_A }]);
  });

  test('the date-filtered search respects the new window at once (inclusive bounds)', async () => {
    const { docId, chunkIds } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'search-window');
    const all = new Set(chunkIds);
    assert.deepEqual(await search(db, TENANT_A, [docId], '2030-06-01'), all);
    await setDates(db, docId, TENANT_A, '2025-01-01', '2025-12-31', 'admin', null, TWO_TENANT_IDS.userA);
    assert.deepEqual(await search(db, TENANT_A, [docId], '2025-06-01'), all);
    assert.deepEqual(await search(db, TENANT_A, [docId], '2025-12-31'), all, 'a window ending today is usable today');
    assert.deepEqual(await search(db, TENANT_A, [docId], '2025-01-01'), all);
    assert.deepEqual(await search(db, TENANT_A, [docId], '2026-01-01'), new Set());
    assert.deepEqual(await search(db, TENANT_A, [docId], '2024-12-31'), new Set());
  });

  test('from later than to is refused with invalid_window and nothing is stored', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'bad-window');
    const message = await failure(db, SET_SQL, [docId, TENANT_A, '2025-02-01', '2025-01-31', 'admin', null, TWO_TENANT_IDS.userA]);
    assert.match(String(message), /^invalid_window/);
    const row = await documentRow(db, docId);
    assert.equal(row.effective_from, null);
    assert.equal(row.effective_dates_origin, null);
    assert.deepEqual(await chunkDates(db, docId), [
      [null, null],
      [null, null],
    ]);
  });

  test('a failure after the document update rolls back document and chunks together', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'atomic');
    await db.exec(`
      CREATE OR REPLACE FUNCTION pg_temp.fail_chunk_dates() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected_failure'; END $$;
    `);
    await db.query(`CREATE TRIGGER effective_dates_injected BEFORE UPDATE OF effective_from ON document_chunks FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_chunk_dates()`);
    try {
      const message = await failure(db, SET_SQL, [docId, TENANT_A, '2025-01-01', null, 'admin', null, TWO_TENANT_IDS.userA]);
      assert.match(String(message), /injected_failure/);
    } finally {
      await db.exec('DROP TRIGGER effective_dates_injected ON document_chunks');
    }
    const row = await documentRow(db, docId);
    assert.equal(row.effective_from, null);
    assert.equal(row.effective_dates_origin, null);
    assert.deepEqual(await chunkDates(db, docId), [
      [null, null],
      [null, null],
    ]);
  });

  test('clearing both dates stores nulls with origin admin', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'clear');
    await setDates(db, docId, TENANT_A, '2025-01-01', '2025-03-01', 'extracted', 0.9, null);
    await setDates(db, docId, TENANT_A, null, null, 'admin', null, TWO_TENANT_IDS.userA);
    const row = await documentRow(db, docId);
    assert.equal(row.effective_from, null);
    assert.equal(row.effective_to, null);
    assert.equal(row.effective_dates_origin, 'admin');
    assert.deepEqual(await chunkDates(db, docId), [
      [null, null],
      [null, null],
    ]);
  });

  test("another tenant's admin, a plain member and a wrong tenant key all get not_found and change nothing", async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'foreign');
    const orgDoc = await seedDocument(db, TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO, 'org-foreign');
    const attempts: unknown[][] = [
      [docId, TENANT_A, '2025-01-01', null, 'admin', null, TWO_TENANT_IDS.userB],
      [docId, TENANT_B, '2025-01-01', null, 'admin', null, TWO_TENANT_IDS.userB],
      [orgDoc.docId, TENANT_O, '2025-01-01', null, 'admin', null, TWO_TENANT_IDS.userB],
      [orgDoc.docId, TENANT_O, '2025-01-01', null, 'admin', null, MEMBER],
      [docId, TENANT_O, '2025-01-01', null, 'admin', null, ORG_ADMIN],
      [docId, TENANT_B, '2025-01-01', null, 'extracted', 0.9, null],
    ];
    for (const args of attempts) {
      assert.match(String(await failure(db, SET_SQL, args)), /^not_found/, JSON.stringify(args));
    }
    assert.equal((await documentRow(db, docId)).effective_from, null);
    assert.equal((await documentRow(db, orgDoc.docId)).effective_from, null);
  });

  test('an organization admin who is not a deployment admin sets dates on that organization only', async () => {
    const orgDoc = await seedDocument(db, TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO, 'org-own');
    const result = await setDates(db, orgDoc.docId, TENANT_O, null, '2030-01-01', 'admin', null, ORG_ADMIN);
    assert.equal(result[0]?.outcome, 'set');
    assert.equal(iso((await documentRow(db, orgDoc.docId)).effective_to), '2030-01-01');
  });

  test('origin must match the path: admin needs an actor, the pipeline writes extracted only', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'origin');
    assert.match(String(await failure(db, SET_SQL, [docId, TENANT_A, '2025-01-01', null, 'admin', null, null])), /^invalid_origin/);
    assert.match(String(await failure(db, SET_SQL, [docId, TENANT_A, '2025-01-01', null, 'extracted', 0.9, TWO_TENANT_IDS.userA])), /^invalid_origin/);
    assert.match(String(await failure(db, SET_SQL, [docId, TENANT_A, '2025-01-01', null, 'extracted', 1.5, null])), /^invalid_confidence/);
    assert.match(String(await failure(db, SET_SQL, [docId, 'x:1', '2025-01-01', null, 'extracted', 0.9, null])), /tenant/i);
  });

  test('an admin date wins over a later extracted write and a later proposal, whatever the order', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'admin-wins');
    await setDates(db, docId, TENANT_A, '2025-02-01', null, 'admin', null, TWO_TENANT_IDS.userA);
    const extracted = await setDates(db, docId, TENANT_A, '2024-01-01', '2024-06-30', 'extracted', 0.95, null);
    assert.equal(extracted[0]?.outcome, 'kept_admin');
    const proposed = await rows(db, PROPOSE_SQL, [docId, TENANT_A, '2027-01-01', null, 0.9, 'neutral evidence line', 'awaiting_confirmation']);
    assert.equal(proposed[0]?.outcome, 'kept_admin');
    const row = await documentRow(db, docId);
    assert.equal(iso(row.effective_from), '2025-02-01');
    assert.equal(row.effective_to, null);
    assert.equal(row.effective_dates_origin, 'admin');
    assert.equal((row.metadata as Row | null)?.effective_date_proposal, undefined);
    assert.deepEqual(await chunkDates(db, docId), [
      ['2025-02-01', null],
      ['2025-02-01', null],
    ]);
  });

  test('an extracted apply stores origin extracted and its confidence; a later admin set replaces it', async () => {
    const { docId } = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'extracted-then-admin');
    const applied = await asRole(db, 'service_role', () => setDates(db, docId, TENANT_A, '2025-01-01', null, 'extracted', 0.85, null));
    assert.equal(applied[0]?.outcome, 'set');
    let row = await documentRow(db, docId);
    assert.equal(row.effective_dates_origin, 'extracted');
    assert.ok(Math.abs(Number(row.effective_dates_confidence) - 0.85) < 1e-6);
    await setDates(db, docId, TENANT_A, '2025-03-01', null, 'admin', null, TWO_TENANT_IDS.userA);
    row = await documentRow(db, docId);
    assert.equal(row.effective_dates_origin, 'admin');
    assert.equal(iso(row.effective_from), '2025-03-01');
  });

  describe('proposals: store, list, dismiss, apply', () => {
    let docId: string;
    let lowId: string;

    beforeEach(async () => {
      docId = (await seedDocument(db, TWO_TENANT_IDS.userA, null, `proposal-${crypto.randomUUID().slice(0, 8)}`, 1)).docId;
      lowId = (await seedDocument(db, TWO_TENANT_IDS.userA, null, `proposal-low-${crypto.randomUUID().slice(0, 8)}`, 1)).docId;
    });

    test('a stored proposal changes neither the date columns nor the chunks nor retrieval', async () => {
      const stored = await asRole(db, 'service_role', () =>
        rows(db, PROPOSE_SQL, [docId, TENANT_A, '2099-01-01', null, 0.92, 'neutral evidence line', 'awaiting_confirmation']),
      );
      assert.equal(stored[0]?.outcome, 'stored');
      const row = await documentRow(db, docId);
      assert.equal(row.effective_from, null);
      assert.equal(row.effective_dates_origin, null);
      const proposal = (row.metadata as Row).effective_date_proposal as Row;
      assert.equal(proposal.from, '2099-01-01');
      assert.equal(proposal.to, null);
      assert.equal(proposal.status, 'awaiting_confirmation');
      assert.equal(proposal.evidence_quote, 'neutral evidence line');
      assert.equal(typeof proposal.proposed_at, 'string');
      assert.deepEqual(await chunkDates(db, docId), [[null, null]]);
      assert.equal((await search(db, TENANT_A, [docId], '2026-01-01')).size, 1);
    });

    test('a proposal with from later than to, or with no date, is refused', async () => {
      assert.match(String(await failure(db, PROPOSE_SQL, [docId, TENANT_A, '2025-02-01', '2025-01-01', 0.9, 'q', 'awaiting_confirmation'])), /^invalid_window/);
      assert.match(String(await failure(db, PROPOSE_SQL, [docId, TENANT_A, null, null, 0.9, 'q', 'awaiting_confirmation'])), /^invalid_window/);
      assert.match(String(await failure(db, PROPOSE_SQL, [docId, TENANT_A, '2025-01-01', null, 0.9, 'q', 'applied'])), /^invalid_status/);
      assert.match(String(await failure(db, PROPOSE_SQL, [docId, TENANT_B, '2025-01-01', null, 0.9, 'q', 'awaiting_confirmation'])), /^not_found/);
    });

    test('the list shows proposals of the actor tenant only, awaiting first, and a file-name search finds documents with their dates', async () => {
      await rows(db, PROPOSE_SQL, [docId, TENANT_A, '2099-01-01', null, 0.92, 'neutral evidence line', 'awaiting_confirmation']);
      await rows(db, PROPOSE_SQL, [lowId, TENANT_A, '2020-01-01', null, 0.4, 'another neutral line', 'low_confidence']);
      const listed = await asRole(db, 'service_role', () =>
        rows(db, 'SELECT * FROM rag_list_effective_date_proposals($1::uuid, $2, NULL, 100, 0)', [TWO_TENANT_IDS.userA, TENANT_A]),
      );
      const ids = listed.map((row) => String(row.document_id));
      assert.ok(ids.includes(docId) && ids.includes(lowId));
      const awaitingIndex = listed.findIndex((row) => (row.proposal as Row | null)?.status === 'awaiting_confirmation');
      const lowIndex = listed.findIndex((row) => (row.proposal as Row | null)?.status === 'low_confidence');
      assert.ok(awaitingIndex < lowIndex, 'awaiting proposals come first');
      assert.ok(listed.every((row) => row.tenant_key === TENANT_A));
      assert.equal(Number(listed[0]?.total_count), listed.length);

      assert.deepEqual(await rows(db, 'SELECT * FROM rag_list_effective_date_proposals($1::uuid, $2, NULL, 100, 0)', [TWO_TENANT_IDS.userB, TENANT_A]), []);
      assert.deepEqual(await rows(db, 'SELECT * FROM rag_list_effective_date_proposals($1::uuid, $2, NULL, 100, 0)', [MEMBER, TENANT_O]), []);

      const dated = await seedDocument(db, TWO_TENANT_IDS.userA, null, 'searchable_name%x', 1);
      await setDates(db, dated.docId, TENANT_A, '2025-01-01', null, 'admin', null, TWO_TENANT_IDS.userA);
      const found = await rows(db, `SELECT * FROM rag_list_effective_date_proposals($1::uuid, $2, 'name%x', 100, 0)`, [TWO_TENANT_IDS.userA, TENANT_A]);
      assert.deepEqual(found.map((row) => String(row.document_id)), [dated.docId]);
      assert.equal(iso(found[0]?.effective_from), '2025-01-01');
      assert.equal(found[0]?.effective_dates_origin, 'admin');
      const wildcard = await rows(db, `SELECT * FROM rag_list_effective_date_proposals($1::uuid, $2, '_', 100, 0)`, [TWO_TENANT_IDS.userA, TENANT_A]);
      assert.deepEqual(wildcard.map((row) => String(row.document_id)), [dated.docId], 'LIKE wildcards in the query are literal');
    });

    test('dismiss drops the proposal and keeps the current dates; another tenant gets not_found', async () => {
      await setDates(db, docId, TENANT_A, '2025-01-01', null, 'extracted', 0.9, null);
      await rows(db, PROPOSE_SQL, [docId, TENANT_A, '2099-01-01', null, 0.92, 'neutral evidence line', 'awaiting_confirmation']);
      const DISMISS = 'SELECT * FROM rag_dismiss_effective_date_proposal($1::uuid, $2, $3::uuid)';
      assert.match(String(await failure(db, DISMISS, [docId, TENANT_A, TWO_TENANT_IDS.userB])), /^not_found/);
      const dismissed = await asRole(db, 'service_role', () => rows(db, DISMISS, [docId, TENANT_A, TWO_TENANT_IDS.userA]));
      assert.equal(dismissed[0]?.outcome, 'dismissed');
      const row = await documentRow(db, docId);
      assert.equal((row.metadata as Row).effective_date_proposal, undefined);
      assert.equal(iso(row.effective_from), '2025-01-01');
      assert.equal(row.effective_dates_origin, 'extracted');
      assert.match(String(await failure(db, DISMISS, [docId, TENANT_A, TWO_TENANT_IDS.userA])), /^no_proposal/);
    });

    test('applying a proposal is an admin set and removes the proposal', async () => {
      await rows(db, PROPOSE_SQL, [docId, TENANT_A, '2099-01-01', null, 0.92, 'neutral evidence line', 'awaiting_confirmation']);
      await setDates(db, docId, TENANT_A, '2099-01-01', null, 'admin', null, TWO_TENANT_IDS.userA);
      const row = await documentRow(db, docId);
      assert.equal((row.metadata as Row).effective_date_proposal, undefined);
      assert.equal(iso(row.effective_from), '2099-01-01');
      assert.equal(row.effective_dates_origin, 'admin');
    });
  });

  test('anon and authenticated cannot execute any 0807 function', async () => {
    const calls = [
      `SELECT rag_set_document_effective_dates('${TWO_TENANT_IDS.docA}'::uuid, '${TENANT_A}', NULL, NULL, 'admin', NULL, '${TWO_TENANT_IDS.userA}'::uuid)`,
      `SELECT rag_propose_document_effective_dates('${TWO_TENANT_IDS.docA}'::uuid, '${TENANT_A}', '2025-01-01', NULL, 0.9, 'q', 'low_confidence')`,
      `SELECT rag_dismiss_effective_date_proposal('${TWO_TENANT_IDS.docA}'::uuid, '${TENANT_A}', '${TWO_TENANT_IDS.userA}'::uuid)`,
      `SELECT rag_list_effective_date_proposals('${TWO_TENANT_IDS.userA}'::uuid, '${TENANT_A}', NULL, 10, 0)`,
    ];
    for (const role of ['anon', 'authenticated'] as const) {
      for (const sql of calls) {
        const message = await asRole(db, role, () => failure(db, sql));
        assert.match(String(message), /permission denied/, `${role}: ${sql.slice(0, 60)}`);
      }
    }
  });

  test('every 0807 function has search_path "" and only the two audit writers are SECURITY DEFINER', async () => {
    const found = await rows(
      db,
      `SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('rag_set_document_effective_dates', 'rag_propose_document_effective_dates',
         'rag_dismiss_effective_date_proposal', 'rag_list_effective_date_proposals') ORDER BY p.proname`,
    );
    assert.equal(found.length, 4);
    for (const row of found) {
      assert.deepEqual(row.proconfig, ['search_path=""'], String(row.proname));
      assert.equal(row.prosecdef, ['rag_set_document_effective_dates', 'rag_dismiss_effective_date_proposal'].includes(String(row.proname)), String(row.proname));
    }
  });

  test('a second apply of 0807 succeeds and keeps the earlier audit actions', async () => {
    const before = await rows(db, `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rag_admin_audit_action_check'`);
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
    const after = await rows(db, `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rag_admin_audit_action_check'`);
    assert.deepEqual(after, before);
    for (const action of ['release_quarantine', 'approve_upload', 'confirm_supersession', 'set_effective_dates', 'dismiss_effective_dates']) {
      assert.ok(String(after[0]?.def).includes(`'${action}'`), action);
    }
  });
});

describe('0807 effective dates (single-tenant)', () => {
  let db: PGlite;
  const ADMIN = '00000000-0000-4000-8000-0000000046b1';
  const USER = '00000000-0000-4000-8000-0000000046b2';

  before(async () => {
    db = (await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus') })).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [ADMIN, 'admin@example.invalid', USER, 'user@example.invalid']);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  });

  after(async () => {
    await db.close();
  });

  test('a deployment admin sets dates on s:default; a non-admin gets not_found', async () => {
    const docId = crypto.randomUUID();
    await db.query(`INSERT INTO documents (id, filename, content, is_current, status) VALUES ($1, 'single.md', 'neutral sample', true, 'ready')`, [docId]);
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, tenant_key, chunk_index, is_current, status) VALUES ($1, $2, 'neutral sample', 's:default', 0, true, 'ready')`,
      [crypto.randomUUID(), docId],
    );
    assert.match(String(await failure(db, SET_SQL, [docId, 's:default', '2025-01-01', null, 'admin', null, USER])), /^not_found/);
    const result = await setDates(db, docId, 's:default', '2025-01-01', '2025-01-01', 'admin', null, ADMIN);
    assert.equal(result[0]?.outcome, 'set');
    assert.deepEqual(await chunkDates(db, docId), [['2025-01-01', '2025-01-01']]);
  });
});
