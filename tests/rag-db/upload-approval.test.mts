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
