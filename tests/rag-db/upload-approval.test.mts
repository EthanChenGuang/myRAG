import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { migrationFiles } from '../../eval/harness/migrations.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION = 'supabase/migrations/0803_publish_hold.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

const ADMIN = '00000000-0000-4000-8000-0000000008a1';
const MEMBER = '00000000-0000-4000-8000-0000000008a2';
const OTHER_ADMIN = '00000000-0000-4000-8000-0000000008a3';

type Row = Record<string, unknown>;

interface Ctx {
  mode: DeploymentMode;
  db: PGlite;
  /** The tenant the pending uploads go to: the organization in multi-tenant mode, s:default in single-tenant mode. */
  key: string;
  userId: string | null;
  orgId: string | null;
  /** An admin of `key` (admin_users member; in multi-tenant mode also owner of the organization). */
  admin: string;
  /** A user who is not an admin of `key`. */
  member: string;
  /** An admin of another tenant only (multi-tenant mode), or null. */
  otherAdmin: string | null;
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
    return { mode, db, key: 's:default', userId: null, orgId: null, admin: ADMIN, member: MEMBER, otherAdmin: null };
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
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { code: codeOf(error), message: messageOf(error) };
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

let sequence = 0;
const next = (label: string): string => `${label}${++sequence}`;
const vectorText = (values: number[]): string => `[${values.join(',')}]`;
const halfvecOf = (text: string): number[] => embedText(text).slice(0, 1024);

/** A new document version for source key `sourceKey` (a new lineage when the key is new). */
async function begin(ctx: Ctx, sourceKey: string, label: string): Promise<string> {
  const row = (
    await rows(
      ctx.db,
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [ctx.key, ctx.userId, ctx.orgId, sourceKey, `${label}.md`, crypto.createHash('sha256').update(label).digest('hex')],
    )
  )[0];
  assert.ok(row?.document_id, 'begin returns a document id');
  return String(row.document_id);
}

const WRITE_SQL = `SELECT * FROM rag_write_chunks(
  p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => $5::boolean, p_total => $6::int)`;

async function writeChunks(ctx: Ctx, documentId: string, texts: string[]): Promise<void> {
  const chunks = texts.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const embeddings = {
    [LEGACY_PROFILE]: texts.map((text) => embedText(text)),
    [HALFVEC_PROFILE]: texts.map((text) => halfvecOf(text)),
  };
  await rows(ctx.db, WRITE_SQL, [documentId, ctx.key, JSON.stringify(chunks), JSON.stringify(embeddings), true, texts.length]);
}

async function publish(ctx: Ctx, documentId: string): Promise<string> {
  const row = (await rows(ctx.db, 'SELECT outcome FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, ctx.key]))[0];
  return String(row?.outcome);
}

async function hold(ctx: Ctx, documentId: string): Promise<string> {
  const row = (await rows(ctx.db, 'SELECT outcome FROM rag_hold_document_for_review(p_document_id => $1, p_tenant_key => $2)', [documentId, ctx.key]))[0];
  return String(row?.outcome);
}

const APPROVE_SQL = 'SELECT * FROM rag_approve_upload(p_document_id => $1, p_actor => $2)';
const REJECT_SQL = 'SELECT * FROM rag_reject_upload(p_document_id => $1, p_actor => $2)';

/** A published version 1 and a held version 2 of one lineage, each with one chunk naming its own probe token. */
async function lineageWithPendingVersion(ctx: Ctx, label: string): Promise<{ v1: string; v2: string; sourceKey: string; t1: string; t2: string }> {
  const sourceKey = `approval/${next(label)}.md`;
  const t1 = next('tokone');
  const t2 = next('toktwo');
  const v1 = await begin(ctx, sourceKey, next(`${label}-v1`));
  await writeChunks(ctx, v1, [`${t1} neutral probe sentence about a shared topic`]);
  assert.equal(await publish(ctx, v1), 'published');
  const v2 = await begin(ctx, sourceKey, next(`${label}-v2`));
  await writeChunks(ctx, v2, [`${t2} neutral probe sentence about a shared topic`]);
  assert.equal(await hold(ctx, v2), 'pending_review');
  return { v1, v2, sourceKey, t1, t2 };
}

async function docState(ctx: Ctx, id: string): Promise<Row> {
  return (await rows(ctx.db, 'SELECT id, status, is_current, version, approved_by, approved_at, metadata FROM documents WHERE id = $1', [id]))[0] as Row;
}

async function chunkStates(ctx: Ctx, id: string): Promise<Row[]> {
  return rows(ctx.db, 'SELECT status, is_current, approved_by FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id]);
}

/** The document ids hybrid_search_chunks returns for a probe sentence. */
async function hybridDocuments(ctx: Ctx, text: string, token: string): Promise<string[]> {
  const found = await rows(
    ctx.db,
    `SELECT DISTINCT c.document_id::text AS id FROM hybrid_search_chunks(
       p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
       p_dense_limit => 200, p_lexical_limit => 200) h
     JOIN document_chunks c ON c.id = h.chunk_id WHERE h.leg = 'lexical'`,
    [ctx.key, LEGACY_PROFILE, vectorText(embedText(text)), [token]],
  );
  return found.map((row) => String(row.id)).sort();
}

async function auditRows(ctx: Ctx, id: string): Promise<Row[]> {
  return rows(ctx.db, 'SELECT action, actor, tenant_key, version FROM rag_admin_audit WHERE document_id = $1 ORDER BY created_at, id', [id]);
}

for (const mode of MODES) {
  describe(`0803 upload approval: publish guard and approve (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('hold moves a processing document and its chunks to pending_review and refuses a ready document with not_holdable', async () => {
      const { v1, v2 } = await lineageWithPendingVersion(ctx, 'hold');
      assert.equal((await docState(ctx, v2)).status, 'pending_review');
      const chunks = await chunkStates(ctx, v2);
      assert.ok(chunks.length > 0);
      assert.ok(chunks.every((row) => row.status === 'pending_review'), 'every chunk of the held version is pending_review');
      const refused = await failure(ctx.db, 'SELECT * FROM rag_hold_document_for_review($1, $2)', [v1, ctx.key]);
      assert.match(refused?.message ?? '', /not_holdable/);
      const again = await failure(ctx.db, 'SELECT * FROM rag_hold_document_for_review($1, $2)', [v2, ctx.key]);
      assert.match(again?.message ?? '', /not_holdable/);
      assert.equal((await docState(ctx, v1)).status, 'ready', 'a refused hold changes nothing');
    });

    it('hold asserts the tenant key first and refuses another tenant', async () => {
      const id = await begin(ctx, `approval/${next('tenant')}.md`, next('tenant'));
      const malformed = await failure(ctx.db, 'SELECT * FROM rag_hold_document_for_review($1, $2)', [id, 'not-a-key']);
      assert.equal(malformed?.code, '22023');
      const otherKey = ctx.mode === 'single-tenant' ? `u:${ADMIN}` : `u:${TWO_TENANT_IDS.userB}`;
      const wrong = await failure(ctx.db, 'SELECT * FROM rag_hold_document_for_review($1, $2)', [id, otherKey]);
      assert.ok(wrong, 'a document of another tenant cannot be held');
      assert.equal((await docState(ctx, id)).status, 'processing');
    });

    it('a direct publish of a pending version returns pending_review and the previous version stays current and retrievable', async () => {
      const { v1, v2, t1, t2 } = await lineageWithPendingVersion(ctx, 'guard');
      await ctx.db.query(
        `INSERT INTO rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, expires_at)
         VALUES ($1, $2, $3, $4::halfvec, 'q', '{}'::jsonb, now() + interval '1 hour')`,
        [ctx.key, next('cachekey'), HALFVEC_PROFILE, vectorText(halfvecOf('probe'))],
      );
      assert.equal(await publish(ctx, v2), 'pending_review');
      const first = await docState(ctx, v1);
      assert.equal(first.status, 'ready');
      assert.equal(first.is_current, true);
      const second = await docState(ctx, v2);
      assert.equal(second.status, 'pending_review');
      assert.equal(second.is_current, false);
      assert.ok((await chunkStates(ctx, v2)).every((row) => row.status === 'pending_review' && row.is_current === false));
      assert.deepEqual(await hybridDocuments(ctx, `${t1} neutral probe sentence about a shared topic`, t1), [v1]);
      assert.ok(!(await hybridDocuments(ctx, `${t2} neutral probe sentence about a shared topic`, t2)).includes(v2), 'the pending version is never retrieved');
      const cache = await rows(ctx.db, 'SELECT count(*)::int AS n FROM rag_semantic_cache WHERE tenant_key = $1', [ctx.key]);
      assert.equal(cache[0]?.n, 1, 'a refused publish invalidates no cache entry');
    });

    it('approve by a tenant admin publishes the version, stamps the approver on the document and every chunk and writes one audit row', async () => {
      const { v1, v2, t2 } = await lineageWithPendingVersion(ctx, 'approve');
      const approved = (await rows(ctx.db, APPROVE_SQL, [v2, ctx.admin]))[0] as Row;
      assert.equal(approved.outcome, 'published');
      assert.equal(approved.document_id, v2);
      assert.equal(approved.superseded_document_id, v1);
      const doc = await docState(ctx, v2);
      assert.equal(doc.status, 'ready');
      assert.equal(doc.is_current, true);
      assert.equal(doc.approved_by, ctx.admin);
      assert.ok(doc.approved_at instanceof Date);
      const chunks = await chunkStates(ctx, v2);
      assert.ok(chunks.every((row) => row.approved_by === ctx.admin && row.is_current === true && row.status === 'ready'));
      const previous = await docState(ctx, v1);
      assert.equal(previous.is_current, false);
      assert.deepEqual(await hybridDocuments(ctx, `${t2} neutral probe sentence about a shared topic`, t2), [v2]);
      const audit = await auditRows(ctx, v2);
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.action, 'approve_upload');
      assert.equal(audit[0]?.actor, ctx.admin);
      assert.equal(audit[0]?.tenant_key, ctx.key);
    });

    it('approve stamps chunks of a non-legacy chunking profile that the profile trigger turns into variant', async () => {
      const { v2 } = await lineageWithPendingVersion(ctx, 'variant');
      await rows(
        ctx.db,
        "INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, organization_id, tenant_key, chunking_profile_id, status, is_current) SELECT gen_random_uuid(), id, 'variant probe', 99, '{}'::jsonb, organization_id, tenant_key, 'approval-variant', 'pending_review', false FROM documents WHERE id = $1",
        [v2],
      );
      const approved = (await rows(ctx.db, APPROVE_SQL, [v2, ctx.admin]))[0] as Row;
      assert.equal(approved.outcome, 'published');
      const chunks = await rows(ctx.db, 'SELECT status, approved_by FROM document_chunks WHERE document_id = $1', [v2]);
      assert.ok(chunks.every((row) => row.approved_by === ctx.admin), 'every chunk carries the approver');
      assert.ok(chunks.some((row) => row.status === 'variant'), 'the non-legacy chunk is a variant after publish');
    });

    it('a non-admin actor and an admin of another tenant get not_found and change nothing', async () => {
      const { v1, v2 } = await lineageWithPendingVersion(ctx, 'denied');
      const actors = [ctx.member, ...(ctx.otherAdmin ? [ctx.otherAdmin] : [])];
      for (const actor of actors) {
        const refused = await failure(ctx.db, APPROVE_SQL, [v2, actor]);
        assert.match(refused?.message ?? '', /not_found/, `actor ${actor} is refused with not_found`);
      }
      assert.equal((await docState(ctx, v2)).status, 'pending_review');
      assert.equal((await docState(ctx, v1)).is_current, true);
      assert.equal((await auditRows(ctx, v2)).length, 0);
    });

    it('the publish function keeps its signature and grants; the new functions are service_role only', async () => {
      const grants = await rows(
        ctx.db,
        `SELECT p.proname AS name,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                p.prosecdef AS definer,
                array_to_string(p.proconfig, ',') AS config,
                p.oid::regprocedure::text AS sig
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('rag_publish_document_version', 'rag_hold_document_for_review', 'rag_approve_upload')
          ORDER BY 1`,
      );
      assert.deepEqual(
        grants.map((row) => row.sig),
        [
          'rag_approve_upload(uuid,uuid)',
          'rag_hold_document_for_review(uuid,text)',
          'rag_publish_document_version(uuid,text)',
        ],
      );
      for (const row of grants) {
        assert.equal(row.anon, false, `${row.name}: anon cannot execute`);
        assert.equal(row.authenticated, false, `${row.name}: authenticated cannot execute`);
        assert.equal(row.service, true, `${row.name}: service_role executes`);
        assert.equal(row.config, 'search_path=""', `${row.name}: empty search_path`);
      }
      assert.deepEqual(
        Object.fromEntries(grants.map((row) => [row.name, row.definer])),
        { rag_approve_upload: true, rag_hold_document_for_review: false, rag_publish_document_version: true },
      );
    });
  });
}

const LIST_SQL = 'SELECT * FROM rag_list_pending_uploads(p_actor => $1, p_tenant_key => $2, p_limit => $3, p_offset => $4)';

/** A brand-new lineage whose only version is held. */
async function pendingNewDocument(ctx: Ctx, label: string): Promise<string> {
  const id = await begin(ctx, `approval/${next(label)}.md`, next(label));
  await writeChunks(ctx, id, [`${next('toknew')} neutral probe sentence for a new document`]);
  assert.equal(await hold(ctx, id), 'pending_review');
  return id;
}

for (const mode of MODES) {
  describe(`0803 upload approval: reject, list, ordering and repeat calls (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('reject of a pending new version deletes only that version; the current version stays current, ready and retrievable', async () => {
      const { v1, v2, t1 } = await lineageWithPendingVersion(ctx, 'reject');
      const rejected = (await rows(ctx.db, REJECT_SQL, [v2, ctx.admin]))[0] as Row;
      assert.equal(rejected.outcome, 'deleted');
      const doc = await docState(ctx, v2);
      assert.equal(doc.status, 'deleted');
      assert.equal(doc.is_current, false);
      assert.ok((await chunkStates(ctx, v2)).every((row) => row.status === 'deleted' && row.is_current === false));
      const previous = await docState(ctx, v1);
      assert.equal(previous.status, 'ready');
      assert.equal(previous.is_current, true);
      assert.deepEqual(await hybridDocuments(ctx, `${t1} neutral probe sentence about a shared topic`, t1), [v1]);
      const audit = await auditRows(ctx, v2);
      assert.deepEqual(audit.map((row) => row.action), ['reject_upload']);
    });

    it('reject of a pending new document goes through the soft-delete seam (lineage deleted, delete ledger row written)', async () => {
      const id = await pendingNewDocument(ctx, 'rejectnew');
      const rejected = (await rows(ctx.db, REJECT_SQL, [id, ctx.admin]))[0] as Row;
      assert.equal(rejected.outcome, 'deleted');
      assert.equal((await docState(ctx, id)).status, 'deleted');
      const ledger = await rows(ctx.db, "SELECT kind, status FROM ingestion_jobs WHERE document_id = $1 AND kind = 'delete'", [id]);
      assert.equal(ledger.length, 1, 'the soft-delete seam records the delete in the ledger');
      assert.deepEqual((await auditRows(ctx, id)).map((row) => row.action), ['reject_upload']);
    });

    it('approve and reject refuse a ready, a quarantined and an already decided document with not_pending', async () => {
      const { v1, v2 } = await lineageWithPendingVersion(ctx, 'repeat');
      for (const sql of [APPROVE_SQL, REJECT_SQL]) {
        assert.match((await failure(ctx.db, sql, [v1, ctx.admin]))?.message ?? '', /not_pending/, 'a ready document is not pending');
      }
      assert.equal(((await rows(ctx.db, APPROVE_SQL, [v2, ctx.admin]))[0] as Row).outcome, 'published');
      assert.match((await failure(ctx.db, APPROVE_SQL, [v2, ctx.admin]))?.message ?? '', /not_pending/, 'a second approve is refused');
      assert.match((await failure(ctx.db, REJECT_SQL, [v2, ctx.admin]))?.message ?? '', /not_pending/, 'a reject after an approve is refused');
      assert.equal((await auditRows(ctx, v2)).length, 1);

      const rejectedFirst = await pendingNewDocument(ctx, 'rejectfirst');
      await rows(ctx.db, REJECT_SQL, [rejectedFirst, ctx.admin]);
      assert.match((await failure(ctx.db, APPROVE_SQL, [rejectedFirst, ctx.admin]))?.message ?? '', /not_pending/, 'an approve after a reject is refused');
      assert.match((await failure(ctx.db, REJECT_SQL, [rejectedFirst, ctx.admin]))?.message ?? '', /not_pending/, 'a second reject is refused');

      const quarantined = await begin(ctx, `approval/${next('quar')}.md`, next('quar'));
      await rows(ctx.db, "UPDATE documents SET status = 'quarantined' WHERE id = $1", [quarantined]);
      for (const sql of [APPROVE_SQL, REJECT_SQL]) {
        assert.match((await failure(ctx.db, sql, [quarantined, ctx.admin]))?.message ?? '', /not_pending/, 'quarantine wins');
      }
      assert.equal((await docState(ctx, quarantined)).status, 'quarantined');
    });

    it('reject by a non-admin or an admin of another tenant is not_found', async () => {
      const id = await pendingNewDocument(ctx, 'rejectdenied');
      for (const actor of [ctx.member, ...(ctx.otherAdmin ? [ctx.otherAdmin] : [])]) {
        assert.match((await failure(ctx.db, REJECT_SQL, [id, actor]))?.message ?? '', /not_found/);
      }
      assert.equal((await docState(ctx, id)).status, 'pending_review');
    });

    it('approving a pending version older than the current version is refused with superseded_by_newer', async () => {
      const { v2, sourceKey } = await lineageWithPendingVersion(ctx, 'order');
      const v3 = await begin(ctx, sourceKey, next('order-v3'));
      await writeChunks(ctx, v3, [`${next('tokthree')} neutral probe sentence about a shared topic`]);
      assert.equal(await hold(ctx, v3), 'pending_review');
      assert.equal(((await rows(ctx.db, APPROVE_SQL, [v3, ctx.admin]))[0] as Row).outcome, 'published');
      const refused = await failure(ctx.db, APPROVE_SQL, [v2, ctx.admin]);
      assert.match(refused?.message ?? '', /superseded_by_newer/);
      const current = await docState(ctx, v3);
      assert.equal(current.is_current, true);
      assert.equal(current.status, 'ready');
      const older = await docState(ctx, v2);
      assert.equal(older.status, 'pending_review', 'the refused version stays pending for a reject');
      assert.equal(older.approved_by, null, 'the refusal rolls back the approver stamps');
      assert.equal(((await rows(ctx.db, REJECT_SQL, [v2, ctx.admin]))[0] as Row).outcome, 'deleted');
      assert.equal((await docState(ctx, v3)).is_current, true, 'rejecting the older version leaves the newer current');
    });

    it('an approval that publishes removes the tenant semantic-cache rows', async () => {
      const { v2 } = await lineageWithPendingVersion(ctx, 'cache');
      await ctx.db.query(
        `INSERT INTO rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, expires_at)
         VALUES ($1, $2, $3, $4::halfvec, 'q', '{}'::jsonb, now() + interval '1 hour')`,
        [ctx.key, next('cachekey'), HALFVEC_PROFILE, vectorText(halfvecOf('probe'))],
      );
      const count = async () => Number((await rows(ctx.db, 'SELECT count(*)::int AS n FROM rag_semantic_cache WHERE tenant_key = $1', [ctx.key]))[0]?.n);
      assert.equal(await count(), 1);
      await rows(ctx.db, APPROVE_SQL, [v2, ctx.admin]);
      assert.equal(await count(), 0);
    });

    it('the list returns pending rows of the actor tenants only, oldest first with id as tie-break, with total and new_version', async () => {
      await rows(ctx.db, "UPDATE documents SET status = 'deleted', is_current = false WHERE status = 'pending_review'");
      const first = await pendingNewDocument(ctx, 'listone');
      const { v2: second } = await lineageWithPendingVersion(ctx, 'listtwo');
      const third = await pendingNewDocument(ctx, 'listthree');
      await rows(ctx.db, "UPDATE documents SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1", [first]);
      await rows(ctx.db, "UPDATE documents SET created_at = '2026-01-02T00:00:00Z' WHERE id = ANY($1::uuid[])", [[second, third]]);
      const tied = [second, third].sort();

      const listed = await rows(ctx.db, LIST_SQL, [ctx.admin, null, 50, 0]);
      assert.deepEqual(listed.map((row) => row.document_id), [first, ...tied]);
      assert.ok(listed.every((row) => Number(row.total_count) === 3));
      const byId = Object.fromEntries(listed.map((row) => [String(row.document_id), row]));
      assert.equal(byId[second]?.new_version, true);
      assert.equal(byId[first]?.new_version, false);
      assert.equal(byId[first]?.uploader_id, ctx.userId);
      assert.equal(byId[first]?.source, 'config_upload');
      assert.equal(byId[first]?.doc_type, 'general');
      assert.equal(byId[first]?.tenant_key, ctx.key);
      assert.ok(byId[first]?.uploaded_at instanceof Date);

      const page = await rows(ctx.db, LIST_SQL, [ctx.admin, null, 1, 1]);
      assert.deepEqual(page.map((row) => row.document_id), [tied[0]]);
      assert.equal(Number(page[0]?.total_count), 3);

      const filtered = await rows(ctx.db, LIST_SQL, [ctx.admin, ctx.key, 50, 0]);
      assert.equal(filtered.length, 3);
      if (ctx.otherAdmin) {
        assert.equal((await rows(ctx.db, LIST_SQL, [ctx.otherAdmin, null, 50, 0])).length, 0, 'another tenant admin sees none of them');
        assert.equal((await rows(ctx.db, LIST_SQL, [ctx.otherAdmin, ctx.key, 50, 0])).length, 0, 'naming a foreign tenant key returns nothing');
      }
      assert.equal((await rows(ctx.db, LIST_SQL, [ctx.member, null, 50, 0])).length, 0, 'a non-admin sees nothing');
    });
  });
}

const ADD_SQL = 'SELECT * FROM rag_upload_exemption_add(p_actor => $1, p_tenant_key => $2, p_kind => $3, p_ref => $4)';
const REMOVE_SQL = 'SELECT * FROM rag_upload_exemption_remove(p_actor => $1, p_exemption_id => $2)';
const EXEMPT_LIST_SQL = 'SELECT * FROM rag_upload_exemption_list(p_actor => $1, p_tenant_key => $2, p_limit => $3, p_offset => $4)';
const RELEASE_SQL = 'SELECT * FROM rag_release_publish_hold(p_document_id => $1, p_tenant_key => $2)';
const IS_ADMIN_SQL = 'SELECT rag_is_tenant_admin(p_user => $1, p_tenant_key => $2) AS ok';

/** Signatures of every function this migration adds or replaces. */
const FUNCTIONS = [
  'rag_approve_upload(uuid,uuid)',
  'rag_hold_document_for_review(uuid,text)',
  'rag_is_tenant_admin(uuid,text)',
  'rag_list_pending_uploads(uuid,text,integer,integer)',
  'rag_publish_document_version(uuid,text)',
  'rag_reject_upload(uuid,uuid)',
  'rag_release_publish_hold(uuid,text)',
  'rag_upload_approval_keys(uuid)',
  'rag_upload_exemption_add(uuid,text,text,text)',
  'rag_upload_exemption_list(uuid,text,integer,integer)',
  'rag_upload_exemption_remove(uuid,uuid)',
  'rag_upload_exemptions_for(text)',
];

async function catalog(db: PGlite): Promise<Row[]> {
  const functions = await rows(
    db,
    `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.oid::regprocedure::text = ANY($1::text[]) ORDER BY 1`,
    [FUNCTIONS],
  );
  const table = await rows(
    db,
    `SELECT c.relname, c.relrowsecurity AS rls, c.relacl::text AS acl,
            (SELECT array_agg(conname::text || ':' || pg_get_constraintdef(k.oid) ORDER BY conname) FROM pg_constraint k WHERE k.conrelid = c.oid) AS checks,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c WHERE c.oid = 'public.rag_upload_approval_exemptions'::regclass`,
  );
  const columns = await rows(
    db,
    `SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name = 'rag_upload_approval_exemptions' OR (table_name = 'ingestion_batches' AND column_name = 'hold_publish'))
      ORDER BY 1, 2`,
  );
  const audit = await rows(db, "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rag_admin_audit_action_check'");
  return [...functions, ...table, ...columns, ...audit];
}

for (const mode of MODES) {
  describe(`0803 upload approval: exemptions, tenant admin and publish hold (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('anon and authenticated can neither touch the exemptions table nor call any new function', async () => {
      await rows(ctx.db, ADD_SQL, [ctx.admin, ctx.key, 'uploader', next('ref')]);
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(ctx.db, role, async () => {
          for (const sql of [
            'SELECT * FROM rag_upload_approval_exemptions',
            `INSERT INTO rag_upload_approval_exemptions (tenant_key, kind, ref, created_by) VALUES ('${ctx.key}', 'uploader', 'x', '${ctx.admin}')`,
            "UPDATE rag_upload_approval_exemptions SET ref = 'y'",
            'DELETE FROM rag_upload_approval_exemptions',
          ]) {
            const refused = await failure(ctx.db, sql);
            assert.equal(refused?.code, '42501', `${role}: ${sql.slice(0, 40)} is denied`);
          }
          for (const sig of FUNCTIONS) {
            const allowed = (await rows(ctx.db, 'SELECT has_function_privilege($1, $2::regprocedure, $3) AS ok', [role, `public.${sig}`, 'EXECUTE']))[0];
            assert.equal(allowed?.ok, false, `${role} cannot execute ${sig}`);
          }
        });
      }
      for (const sig of FUNCTIONS) {
        const meta = (
          await rows(
            ctx.db,
            "SELECT has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS ok, array_to_string(proconfig, ',') AS config FROM pg_proc WHERE oid = $1::regprocedure",
            [`public.${sig}`],
          )
        )[0];
        assert.equal(meta?.ok, true, `service_role executes ${sig}`);
        assert.equal(meta?.config, 'search_path=""', `${sig} has an empty search_path`);
      }
      const table = (await rows(ctx.db, "SELECT relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy WHERE polrelid = 'public.rag_upload_approval_exemptions'::regclass) AS policies FROM pg_class WHERE oid = 'public.rag_upload_approval_exemptions'::regclass"))[0];
      assert.equal(table?.rls, true);
      assert.equal(table?.policies, 0);
    });

    it('add, list and remove work for a tenant admin, are not_found for anyone else, and the pipeline reads the exemptions', async () => {
      const ref = next('connref');
      const added = (await rows(ctx.db, ADD_SQL, [ctx.admin, ctx.key, 'connector', ref]))[0] as Row;
      assert.equal(added.outcome, 'added');
      const again = (await rows(ctx.db, ADD_SQL, [ctx.admin, ctx.key, 'connector', ref]))[0] as Row;
      assert.equal(again.outcome, 'exists');
      assert.equal(again.id, added.id);

      const listed = await rows(ctx.db, EXEMPT_LIST_SQL, [ctx.admin, null, 50, 0]);
      const mine = listed.find((row) => row.id === added.id);
      assert.ok(mine);
      assert.equal(mine.kind, 'connector');
      assert.equal(mine.ref, ref);
      assert.equal(mine.created_by, ctx.admin);
      assert.equal(mine.tenant_key, ctx.key);

      const pipeline = await rows(ctx.db, 'SELECT kind, ref FROM rag_upload_exemptions_for($1)', [ctx.key]);
      assert.ok(pipeline.some((row) => row.kind === 'connector' && row.ref === ref));
      assert.equal((await failure(ctx.db, 'SELECT * FROM rag_upload_exemptions_for($1)', ['not-a-key']))?.code, '22023');

      for (const actor of [ctx.member, ...(ctx.otherAdmin ? [ctx.otherAdmin] : [])]) {
        assert.match((await failure(ctx.db, ADD_SQL, [actor, ctx.key, 'uploader', next('ref')]))?.message ?? '', /not_found/);
        assert.match((await failure(ctx.db, REMOVE_SQL, [actor, added.id]))?.message ?? '', /not_found/);
        assert.ok(!(await rows(ctx.db, EXEMPT_LIST_SQL, [actor, null, 50, 0])).some((row) => row.id === added.id));
      }
      assert.match((await failure(ctx.db, ADD_SQL, [ctx.admin, ctx.key, 'group', next('ref')]))?.message ?? '', /invalid_kind/);
      assert.match((await failure(ctx.db, ADD_SQL, [ctx.admin, ctx.key, 'uploader', '  ']))?.message ?? '', /invalid_ref/);

      const removed = (await rows(ctx.db, REMOVE_SQL, [ctx.admin, added.id]))[0] as Row;
      assert.equal(removed.outcome, 'removed');
      assert.match((await failure(ctx.db, REMOVE_SQL, [ctx.admin, added.id]))?.message ?? '', /not_found/);
      assert.ok(!(await rows(ctx.db, 'SELECT ref FROM rag_upload_exemptions_for($1)', [ctx.key])).some((row) => row.ref === ref));
    });

    it('the pair tenant_key, kind, ref is unique and the kind and tenant key are checked', async () => {
      const ref = next('uniq');
      const insert = `INSERT INTO rag_upload_approval_exemptions (tenant_key, kind, ref, created_by) VALUES ($1, $2, $3, $4::uuid)`;
      assert.equal(await failure(ctx.db, insert, [ctx.key, 'uploader', ref, ctx.admin]), null);
      assert.equal((await failure(ctx.db, insert, [ctx.key, 'uploader', ref, ctx.admin]))?.code, '23505');
      assert.equal(await failure(ctx.db, insert, [ctx.key, 'connector', ref, ctx.admin]), null, 'another kind with the same ref is a different exemption');
      assert.equal((await failure(ctx.db, insert, [ctx.key, 'group', next('ref'), ctx.admin]))?.code, '23514');
      assert.equal((await failure(ctx.db, insert, ['tenant-x', 'uploader', next('ref'), ctx.admin]))?.code, '23514');
    });

    it('rag_is_tenant_admin follows the Quarantine panel access rule', async () => {
      const isAdmin = async (user: string, key: string) => (await rows(ctx.db, IS_ADMIN_SQL, [user, key]))[0]?.ok;
      assert.equal(await isAdmin(ctx.admin, ctx.key), true, 'an admin of the tenant');
      assert.equal(await isAdmin(ctx.member, ctx.key), false, 'a member is not an admin');
      if (ctx.mode === 'multi-tenant') {
        assert.equal(await isAdmin(ctx.otherAdmin as string, ctx.key), false, 'an admin of another tenant');
        assert.equal(await isAdmin(ctx.otherAdmin as string, `u:${ctx.otherAdmin}`), true, 'a deployment admin for their own personal workspace');
        assert.equal(await isAdmin(ctx.admin, `u:${ctx.otherAdmin}`), false, 'not for the personal workspace of someone else');
        assert.equal(await isAdmin(ctx.member, `u:${ctx.member}`), false, 'a non-admin is not an admin of their own workspace');
        assert.equal((await failure(ctx.db, IS_ADMIN_SQL, [ctx.admin, 's:default']))?.code, '22023', 'the tenant key is asserted');
      } else {
        assert.equal((await failure(ctx.db, IS_ADMIN_SQL, [ctx.admin, `u:${ctx.admin}`]))?.code, '22023', 'the tenant key is asserted');
      }
      assert.equal(await isAdmin('00000000-0000-4000-8000-0000000008ff', ctx.key), false, 'an unknown user');
    });

    it('a document with metadata.publish_hold returns held from publish until rag_release_publish_hold clears it', async () => {
      const sourceKey = `approval/${next('heldkey')}.md`;
      const id = await begin(ctx, sourceKey, next('held'));
      await writeChunks(ctx, id, [`${next('tokheld')} neutral probe sentence for a held document`]);
      await rows(ctx.db, `UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"publish_hold": {"batch_id": "b1"}}'::jsonb WHERE id = $1`, [id]);
      assert.equal(await publish(ctx, id), 'held');
      const heldDoc = await docState(ctx, id);
      assert.equal(heldDoc.status, 'processing');
      assert.equal(heldDoc.is_current, false);

      const otherKey = ctx.mode === 'single-tenant' ? `u:${ADMIN}` : `u:${TWO_TENANT_IDS.userB}`;
      assert.ok(await failure(ctx.db, RELEASE_SQL, [id, otherKey]), 'another tenant cannot release the hold');
      assert.equal(await publish(ctx, id), 'held');

      assert.equal(((await rows(ctx.db, RELEASE_SQL, [id, ctx.key]))[0] as Row).outcome, 'released');
      assert.ok(!(((await docState(ctx, id)).metadata as Row) ?? {}).hasOwnProperty('publish_hold'));
      assert.equal(((await rows(ctx.db, RELEASE_SQL, [id, ctx.key]))[0] as Row).outcome, 'not_held');
      assert.equal(await publish(ctx, id), 'published');
    });

    it('a quarantined or pending document wins over the publish hold', async () => {
      const quarantined = await begin(ctx, `approval/${next('qh')}.md`, next('qh'));
      await rows(ctx.db, `UPDATE documents SET status = 'quarantined', metadata = '{"publish_hold": {}}'::jsonb WHERE id = $1`, [quarantined]);
      assert.equal(await publish(ctx, quarantined), 'quarantined');
      const pending = await pendingNewDocument(ctx, 'ph');
      await rows(ctx.db, `UPDATE documents SET metadata = '{"publish_hold": {}}'::jsonb WHERE id = $1`, [pending]);
      assert.equal(await publish(ctx, pending), 'pending_review');
    });

    it('ingestion_batches.hold_publish defaults to false', async () => {
      const column = (
        await rows(
          ctx.db,
          "SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingestion_batches' AND column_name = 'hold_publish'",
        )
      )[0];
      assert.deepEqual(column, { data_type: 'boolean', column_default: 'false', is_nullable: 'NO' });
    });

    it('a second apply of 0803 succeeds and leaves the catalog unchanged', async () => {
      const before = await catalog(ctx.db);
      // Re-running 0803 puts back its own publish and approve bodies; the later migrations that replace them (0806) are re-run after it.
      const files = migrationFiles(mode);
      for (const file of files.slice(files.indexOf(MIGRATION))) {
        await ctx.db.exec(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      }
      assert.deepEqual(await catalog(ctx.db), before);
    });
  });
}
