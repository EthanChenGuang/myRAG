import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION = 'supabase/migrations/0806_supersession.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

const ADMIN = '00000000-0000-4000-8000-0000000008b1';
const MEMBER = '00000000-0000-4000-8000-0000000008b2';

type Row = Record<string, unknown>;

interface Ctx {
  mode: DeploymentMode;
  db: PGlite;
  /** The tenant the documents go to: the organization in multi-tenant mode, s:default in single-tenant mode. */
  key: string;
  userId: string | null;
  orgId: string | null;
  admin: string;
  member: string;
  /** An admin of another tenant only (multi-tenant mode), or null. */
  otherAdmin: string | null;
  /** The other tenant's key and owner (multi-tenant mode), or null. */
  otherKey: string | null;
  otherUser: string | null;
}

async function createCtx(mode: DeploymentMode): Promise<Ctx> {
  if (mode === 'single-tenant') {
    const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS });
    const db = fixture.db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
      ADMIN,
      'approver@example.invalid',
      MEMBER,
      'member@example.invalid',
    ]);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    return { mode, db, key: 's:default', userId: null, orgId: null, admin: ADMIN, member: MEMBER, otherAdmin: null, otherKey: null, otherUser: null };
  }
  const fixture = await createTwoTenantDatabase();
  const db = fixture.db;
  const ORG = TWO_TENANT_IDS.orgO;
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [MEMBER, 'member@example.invalid']);
  await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG, MEMBER]);
  await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2)', [TWO_TENANT_IDS.userA, TWO_TENANT_IDS.userB]);
  await db.query("UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2", [ORG, TWO_TENANT_IDS.userA]);
  return {
    mode,
    db,
    key: `o:${ORG}`,
    userId: MEMBER,
    orgId: ORG,
    admin: TWO_TENANT_IDS.userA,
    member: MEMBER,
    otherAdmin: TWO_TENANT_IDS.userB,
    otherKey: `u:${TWO_TENANT_IDS.userB}`,
    otherUser: TWO_TENANT_IDS.userB,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return '';
  } catch (error) {
    return messageOf(error);
  }
}

let sequence = 0;
const next = (label: string): string => `${label}${++sequence}`;
const vectorText = (values: number[]): string => `[${values.join(',')}]`;
const halfvecOf = (text: string): number[] => embedText(text).slice(0, 1024);

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

const tenantOf = (ctx: Ctx): Tenant => ({ key: ctx.key, userId: ctx.userId, orgId: ctx.orgId });

/** A new document version for source key `sourceKey` (a new lineage when the key is new). */
async function begin(ctx: Ctx, sourceKey: string, label: string, tenant: Tenant = tenantOf(ctx)): Promise<string> {
  const row = (
    await rows(
      ctx.db,
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, tenant.orgId, sourceKey, `${label}.md`, crypto.createHash('sha256').update(label).digest('hex')],
    )
  )[0];
  assert.ok(row?.document_id, 'begin returns a document id');
  return String(row.document_id);
}

const WRITE_SQL = `SELECT * FROM rag_write_chunks(
  p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => $5::boolean, p_total => $6::int)`;

async function writeChunks(ctx: Ctx, documentId: string, texts: string[], key: string = ctx.key): Promise<void> {
  const chunks = texts.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const embeddings = {
    [LEGACY_PROFILE]: texts.map((text) => embedText(text)),
    [HALFVEC_PROFILE]: texts.map((text) => halfvecOf(text)),
  };
  await rows(ctx.db, WRITE_SQL, [documentId, key, JSON.stringify(chunks), JSON.stringify(embeddings), true, texts.length]);
}

async function publish(ctx: Ctx, documentId: string, key: string = ctx.key): Promise<string> {
  const row = (await rows(ctx.db, 'SELECT outcome FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, key]))[0];
  return String(row?.outcome);
}

const probe = (token: string): string => `${token} neutral probe sentence about a shared topic`;

/** A published document of a new lineage with two chunks: one naming the shared token and one naming its own token. */
async function currentDocument(ctx: Ctx, label: string, shared: string, tenant: Tenant = tenantOf(ctx)): Promise<{ id: string; sourceKey: string; own: string }> {
  const sourceKey = `supersession/${next(label)}.md`;
  const own = next('tokown');
  const id = await begin(ctx, sourceKey, next(label), tenant);
  await writeChunks(ctx, id, [probe(shared), probe(own)], tenant.key);
  assert.equal(await publish(ctx, id, tenant.key), 'published');
  return { id, sourceKey, own };
}

/** Two current documents of one tenant with different source keys that share one probe token. */
async function pair(ctx: Ctx, label: string): Promise<{ older: string; newer: string; shared: string; olderKey: string; newerKey: string; olderOwn: string; newerOwn: string }> {
  const shared = next('tokshared');
  const a = await currentDocument(ctx, `${label}-old`, shared);
  const b = await currentDocument(ctx, `${label}-new`, shared);
  return { older: a.id, newer: b.id, shared, olderKey: a.sourceKey, newerKey: b.sourceKey, olderOwn: a.own, newerOwn: b.own };
}

const RAISE_SQL = `SELECT * FROM rag_supersession_raise(p_tenant_key => $1, p_document_id => $2, p_candidate_document_id => $3,
  p_signals => $4::jsonb, p_direction => $5, p_origin => $6)`;
const CONFIRM_SQL = 'SELECT * FROM rag_confirm_supersession(p_candidate_id => $1, p_actor => $2)';
const CONFIRM_OLDER_SQL = 'SELECT * FROM rag_confirm_supersession(p_candidate_id => $1, p_actor => $2, p_older_document_id => $3)';
const DISMISS_SQL = 'SELECT * FROM rag_dismiss_supersession(p_candidate_id => $1, p_actor => $2)';
const UNDO_SQL = 'SELECT * FROM rag_undo_supersession(p_candidate_id => $1, p_actor => $2)';
const LIST_SQL = 'SELECT * FROM rag_list_supersession(p_actor => $1, p_tenant_key => $2, p_limit => $3, p_offset => $4)';

/** Raises a candidate: `newer` is the document, `older` the candidate document, direction document_newer unless given. */
async function raise(ctx: Ctx, newer: string, older: string, direction: string | null = 'document_newer', origin = 'detected'): Promise<Row> {
  const row = (await rows(ctx.db, RAISE_SQL, [ctx.key, newer, older, JSON.stringify({ title_match: true }), direction, origin]))[0];
  assert.ok(row?.candidate_id, 'raise returns a candidate id');
  return row as Row;
}

async function docState(ctx: Ctx, id: string): Promise<Row> {
  return (await rows(ctx.db, 'SELECT id, status, is_current, superseded_by, lineage_id, version FROM documents WHERE id = $1', [id]))[0] as Row;
}

async function chunkStates(ctx: Ctx, id: string): Promise<Row[]> {
  return rows(ctx.db, 'SELECT status, is_current FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id]);
}

async function candidate(ctx: Ctx, id: string): Promise<Row> {
  return (await rows(ctx.db, 'SELECT * FROM rag_supersession_candidates WHERE id = $1', [id]))[0] as Row;
}

/** The document ids hybrid_search_chunks returns for a probe token on the lexical leg. */
async function hybridDocuments(ctx: Ctx, token: string): Promise<string[]> {
  const found = await rows(
    ctx.db,
    `SELECT DISTINCT c.document_id::text AS id FROM hybrid_search_chunks(
       p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
       p_dense_limit => 200, p_lexical_limit => 200) h
     JOIN document_chunks c ON c.id = h.chunk_id WHERE h.leg = 'lexical'`,
    [ctx.key, LEGACY_PROFILE, vectorText(embedText(probe(token))), [token]],
  );
  return found.map((row) => String(row.id)).sort();
}

async function auditRows(ctx: Ctx, id: string): Promise<Row[]> {
  return rows(ctx.db, 'SELECT action, actor, tenant_key, version FROM rag_admin_audit WHERE document_id = $1 ORDER BY created_at, id', [id]);
}

async function links(ctx: Ctx, candidateId: string): Promise<Row[]> {
  return rows(ctx.db, 'SELECT * FROM rag_supersession_links WHERE candidate_id = $1', [candidateId]);
}

async function cacheCount(ctx: Ctx): Promise<number> {
  return Number((await rows(ctx.db, 'SELECT count(*)::int AS n FROM rag_semantic_cache WHERE tenant_key = $1', [ctx.key]))[0]?.n);
}

async function cacheAnswer(ctx: Ctx, documentId: string): Promise<void> {
  await rows(
    ctx.db,
    `INSERT INTO rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, expires_at)
     VALUES ($1, $2, $3, $4::halfvec, 'q', '{}'::jsonb, jsonb_build_array(jsonb_build_object('document_id', $5::text, 'version', 1)), now() + interval '1 hour')`,
    [ctx.key, next('cachekey'), HALFVEC_PROFILE, vectorText(halfvecOf('probe')), documentId],
  );
}

const sortIds = (...ids: string[]): string[] => [...ids].sort();

for (const mode of MODES) {
  describe(`0806 supersession: raise and confirm (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('a raised candidate is pending and changes no document: both documents are still retrieved', async () => {
      const p = await pair(ctx, 'pending');
      const raised = await raise(ctx, p.newer, p.older);
      assert.equal(raised.outcome, 'raised');
      const row = await candidate(ctx, String(raised.candidate_id));
      assert.equal(row.status, 'pending');
      assert.equal(row.direction, 'document_newer');
      assert.equal(row.origin, 'detected');
      assert.equal(row.tenant_key, ctx.key);
      for (const id of [p.older, p.newer]) {
        const doc = await docState(ctx, id);
        assert.equal(doc.is_current, true);
        assert.equal(doc.superseded_by, null);
      }
      assert.deepEqual(await hybridDocuments(ctx, p.shared), sortIds(p.older, p.newer));
    });

    it('confirm by the tenant admin retires the older document and its chunks, links the lineages, audits once and leaves only the newer one retrievable', async () => {
      const p = await pair(ctx, 'confirm');
      const raised = await raise(ctx, p.newer, p.older);
      const confirmed = (await rows(ctx.db, CONFIRM_SQL, [raised.candidate_id, ctx.admin]))[0] as Row;
      assert.equal(confirmed.outcome, 'confirmed');
      assert.equal(confirmed.older_document_id, p.older);
      assert.equal(confirmed.newer_document_id, p.newer);

      const older = await docState(ctx, p.older);
      assert.equal(older.is_current, false);
      assert.equal(older.status, 'ready');
      assert.equal(older.superseded_by, p.newer);
      assert.ok((await chunkStates(ctx, p.older)).every((chunk) => chunk.is_current === false));
      const newer = await docState(ctx, p.newer);
      assert.equal(newer.is_current, true);
      assert.equal(newer.superseded_by, null);

      const row = await candidate(ctx, String(raised.candidate_id));
      assert.equal(row.status, 'confirmed');
      assert.equal(row.decided_by, ctx.admin);
      assert.ok(row.decided_at instanceof Date);

      const linked = await links(ctx, String(raised.candidate_id));
      assert.equal(linked.length, 1);
      assert.equal(linked[0]?.older_lineage_id, older.lineage_id);
      assert.equal(linked[0]?.newer_lineage_id, newer.lineage_id);
      assert.equal(linked[0]?.created_by, ctx.admin);

      const audit = await auditRows(ctx, p.older);
      assert.deepEqual(audit.map((entry) => entry.action), ['confirm_supersession']);
      assert.equal(audit[0]?.actor, ctx.admin);
      assert.equal(audit[0]?.tenant_key, ctx.key);

      assert.deepEqual(await hybridDocuments(ctx, p.shared), [p.newer]);
      assert.deepEqual(await hybridDocuments(ctx, p.olderOwn), []);
    });

    it('a cached answer of the tenant is invalidated by the confirmation', async () => {
      const p = await pair(ctx, 'cache');
      const raised = await raise(ctx, p.newer, p.older);
      await cacheAnswer(ctx, p.older);
      assert.equal(await cacheCount(ctx), 1);
      await rows(ctx.db, CONFIRM_SQL, [raised.candidate_id, ctx.admin]);
      assert.equal(await cacheCount(ctx), 0);
    });

    it('a non-admin actor and an admin of another tenant get not_found and change nothing', async () => {
      const p = await pair(ctx, 'denied');
      const raised = await raise(ctx, p.newer, p.older);
      for (const actor of [ctx.member, ...(ctx.otherAdmin ? [ctx.otherAdmin] : [])]) {
        assert.match(await failure(ctx.db, CONFIRM_SQL, [raised.candidate_id, actor]), /not_found/, `actor ${actor} is refused`);
      }
      assert.equal((await candidate(ctx, String(raised.candidate_id))).status, 'pending');
      assert.equal((await docState(ctx, p.older)).is_current, true);
      assert.equal((await auditRows(ctx, p.older)).length, 0);
    });

    it('raise asserts the tenant key and refuses documents that are not current and ready in that tenant', async () => {
      const p = await pair(ctx, 'raisetenant');
      assert.match(await failure(ctx.db, RAISE_SQL, ['not-a-key', p.newer, p.older, '{}', null, 'detected']), /malformed tenant key/);
      const processing = await begin(ctx, `supersession/${next('proc')}.md`, next('proc'));
      assert.match(await failure(ctx.db, RAISE_SQL, [ctx.key, processing, p.older, '{}', null, 'detected']), /not_found/);
      assert.match(await failure(ctx.db, RAISE_SQL, [ctx.key, p.newer, p.newer, '{}', null, 'detected']), /same_document/);
      assert.match(await failure(ctx.db, RAISE_SQL, [ctx.key, p.newer, p.older, '{}', 'sideways', 'detected']), /invalid_direction/);
      assert.match(await failure(ctx.db, RAISE_SQL, [ctx.key, p.newer, p.older, '{}', null, 'guess']), /invalid_origin/);
      if (ctx.otherKey && ctx.otherUser) {
        const foreign = await currentDocument(ctx, 'foreign', next('tokforeign'), { key: ctx.otherKey, userId: ctx.otherUser, orgId: null });
        assert.match(await failure(ctx.db, RAISE_SQL, [ctx.key, p.newer, foreign.id, '{}', null, 'detected']), /not_found/);
        assert.match(await failure(ctx.db, RAISE_SQL, [ctx.otherKey, foreign.id, p.older, '{}', null, 'detected']), /not_found/);
        assert.equal((await docState(ctx, foreign.id)).is_current, true);
      }
      const stored = await rows(ctx.db, 'SELECT count(*)::int AS n FROM rag_supersession_candidates WHERE document_id = $1 OR candidate_document_id = $1', [p.older]);
      assert.equal(stored[0]?.n, 0, 'a refused raise stores nothing');
    });

    it('the tables have RLS on with no policies and no grant to anon or authenticated; every function is service_role only with an empty search_path', async () => {
      const tables = await rows(
        ctx.db,
        `SELECT c.relname AS name, c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
                has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
                has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
                has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN ('rag_supersession_candidates', 'rag_supersession_links') ORDER BY 1`,
      );
      assert.deepEqual(tables.map((row) => row.name), ['rag_supersession_candidates', 'rag_supersession_links']);
      for (const row of tables) {
        assert.equal(row.rls, true, `${row.name}: RLS on`);
        assert.equal(row.policies, 0, `${row.name}: no policies`);
        assert.equal(row.anon_select, false);
        assert.equal(row.auth_select, false);
        assert.equal(row.service_insert, false, `${row.name}: writes only through the functions`);
      }
      const functions = await rows(
        ctx.db,
        `SELECT p.oid::regprocedure::text AS sig,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                array_to_string(p.proconfig, ',') AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND (p.proname LIKE 'rag\\_%supersession%' OR p.proname = 'rag_publish_document_version')
          ORDER BY 1`,
      );
      const signatures = functions.map((row) => String(row.sig));
      for (const expected of [
        'rag_confirm_supersession(uuid,uuid,uuid)',
        'rag_publish_document_version(uuid,text)',
        'rag_supersession_raise(text,uuid,uuid,jsonb,text,text)',
      ]) {
        assert.ok(signatures.includes(expected), `${expected} exists`);
      }
      for (const row of functions) {
        assert.equal(row.anon, false, `${row.sig}: anon cannot execute`);
        assert.equal(row.authenticated, false, `${row.sig}: authenticated cannot execute`);
        assert.equal(row.service, true, `${row.sig}: service_role executes`);
        assert.equal(row.config, 'search_path=""', `${row.sig}: empty search_path`);
      }
    });
  });
}

for (const mode of MODES) {
  describe(`0806 supersession: pair, direction, dismiss, undo and stale rules (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('two documents with the same content hash are a duplicate, not a candidate', async () => {
      const p = await pair(ctx, 'dup');
      await rows(ctx.db, "UPDATE documents SET content_hash = 'same-content-hash' WHERE id IN ($1, $2)", [p.older, p.newer]);
      assert.match(await failure(ctx.db, RAISE_SQL, [ctx.key, p.newer, p.older, '{}', 'document_newer', 'detected']), /duplicate_not_candidate/);
      const stored = await rows(ctx.db, 'SELECT count(*)::int AS n FROM rag_supersession_candidates WHERE document_id IN ($1, $2)', [p.older, p.newer]);
      assert.equal(stored[0]?.n, 0);
    });

    it('raising the same pair twice, in either order, returns the existing pending candidate', async () => {
      const p = await pair(ctx, 'twice');
      const first = await raise(ctx, p.newer, p.older);
      const again = await raise(ctx, p.newer, p.older);
      const reversed = await raise(ctx, p.older, p.newer, null, 'uploader');
      assert.equal(first.outcome, 'raised');
      assert.equal(again.outcome, 'exists');
      assert.equal(reversed.outcome, 'exists');
      assert.equal(again.candidate_id, first.candidate_id);
      assert.equal(reversed.candidate_id, first.candidate_id);
      const stored = await rows(
        ctx.db,
        "SELECT count(*)::int AS n FROM rag_supersession_candidates WHERE status = 'pending' AND document_id IN ($1, $2)",
        [p.older, p.newer],
      );
      assert.equal(stored[0]?.n, 1);
    });

    it('a candidate without a direction is refused with direction_required until the caller names one of the two documents as older', async () => {
      const p = await pair(ctx, 'nodir');
      const other = await currentDocument(ctx, 'nodir-other', next('tokother'));
      const raised = await raise(ctx, p.newer, p.older, null);
      assert.match(await failure(ctx.db, CONFIRM_SQL, [raised.candidate_id, ctx.admin]), /direction_required/);
      assert.match(await failure(ctx.db, CONFIRM_OLDER_SQL, [raised.candidate_id, ctx.admin, other.id]), /direction_required/);
      assert.equal((await candidate(ctx, String(raised.candidate_id))).status, 'pending');
      assert.equal((await docState(ctx, p.older)).is_current, true);
      assert.equal((await docState(ctx, other.id)).is_current, true);
      const confirmed = (await rows(ctx.db, CONFIRM_OLDER_SQL, [raised.candidate_id, ctx.admin, p.older]))[0] as Row;
      assert.equal(confirmed.older_document_id, p.older);
      assert.equal((await docState(ctx, p.older)).is_current, false);
      assert.equal((await candidate(ctx, String(raised.candidate_id))).older_document_id, p.older);
    });

    it('dismiss marks the candidate dismissed and changes no document', async () => {
      const p = await pair(ctx, 'dismiss');
      const raised = await raise(ctx, p.newer, p.older);
      for (const actor of [ctx.member, ...(ctx.otherAdmin ? [ctx.otherAdmin] : [])]) {
        assert.match(await failure(ctx.db, DISMISS_SQL, [raised.candidate_id, actor]), /not_found/);
      }
      const dismissed = (await rows(ctx.db, DISMISS_SQL, [raised.candidate_id, ctx.admin]))[0] as Row;
      assert.equal(dismissed.outcome, 'dismissed');
      const row = await candidate(ctx, String(raised.candidate_id));
      assert.equal(row.status, 'dismissed');
      assert.equal(row.decided_by, ctx.admin);
      for (const id of [p.older, p.newer]) {
        const doc = await docState(ctx, id);
        assert.equal(doc.is_current, true);
        assert.equal(doc.superseded_by, null);
      }
      assert.deepEqual(await hybridDocuments(ctx, p.shared), sortIds(p.older, p.newer));
      assert.equal((await links(ctx, String(raised.candidate_id))).length, 0);
    });

    it('a second decision on a decided candidate returns already_decided', async () => {
      const p = await pair(ctx, 'decided');
      const confirmedFirst = await raise(ctx, p.newer, p.older);
      await rows(ctx.db, CONFIRM_SQL, [confirmedFirst.candidate_id, ctx.admin]);
      assert.match(await failure(ctx.db, CONFIRM_SQL, [confirmedFirst.candidate_id, ctx.admin]), /already_decided/);
      assert.match(await failure(ctx.db, DISMISS_SQL, [confirmedFirst.candidate_id, ctx.admin]), /already_decided/);
      assert.equal((await auditRows(ctx, p.older)).length, 1, 'only the first decision is audited');

      const q = await pair(ctx, 'decided2');
      const dismissedFirst = await raise(ctx, q.newer, q.older);
      await rows(ctx.db, DISMISS_SQL, [dismissedFirst.candidate_id, ctx.admin]);
      assert.match(await failure(ctx.db, CONFIRM_SQL, [dismissedFirst.candidate_id, ctx.admin]), /already_decided/);
      assert.match(await failure(ctx.db, DISMISS_SQL, [dismissedFirst.candidate_id, ctx.admin]), /already_decided/);
      assert.equal((await docState(ctx, q.older)).is_current, true);
    });

    it('undo restores the older document and its chunks, clears superseded_by, deletes the link and marks the candidate pending', async () => {
      const p = await pair(ctx, 'undo');
      const raised = await raise(ctx, p.newer, p.older);
      assert.match(await failure(ctx.db, UNDO_SQL, [raised.candidate_id, ctx.admin]), /not_confirmed/);
      await rows(ctx.db, CONFIRM_SQL, [raised.candidate_id, ctx.admin]);
      assert.deepEqual(await hybridDocuments(ctx, p.shared), [p.newer]);
      for (const actor of [ctx.member, ...(ctx.otherAdmin ? [ctx.otherAdmin] : [])]) {
        assert.match(await failure(ctx.db, UNDO_SQL, [raised.candidate_id, actor]), /not_found/);
      }
      const undone = (await rows(ctx.db, UNDO_SQL, [raised.candidate_id, ctx.admin]))[0] as Row;
      assert.equal(undone.outcome, 'undone');
      const older = await docState(ctx, p.older);
      assert.equal(older.is_current, true);
      assert.equal(older.status, 'ready');
      assert.equal(older.superseded_by, null);
      assert.ok((await chunkStates(ctx, p.older)).every((chunk) => chunk.is_current === true && chunk.status === 'ready'));
      assert.equal((await links(ctx, String(raised.candidate_id))).length, 0);
      const row = await candidate(ctx, String(raised.candidate_id));
      assert.equal(row.status, 'pending');
      assert.equal(row.decided_by, null);
      assert.equal(row.older_document_id, null);
      assert.deepEqual(await hybridDocuments(ctx, p.shared), sortIds(p.older, p.newer));
      assert.deepEqual((await auditRows(ctx, p.older)).map((entry) => entry.action), ['confirm_supersession', 'undo_supersession']);
      assert.match(await failure(ctx.db, UNDO_SQL, [raised.candidate_id, ctx.admin]), /not_confirmed/);
    });

    it('a candidate whose document was superseded or deleted in the meantime is stale and cannot be confirmed', async () => {
      const p = await pair(ctx, 'stale');
      const raised = await raise(ctx, p.newer, p.older);
      const v2 = await begin(ctx, p.olderKey, next('stale-v2'));
      await writeChunks(ctx, v2, [probe(next('tokv2'))]);
      assert.equal(await publish(ctx, v2), 'published');
      assert.match(await failure(ctx.db, CONFIRM_SQL, [raised.candidate_id, ctx.admin]), /stale_candidate/);
      assert.equal((await candidate(ctx, String(raised.candidate_id))).status, 'pending');
      assert.equal((await docState(ctx, p.newer)).is_current, true);
      assert.equal((await docState(ctx, v2)).is_current, true);

      const q = await pair(ctx, 'stale-deleted');
      const deletedCandidate = await raise(ctx, q.newer, q.older);
      await rows(ctx.db, "UPDATE documents SET status = 'deleted', is_current = false WHERE id = $1", [q.newer]);
      assert.match(await failure(ctx.db, CONFIRM_SQL, [deletedCandidate.candidate_id, ctx.admin]), /stale_candidate/);
      assert.equal((await docState(ctx, q.older)).is_current, true);
      const dismissed = (await rows(ctx.db, DISMISS_SQL, [deletedCandidate.candidate_id, ctx.admin]))[0] as Row;
      assert.equal(dismissed.outcome, 'dismissed', 'a stale candidate can still be dismissed');
    });
  });

  describe(`0806 supersession: list (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('lists pending candidates oldest first with both documents, then confirmed links with decision time and actor; stale candidates are flagged', async () => {
      const a = await pair(ctx, 'lista');
      const b = await pair(ctx, 'listb');
      const c = await pair(ctx, 'listc');
      await rows(ctx.db, "UPDATE documents SET doc_date = DATE '2024-01-02', effective_from = DATE '2024-02-01' WHERE id = $1", [a.older]);
      const first = await raise(ctx, a.newer, a.older);
      const second = await raise(ctx, b.newer, b.older, null);
      const confirmedOne = await raise(ctx, c.newer, c.older);
      await rows(ctx.db, CONFIRM_SQL, [confirmedOne.candidate_id, ctx.admin]);
      await rows(ctx.db, "UPDATE documents SET status = 'deleted', is_current = false WHERE id = $1", [b.newer]);

      const listed = await rows(ctx.db, LIST_SQL, [ctx.admin, ctx.key, 50, 0]);
      assert.deepEqual(
        listed.map((row) => [row.kind, row.candidate_id]),
        [
          ['candidate', first.candidate_id],
          ['candidate', second.candidate_id],
          ['link', confirmedOne.candidate_id],
        ],
      );
      assert.ok(listed.every((row) => Number(row.total_count) === 3));
      const [one, two, link] = listed as [Row, Row, Row];
      assert.equal(one.stale, false);
      assert.equal(one.status, 'pending');
      assert.equal(one.direction, 'document_newer');
      assert.equal(one.older_document_id, a.older);
      const doc = one.document as Row;
      const cand = one.candidate_document as Row;
      assert.equal(doc.id, a.newer);
      assert.equal(cand.id, a.older);
      for (const key of ['id', 'filename', 'doc_type', 'doc_date', 'effective_from', 'effective_to', 'uploaded_at', 'uploader_id', 'version']) {
        assert.ok(key in doc, `document carries ${key}`);
        assert.ok(key in cand, `candidate document carries ${key}`);
      }
      assert.equal(cand.doc_type, 'general');
      assert.equal(cand.doc_date, '2024-01-02');
      assert.equal(cand.effective_from, '2024-02-01');
      assert.ok(String(cand.filename).endsWith('.md'));
      assert.equal(two.stale, true, 'a candidate whose document was deleted is stale');
      assert.equal(two.older_document_id, null);
      assert.equal(link.status, 'confirmed');
      assert.equal(link.decided_by, ctx.admin);
      assert.ok(link.decided_at instanceof Date);
      assert.ok(link.link_id);
      assert.equal((link.document as Row).id, c.older);
      assert.equal((link.candidate_document as Row).id, c.newer);

      const paged = await rows(ctx.db, LIST_SQL, [ctx.admin, ctx.key, 1, 1]);
      assert.deepEqual(paged.map((row) => row.candidate_id), [second.candidate_id]);
      assert.equal(Number(paged[0]?.total_count), 3);

      assert.equal((await rows(ctx.db, LIST_SQL, [ctx.member, ctx.key, 50, 0])).length, 0, 'a non-admin lists nothing');
      if (ctx.otherAdmin) {
        assert.equal((await rows(ctx.db, LIST_SQL, [ctx.otherAdmin, ctx.key, 50, 0])).length, 0, 'an admin of another tenant lists nothing');
        assert.equal((await rows(ctx.db, LIST_SQL, [ctx.otherAdmin, null, 50, 0])).length, 0);
      }
      assert.equal((await rows(ctx.db, LIST_SQL, [ctx.admin, null, 50, 0])).length, 3);
    });
  });
}

async function hold(ctx: Ctx, documentId: string): Promise<string> {
  const row = (await rows(ctx.db, 'SELECT outcome FROM rag_hold_document_for_review(p_document_id => $1, p_tenant_key => $2)', [documentId, ctx.key]))[0];
  return String(row?.outcome);
}

/** A confirmed link from the older document's lineage to the newer one's. */
async function confirmedPair(ctx: Ctx, label: string) {
  const p = await pair(ctx, label);
  const raised = await raise(ctx, p.newer, p.older);
  await rows(ctx.db, CONFIRM_SQL, [raised.candidate_id, ctx.admin]);
  return { ...p, candidateId: String(raised.candidate_id) };
}

async function newVersion(ctx: Ctx, sourceKey: string, label: string): Promise<{ id: string; own: string }> {
  const own = next('toknewver');
  const id = await begin(ctx, sourceKey, next(label));
  await writeChunks(ctx, id, [probe(own)]);
  return { id, own };
}

async function pendingCandidatesOf(ctx: Ctx, documentId: string): Promise<Row[]> {
  return rows(ctx.db, "SELECT * FROM rag_supersession_candidates WHERE status = 'pending' AND (document_id = $1 OR candidate_document_id = $1)", [documentId]);
}

const APPROVE_SQL = 'SELECT * FROM rag_approve_upload(p_document_id => $1, p_actor => $2)';
const PURGE_SQL = 'SELECT public.rag_purge_hook_supersession(p_tenant_key => $1, p_lineage_id => $2, p_document_ids => $3::uuid[]) AS deleted';

for (const mode of MODES) {
  describe(`0806 supersession: publish respects confirmed lineage links (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('a new version of a superseded lineage is stored non-current, points at the newer document and raises one pending candidate without a direction', async () => {
      const p = await confirmedPair(ctx, 'retired');
      const v = await newVersion(ctx, p.olderKey, 'retired-v2');
      const row = (await rows(ctx.db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [v.id, ctx.key]))[0] as Row;
      assert.equal(row.outcome, 'superseded_lineage');
      assert.equal(row.document_id, v.id);
      const doc = await docState(ctx, v.id);
      assert.equal(doc.is_current, false);
      assert.equal(doc.status, 'ready');
      assert.equal(doc.superseded_by, p.newer);
      assert.ok((await chunkStates(ctx, v.id)).every((chunk) => chunk.is_current === false));
      assert.equal((await docState(ctx, p.newer)).is_current, true);
      assert.deepEqual(await hybridDocuments(ctx, v.own), []);
      assert.deepEqual(await hybridDocuments(ctx, p.shared), [p.newer]);

      const raised = await pendingCandidatesOf(ctx, v.id);
      assert.equal(raised.length, 1);
      assert.equal(raised[0]?.origin, 'detected');
      assert.equal(raised[0]?.direction, null);
      assert.equal(raised[0]?.document_id, v.id);
      assert.equal(raised[0]?.candidate_document_id, p.newer);
      assert.equal(await publish(ctx, v.id), 'superseded_lineage', 'a repeated publish raises no second candidate');
      assert.equal((await pendingCandidatesOf(ctx, v.id)).length, 1);

      const listed = await rows(ctx.db, LIST_SQL, [ctx.admin, ctx.key, 100, 0]);
      const entry = listed.find((item) => item.candidate_id === raised[0]?.id);
      assert.equal(entry?.stale, false, 'the raised candidate can be decided');
      assert.match(await failure(ctx.db, UNDO_SQL, [p.candidateId, ctx.admin]), /stale_candidate/, 'a later version of the retired lineage blocks the undo');
    });

    it('confirming the raised candidate with the new version as older keeps it retired; naming the current document as older reverses the link', async () => {
      const keep = await confirmedPair(ctx, 'keep');
      const v = await newVersion(ctx, keep.olderKey, 'keep-v2');
      assert.equal(await publish(ctx, v.id), 'superseded_lineage');
      const [cand] = await pendingCandidatesOf(ctx, v.id);
      assert.match(await failure(ctx.db, CONFIRM_SQL, [cand?.id, ctx.admin]), /direction_required/);
      const kept = (await rows(ctx.db, CONFIRM_OLDER_SQL, [cand?.id, ctx.admin, v.id]))[0] as Row;
      assert.equal(kept.outcome, 'confirmed');
      assert.equal((await docState(ctx, v.id)).is_current, false);
      assert.equal((await docState(ctx, keep.newer)).is_current, true);
      assert.equal(kept.link_id, (await links(ctx, keep.candidateId))[0]?.id, 'the existing link stands');
      assert.deepEqual((await auditRows(ctx, v.id)).map((entry) => entry.action), ['confirm_supersession']);

      const flip = await confirmedPair(ctx, 'flip');
      const w = await newVersion(ctx, flip.olderKey, 'flip-v2');
      assert.equal(await publish(ctx, w.id), 'superseded_lineage');
      const [flipCand] = await pendingCandidatesOf(ctx, w.id);
      const flipped = (await rows(ctx.db, CONFIRM_OLDER_SQL, [flipCand?.id, ctx.admin, flip.newer]))[0] as Row;
      assert.equal(flipped.outcome, 'confirmed');
      assert.equal(flipped.older_document_id, flip.newer);
      const now = await docState(ctx, w.id);
      assert.equal(now.is_current, true);
      assert.equal(now.superseded_by, null);
      assert.ok((await chunkStates(ctx, w.id)).every((chunk) => chunk.is_current === true));
      const retired = await docState(ctx, flip.newer);
      assert.equal(retired.is_current, false);
      assert.equal(retired.superseded_by, w.id);
      assert.equal((await links(ctx, flip.candidateId)).length, 0, 'the old link is removed');
      const reversed = await links(ctx, String(flipCand?.id));
      assert.equal(reversed.length, 1);
      assert.equal(reversed[0]?.older_lineage_id, retired.lineage_id);
      assert.equal(reversed[0]?.newer_lineage_id, now.lineage_id);
      assert.deepEqual(await hybridDocuments(ctx, w.own), [w.id]);
      assert.deepEqual(await hybridDocuments(ctx, flip.shared), []);
    });

    it('after undo a new version of the formerly superseded lineage publishes normally', async () => {
      const p = await confirmedPair(ctx, 'undone');
      await rows(ctx.db, UNDO_SQL, [p.candidateId, ctx.admin]);
      const v = await newVersion(ctx, p.olderKey, 'undone-v2');
      assert.equal(await publish(ctx, v.id), 'published');
      assert.equal((await docState(ctx, v.id)).is_current, true);
      const older = await docState(ctx, p.older);
      assert.equal(older.is_current, false);
      assert.equal(older.superseded_by, v.id, 'the DATA-07 swap within the lineage');
      assert.equal((await pendingCandidatesOf(ctx, v.id)).length, 0);
    });

    it('a chain of links resolves to the newest current document', async () => {
      const shared = next('tokchain');
      const x = await currentDocument(ctx, 'chain-x', shared);
      const y = await currentDocument(ctx, 'chain-y', shared);
      const z = await currentDocument(ctx, 'chain-z', shared);
      await rows(ctx.db, CONFIRM_SQL, [(await raise(ctx, y.id, x.id)).candidate_id, ctx.admin]);
      await rows(ctx.db, CONFIRM_SQL, [(await raise(ctx, z.id, y.id)).candidate_id, ctx.admin]);
      const v = await newVersion(ctx, x.sourceKey, 'chain-x2');
      assert.equal(await publish(ctx, v.id), 'superseded_lineage');
      assert.equal((await docState(ctx, v.id)).superseded_by, z.id);
      assert.deepEqual(await hybridDocuments(ctx, shared), [z.id]);
    });

    it('the pending_review and held branches of 0803 still come first on a superseded lineage, and approval accepts superseded_lineage', async () => {
      const p = await confirmedPair(ctx, 'holds');
      const pending = await newVersion(ctx, p.olderKey, 'holds-pending');
      assert.equal(await hold(ctx, pending.id), 'pending_review');
      assert.equal(await publish(ctx, pending.id), 'pending_review');
      assert.equal((await pendingCandidatesOf(ctx, pending.id)).length, 0, 'a held version raises nothing');

      const approved = (await rows(ctx.db, APPROVE_SQL, [pending.id, ctx.admin]))[0] as Row;
      assert.equal(approved.outcome, 'superseded_lineage');
      const doc = await docState(ctx, pending.id);
      assert.equal(doc.is_current, false);
      assert.equal(doc.status, 'ready');
      assert.equal(doc.superseded_by, p.newer);
      assert.deepEqual(
        (await rows(ctx.db, 'SELECT action FROM rag_admin_audit WHERE document_id = $1', [pending.id])).map((entry) => entry.action),
        ['approve_upload'],
      );
      assert.equal((await pendingCandidatesOf(ctx, pending.id)).length, 1);

      const held = await newVersion(ctx, p.olderKey, 'holds-batch');
      await rows(ctx.db, `UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"publish_hold": {"batch_id": "b1"}}'::jsonb WHERE id = $1`, [held.id]);
      assert.equal(await publish(ctx, held.id), 'held');
      assert.equal((await docState(ctx, held.id)).status, 'processing');

      const quarantined = await newVersion(ctx, p.olderKey, 'holds-quarantine');
      await rows(ctx.db, "UPDATE documents SET status = 'quarantined' WHERE id = $1", [quarantined.id]);
      assert.equal(await publish(ctx, quarantined.id), 'quarantined');
    });

    it('the purge hook removes the candidates and links of a purged lineage in that tenant only', async () => {
      const p = await confirmedPair(ctx, 'purge');
      const q = await pair(ctx, 'purge-other');
      const kept = await raise(ctx, q.newer, q.older);
      const older = await docState(ctx, p.older);
      const removed = (await rows(ctx.db, PURGE_SQL, [ctx.key, older.lineage_id, [p.older]]))[0] as Row;
      assert.equal(Number(removed.deleted), 2, 'one candidate and one link');
      assert.equal((await rows(ctx.db, 'SELECT 1 FROM rag_supersession_candidates WHERE id = $1', [p.candidateId])).length, 0);
      assert.equal((await links(ctx, p.candidateId)).length, 0);
      assert.equal((await candidate(ctx, String(kept.candidate_id))).status, 'pending');
      if (ctx.otherKey) {
        const q2 = await docState(ctx, q.older);
        const none = (await rows(ctx.db, PURGE_SQL, [ctx.otherKey, q2.lineage_id, [q.older]]))[0] as Row;
        assert.equal(Number(none.deleted), 0, 'another tenant key removes nothing');
        assert.equal((await candidate(ctx, String(kept.candidate_id))).status, 'pending');
      }
      assert.match(await failure(ctx.db, PURGE_SQL, ['not-a-key', older.lineage_id, []]), /malformed tenant key/);
    });

    it('a second apply of 0806 succeeds and leaves the catalog unchanged', async () => {
      const snapshot = async (): Promise<Row[]> => [
        ...(await rows(
          ctx.db,
          `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'rag\\_%supersession%' OR p.proname IN ('rag_publish_document_version', 'rag_approve_upload'))
           ORDER BY 1`,
        )),
        ...(await rows(
          ctx.db,
          `SELECT k.conrelid::regclass::text AS rel, k.conname::text AS name, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
            WHERE k.conrelid IN ('public.rag_supersession_candidates'::regclass, 'public.rag_supersession_links'::regclass, 'public.rag_admin_audit'::regclass)
            ORDER BY 1, 2`,
        )),
        ...(await rows(ctx.db, "SELECT indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'rag\\_supersession%' ORDER BY 1")),
      ];
      const before = await snapshot();
      await ctx.db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      assert.deepEqual(await snapshot(), before);
    });

    it('confirm, undo and publish take the lineage advisory locks before touching documents (concurrency backstop)', async () => {
      const defs = await rows(
        ctx.db,
        `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('rag_confirm_supersession', 'rag_undo_supersession', 'rag_publish_document_version', 'rag_supersession_lock_pair')`,
      );
      const def = (name: string): string => String(defs.find((row) => row.name === name)?.def ?? '');
      for (const name of ['rag_confirm_supersession', 'rag_undo_supersession']) {
        const body = def(name);
        const lock = body.indexOf('rag_supersession_lock_pair(');
        assert.ok(lock > 0, `${name} takes the pair locks`);
        assert.ok(lock < body.indexOf('UPDATE public.documents'), `${name} locks before it changes a document`);
      }
      const pairLock = def('rag_supersession_lock_pair');
      assert.ok(pairLock.indexOf('pg_advisory_xact_lock') < pairLock.indexOf('FOR UPDATE'), 'advisory locks first, then document rows');
      assert.match(pairLock, /ORDER BY d\.id FOR UPDATE/);
      const publishBody = def('rag_publish_document_version');
      assert.ok(publishBody.indexOf('pg_advisory_xact_lock') < publishBody.indexOf('FROM public.rag_supersession_links'), 'publish checks links under the lineage lock');
      assert.ok(publishBody.indexOf("'held'") < publishBody.indexOf('FROM public.rag_supersession_links'), 'the hold branches come before the link check');
    });
  });
}

describe('0806 migration file', () => {
  test('is one transaction that reloads the PostgREST schema', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION)), `${MIGRATION} exists`);
    const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.match(sql, /NOTIFY pgrst, 'reload schema';\s*$/);
  });

  test('does not define rag_release_quarantine (its newest body belongs to 0804) and says 0803 re-runs need 0806 again', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION)), `${MIGRATION} exists`);
    const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
    assert.doesNotMatch(sql, /FUNCTION public\.rag_release_quarantine/);
    assert.match(sql, /0803/);
    assert.match(sql, /re-run this file/i);
  });
});
