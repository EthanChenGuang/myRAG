import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION = 'supabase/migrations/0801_phase32_columns_checks.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

interface Ctx {
  mode: DeploymentMode;
  fixture: FixtureDatabase;
  db: PGlite;
  a: Tenant;
}

async function createCtx(mode: DeploymentMode): Promise<Ctx> {
  if (mode === 'single-tenant') {
    const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS });
    return { mode, fixture, db: fixture.db, a: { key: 's:default', userId: null, orgId: null } };
  }
  const fixture = await createTwoTenantDatabase();
  return { mode, fixture, db: fixture.db, a: { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA, orgId: null } };
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
    return assert.fail(`${sql.slice(0, 70).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
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

let sequence = 0;
const next = (label: string): string => `${label}-${++sequence}`;
const vectorText = (values: number[]): string => `[${values.join(',')}]`;
const halfvecOf = (text: string): number[] => embedText(text).slice(0, 1024);

async function begin(ctx: Ctx, label: string): Promise<string> {
  const row = (
    await rows(
      ctx.db,
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [ctx.a.key, ctx.a.userId, ctx.a.orgId, `phase32/${label}.md`, `${label}.md`, crypto.createHash('sha256').update(label).digest('hex')],
    )
  )[0];
  assert.ok(row?.document_id, 'begin returns a document id');
  return String(row.document_id);
}

const WRITE_SQL = `SELECT * FROM rag_write_chunks(
  p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => $5::boolean, p_total => $6::int)`;

async function writeChunks(ctx: Ctx, documentId: string, texts: string[], extra: (index: number) => Row = () => ({})): Promise<void> {
  const chunks = texts.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {}, ...extra(index) }));
  const embeddings = {
    [LEGACY_PROFILE]: texts.map((text) => embedText(text)),
    [HALFVEC_PROFILE]: texts.map((text) => halfvecOf(text)),
  };
  await rows(ctx.db, WRITE_SQL, [documentId, ctx.a.key, JSON.stringify(chunks), JSON.stringify(embeddings), true, texts.length]);
}

async function publish(ctx: Ctx, documentId: string): Promise<string> {
  const row = (await rows(ctx.db, 'SELECT outcome FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, ctx.a.key]))[0];
  return String(row?.outcome);
}

const SET_SQL = 'SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => $3::jsonb)';

async function chunkIds(ctx: Ctx, documentId: string): Promise<string[]> {
  return (await rows(ctx.db, 'SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])).map((row) => String(row.id));
}

/** Every retrieval function of the mode, each asked for the probe text; the ids it returns. */
async function retrievalHits(ctx: Ctx, text: string, token: string): Promise<Record<string, string[]>> {
  const dense = vectorText(embedText(text));
  const half = vectorText(halfvecOf(text));
  const hybrid = await rows(
    ctx.db,
    `SELECT leg, chunk_id::text AS id FROM hybrid_search_chunks(
       p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
       p_dense_limit => 200, p_lexical_limit => 200)`,
    [ctx.a.key, LEGACY_PROFILE, dense, [token]],
  );
  const profile = await rows(
    ctx.db,
    'SELECT id::text AS id FROM match_chunks_by_profile($1, $2, 1024, $3::halfvec, 200, -1::float8, false)',
    [ctx.a.key, HALFVEC_PROFILE, half],
  );
  const hits: Record<string, string[]> = {
    hybrid_dense: hybrid.filter((row) => row.leg === 'dense').map((row) => String(row.id)),
    hybrid_lexical: hybrid.filter((row) => row.leg === 'lexical').map((row) => String(row.id)),
    match_chunks_by_profile: profile.map((row) => String(row.id)),
  };
  if (ctx.mode === 'single-tenant') {
    hits.match_document_chunks = (
      await rows(ctx.db, 'SELECT chunk_id::text AS id FROM match_document_chunks(query_embedding => $1::vector, similarity_threshold => 0.0, match_count => 500)', [dense])
    ).map((row) => String(row.id));
    hits.match_documents = (await rows(ctx.db, 'SELECT id::text AS id FROM match_documents($1::vector, 500)', [dense])).map((row) => String(row.id));
  } else {
    hits.match_documents_by_workspace = (
      await rows(
        ctx.db,
        'SELECT id::text AS id FROM match_documents_by_workspace(p_query_embedding => $1::vector, p_match_count => 500, p_min_similarity => -1, p_org_id => NULL, p_user_id => $2::uuid)',
        [dense, ctx.a.userId],
      )
    ).map((row) => String(row.id));
    hits.match_document_chunks_by_org = (
      await rows(ctx.db, 'SELECT chunk_id::text AS id FROM match_document_chunks_by_org($1::uuid, $2::vector, 500, -1)', [TWO_TENANT_IDS.orgO, dense])
    ).map((row) => String(row.id));
  }
  return hits;
}

/** Constraints, columns, indexes and function definitions with their ACLs: what a second apply must leave unchanged. */
async function catalog(db: PGlite): Promise<Row[]> {
  const constraints = await rows(
    db,
    `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('public.documents'::regclass, 'public.document_chunks'::regclass, 'public.ingestion_jobs'::regclass)
      ORDER BY 1, 2`,
  );
  const columns = await rows(
    db,
    `SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('documents', 'document_chunks', 'ingestion_jobs') ORDER BY 1, 2`,
  );
  const indexes = await rows(
    db,
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('documents', 'document_chunks') ORDER BY 1, 2`,
  );
  const functions = await rows(
    db,
    `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_%' ORDER BY 1`,
  );
  return [...constraints, ...columns, ...indexes, ...functions];
}

for (const mode of MODES) {
  describe(`0801 pending_review status and ledger checks (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('documents.status accepts pending_review and still refuses an unknown value', async () => {
      const id = await begin(ctx, next('doc-status'));
      assert.equal(await failure(ctx.db, "UPDATE documents SET status = 'pending_review' WHERE id = $1", [id]), null);
      const held = await failure(ctx.db, "UPDATE documents SET status = 'held' WHERE id = $1", [id]);
      assert.equal(held?.code, '23514', 'an unknown status fails the check');
      const named = await rows(ctx.db, "SELECT conname FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%pending_review%'");
      assert.deepEqual(named.map((row) => row.conname), ['documents_status_check']);
    });

    it('document_chunks.status accepts pending_review and variant and still refuses an unknown value', async () => {
      const id = await begin(ctx, next('chunk-status'));
      await writeChunks(ctx, id, [`${next('chunkstatus')} neutral probe sentence`]);
      const [chunkId] = await chunkIds(ctx, id);
      assert.equal(await failure(ctx.db, "UPDATE document_chunks SET status = 'pending_review' WHERE id = $1", [chunkId]), null);
      assert.equal(await failure(ctx.db, "UPDATE document_chunks SET status = 'variant' WHERE id = $1", [chunkId]), null);
      const held = await failure(ctx.db, "UPDATE document_chunks SET status = 'held' WHERE id = $1", [chunkId]);
      assert.equal(held?.code, '23514');
      const named = await rows(ctx.db, "SELECT conname FROM pg_constraint WHERE conrelid = 'public.document_chunks'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%pending_review%'");
      assert.deepEqual(named.map((row) => row.conname), ['document_chunks_status_check']);
    });

    it('ingestion_jobs accepts kind translate and status pending_review and refuses an unknown kind', async () => {
      const insert = 'INSERT INTO ingestion_jobs (tenant_key, kind, status, source_key) VALUES ($1, $2, $3, $4)';
      assert.equal(await failure(ctx.db, insert, [ctx.a.key, 'translate', 'queued', next('translate')]), null);
      assert.equal(await failure(ctx.db, insert, [ctx.a.key, 'ingest', 'pending_review', next('held-job')]), null);
      const other = await failure(ctx.db, insert, [ctx.a.key, 'other', 'queued', next('other')]);
      assert.equal(other?.code, '23514');
      const badStatus = await failure(ctx.db, insert, [ctx.a.key, 'ingest', 'held', next('held-status')]);
      assert.equal(badStatus?.code, '23514');
    });

    it('rag_set_document_fields accepts status pending_review and still refuses ready', async () => {
      const id = await begin(ctx, next('setter-status'));
      const held = await rows(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ status: 'pending_review' })]);
      assert.equal(held[0]?.status, 'pending_review');
      const ready = await failure(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ status: 'ready' })]);
      assert.match(ready?.message ?? '', /invalid_status/);
      const unknown = await failure(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ approved_by: TWO_TENANT_IDS.userA })]);
      assert.match(unknown?.message ?? '', /invalid_field/);
    });

    it('a pending_review document and its chunks are returned by no retrieval function, and publishing returns them again', async () => {
      const token = `zqxheld${sequence + 1}${mode === 'single-tenant' ? 's' : 'm'}`;
      const text = `${token} the archive shelf holds the neutral probe sentence`;
      const id = await begin(ctx, next('held-retrieval'));
      await writeChunks(ctx, id, [text]);
      assert.equal(await publish(ctx, id), 'published');
      const [chunkId] = await chunkIds(ctx, id);
      assert.ok(chunkId);

      const visible = await retrievalHits(ctx, text, token);
      for (const [fn, ids] of Object.entries(visible)) assert.ok(ids.includes(chunkId), `${fn} returns the published chunk`);

      await rows(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ status: 'pending_review' })]);
      const chunk = (await rows(ctx.db, 'SELECT status FROM document_chunks WHERE id = $1', [chunkId]))[0];
      assert.equal(chunk?.status, 'pending_review', 'the setter carries the status to the chunks');
      const hidden = await retrievalHits(ctx, text, token);
      for (const [fn, ids] of Object.entries(hidden)) assert.ok(!ids.includes(chunkId), `${fn} returns no pending_review chunk`);

      assert.equal(await publish(ctx, id), 'published');
      const back = await retrievalHits(ctx, text, token);
      for (const [fn, ids] of Object.entries(back)) assert.ok(ids.includes(chunkId), `${fn} returns the chunk after publish`);
    });

    it('applying 0801 a second time leaves the catalog unchanged', async () => {
      const file = path.join(REPO_ROOT, MIGRATION);
      assert.ok(fs.existsSync(file), `${MIGRATION} exists`);
      const first = await catalog(ctx.db);
      await ctx.db.exec(fs.readFileSync(file, 'utf8'));
      const second = await catalog(ctx.db);
      assert.deepEqual(second, first);
    });
  });
}
