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

    it('a pending_review document and its chunks are returned by no retrieval function, and publishing after a decision returns them again', async () => {
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

      assert.equal(await publish(ctx, id), 'pending_review', 'the 0803 guard refuses to publish a pending_review document');
      await rows(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ status: 'processing' })]);
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

const PROFILE_ID = 'phase32-general-p256';

interface ColumnSpec {
  table: 'documents' | 'document_chunks';
  column: string;
  type: string;
  nullable: 'YES' | 'NO';
  defaultLike?: RegExp;
}

const NEW_COLUMNS: ColumnSpec[] = [
  { table: 'documents', column: 'languages', type: 'ARRAY', nullable: 'NO', defaultLike: /'\{\}'::text\[\]/ },
  { table: 'documents', column: 'ingest_fingerprint', type: 'text', nullable: 'YES' },
  { table: 'documents', column: 'hidden_text_check', type: 'text', nullable: 'YES' },
  { table: 'documents', column: 'scopes', type: 'ARRAY', nullable: 'NO', defaultLike: /'\{\}'::text\[\]/ },
  { table: 'documents', column: 'effective_from', type: 'date', nullable: 'YES' },
  { table: 'documents', column: 'effective_to', type: 'date', nullable: 'YES' },
  { table: 'documents', column: 'effective_dates_origin', type: 'text', nullable: 'YES' },
  { table: 'documents', column: 'effective_dates_confidence', type: 'real', nullable: 'YES' },
  { table: 'documents', column: 'approved_by', type: 'uuid', nullable: 'YES' },
  { table: 'documents', column: 'approved_at', type: 'timestamp with time zone', nullable: 'YES' },
  { table: 'document_chunks', column: 'language_confidence', type: 'real', nullable: 'YES' },
  { table: 'document_chunks', column: 'scopes', type: 'ARRAY', nullable: 'NO', defaultLike: /'\{\}'::text\[\]/ },
  { table: 'document_chunks', column: 'effective_from', type: 'date', nullable: 'YES' },
  { table: 'document_chunks', column: 'effective_to', type: 'date', nullable: 'YES' },
  { table: 'document_chunks', column: 'approved_by', type: 'uuid', nullable: 'YES' },
];

for (const mode of MODES) {
  describe(`0801 new columns, setter fields and chunk writers (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
      await ctx.db.exec(`
        INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
        VALUES ('${PROFILE_ID}', 'general', 256, 'structure', 1024, 'building', '256/1024')
        ON CONFLICT DO NOTHING`);
    });

    after(async () => {
      await ctx?.db.close();
    });

    it('every new column exists with its type, nullability and default', async () => {
      for (const spec of NEW_COLUMNS) {
        const row = (
          await rows(
            ctx.db,
            `SELECT data_type, is_nullable, column_default, udt_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [spec.table, spec.column],
          )
        )[0];
        assert.ok(row, `${spec.table}.${spec.column} exists`);
        assert.equal(row.data_type, spec.type, `${spec.table}.${spec.column} type`);
        if (spec.type === 'ARRAY') assert.equal(row.udt_name, '_text', `${spec.table}.${spec.column} is text[]`);
        assert.equal(row.is_nullable, spec.nullable, `${spec.table}.${spec.column} nullability`);
        if (spec.defaultLike) assert.match(String(row.column_default), spec.defaultLike, `${spec.table}.${spec.column} default`);
      }
    });

    it('a new document has empty languages and scopes and null for the other new columns', async () => {
      const id = await begin(ctx, next('defaults'));
      const doc = (
        await rows(
          ctx.db,
          `SELECT languages, scopes, ingest_fingerprint, hidden_text_check, effective_from, effective_to, effective_dates_origin,
                  effective_dates_confidence, approved_by, approved_at FROM documents WHERE id = $1`,
          [id],
        )
      )[0];
      assert.deepEqual(doc, {
        languages: [],
        scopes: [],
        ingest_fingerprint: null,
        hidden_text_check: null,
        effective_from: null,
        effective_to: null,
        effective_dates_origin: null,
        effective_dates_confidence: null,
        approved_by: null,
        approved_at: null,
      });
    });

    it('the checks refuse effective_from after effective_to, an unknown hidden_text_check or origin and an out-of-range confidence', async () => {
      const id = await begin(ctx, next('checks'));
      const cases: [string, unknown[]][] = [
        ["UPDATE documents SET effective_from = '2025-06-01', effective_to = '2025-01-01' WHERE id = $1", [id]],
        ["UPDATE documents SET hidden_text_check = 'maybe' WHERE id = $1", [id]],
        ["UPDATE documents SET effective_dates_origin = 'guess' WHERE id = $1", [id]],
        ['UPDATE documents SET effective_dates_confidence = 1.5 WHERE id = $1', [id]],
      ];
      for (const [sql, params] of cases) assert.equal((await failure(ctx.db, sql, params))?.code, '23514', sql);
      for (const value of ['clean', 'hidden_found', 'not_checked', null]) {
        assert.equal(await failure(ctx.db, 'UPDATE documents SET hidden_text_check = $2 WHERE id = $1', [id, value]), null, `hidden_text_check ${String(value)}`);
      }
      assert.equal(await failure(ctx.db, "UPDATE documents SET effective_from = '2025-01-01', effective_to = '2025-01-01', effective_dates_origin = 'admin' WHERE id = $1", [id]), null);

      await writeChunks(ctx, id, [`${next('chunkcheck')} neutral probe sentence`]);
      const [chunkId] = await chunkIds(ctx, id);
      assert.equal((await failure(ctx.db, 'UPDATE document_chunks SET language_confidence = 1.5 WHERE id = $1', [chunkId]))?.code, '23514');
      assert.equal((await failure(ctx.db, 'UPDATE document_chunks SET language_confidence = -0.1 WHERE id = $1', [chunkId]))?.code, '23514');
      assert.equal(
        (await failure(ctx.db, "UPDATE document_chunks SET effective_from = '2025-06-01', effective_to = '2025-01-01' WHERE id = $1", [chunkId]))?.code,
        '23514',
      );
      assert.equal(await failure(ctx.db, 'UPDATE document_chunks SET language_confidence = 0.5 WHERE id = $1', [chunkId]), null);
    });

    it('rag_set_document_fields writes languages, ingest_fingerprint and hidden_text_check and refuses fields outside its list', async () => {
      const id = await begin(ctx, next('setter-fields'));
      const fingerprint = crypto.createHash('sha256').update('fingerprint-probe').digest('hex');
      await rows(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ languages: ['en', 'it'], ingest_fingerprint: fingerprint, hidden_text_check: 'clean' })]);
      const doc = (await rows(ctx.db, 'SELECT languages, ingest_fingerprint, hidden_text_check FROM documents WHERE id = $1', [id]))[0];
      assert.deepEqual(doc, { languages: ['en', 'it'], ingest_fingerprint: fingerprint, hidden_text_check: 'clean' });

      await rows(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ language: 'en' })]);
      const kept = (await rows(ctx.db, 'SELECT languages, ingest_fingerprint, hidden_text_check FROM documents WHERE id = $1', [id]))[0];
      assert.deepEqual(kept, doc, 'fields not named are left as they are');

      for (const fields of [{ languages: 'en' }, { languages: ['en', 3] }, { hidden_text_check: 'maybe' }, { ingest_fingerprint: 7 }]) {
        assert.match((await failure(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify(fields)]))?.message ?? '', /invalid_field/, JSON.stringify(fields));
      }
      for (const name of ['scopes', 'effective_from', 'effective_to', 'approved_by', 'approved_at', 'language_confidence']) {
        assert.match((await failure(ctx.db, SET_SQL, [id, ctx.a.key, JSON.stringify({ [name]: null })]))?.message ?? '', /invalid_field/, name);
      }
    });

    it('rag_write_chunks stores language_confidence when a chunk carries it and copies scopes and effective dates from the document', async () => {
      const id = await begin(ctx, next('writer-copy'));
      await rows(ctx.db, "UPDATE documents SET scopes = ARRAY['region:north'], effective_from = '2025-01-01', effective_to = '2026-12-31' WHERE id = $1", [id]);
      await writeChunks(ctx, id, [`${next('withconf')} neutral probe sentence one`, `${next('noconf')} neutral probe sentence two`], (index) =>
        index === 0 ? { language_confidence: 0.87 } : {},
      );
      const chunks = await rows(
        ctx.db,
        `SELECT chunk_index, language_confidence, scopes, effective_from::text AS effective_from, effective_to::text AS effective_to, approved_by
           FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
        [id],
      );
      assert.equal(chunks.length, 2);
      assert.ok(Math.abs(Number(chunks[0]?.language_confidence) - 0.87) < 1e-6, 'confidence of the chunk that carries it');
      assert.equal(chunks[1]?.language_confidence, null, 'null for a chunk without the key');
      for (const chunk of chunks) {
        assert.deepEqual(chunk.scopes, ['region:north']);
        assert.equal(chunk.effective_from, '2025-01-01');
        assert.equal(chunk.effective_to, '2026-12-31');
        assert.equal(chunk.approved_by, null);
      }

      const refused = await failure(ctx.db, WRITE_SQL, [id, ctx.a.key, JSON.stringify([{ chunk_index: 0, content: 'x', language_confidence: 'high' }]), null, false, null]);
      assert.match(refused?.message ?? '', /invalid_chunk/);
    });

    it('rag_write_profile_chunks stores language_confidence and copies scopes and effective dates from the document', async () => {
      const id = await begin(ctx, next('profile-copy'));
      await rows(ctx.db, "UPDATE documents SET scopes = ARRAY['department:ops', 'region:north'], effective_from = '2025-03-01' WHERE id = $1", [id]);
      const children = [
        { chunk_index: 0, content: 'profile child one neutral sentence', parent_index: 0, language_confidence: 0.42 },
        { chunk_index: 1, content: 'profile child two neutral sentence', parent_index: 0 },
      ];
      const parents = [{ parent_index: 0, content: 'profile parent neutral sentence', token_count: 12 }];
      await rows(
        ctx.db,
        `SELECT * FROM rag_write_profile_chunks(p_document_id => $1, p_tenant_key => $2, p_profile_id => $3, p_parents => $4::jsonb,
           p_children => $5::jsonb, p_embeddings => NULL, p_final => true, p_total => 2)`,
        [id, ctx.a.key, PROFILE_ID, JSON.stringify(parents), JSON.stringify(children)],
      );
      const chunks = await rows(
        ctx.db,
        `SELECT chunk_index, language_confidence, scopes, effective_from::text AS effective_from, effective_to::text AS effective_to
           FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY chunk_index`,
        [id, PROFILE_ID],
      );
      assert.equal(chunks.length, 2);
      assert.ok(Math.abs(Number(chunks[0]?.language_confidence) - 0.42) < 1e-6);
      assert.equal(chunks[1]?.language_confidence, null);
      for (const chunk of chunks) {
        assert.deepEqual(chunk.scopes, ['department:ops', 'region:north']);
        assert.equal(chunk.effective_from, '2025-03-01');
        assert.equal(chunk.effective_to, null);
      }
    });

    it('document_chunks.scopes has a GIN index and documents has a (tenant_key, ingest_fingerprint) index', async () => {
      const gin = (await rows(ctx.db, "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'document_chunks_scopes_gin'"))[0];
      assert.match(String(gin?.indexdef), /ON public\.document_chunks USING gin \(scopes\)/);
      const fingerprint = (await rows(ctx.db, "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'documents_tenant_fingerprint_idx'"))[0];
      assert.match(String(fingerprint?.indexdef), /ON public\.documents USING btree \(tenant_key, ingest_fingerprint\)/);
    });

    it('the replaced setter and writers keep an empty search_path and service_role-only execute', async () => {
      for (const signature of [
        'public.rag_set_document_fields(uuid, text, jsonb)',
        'public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer)',
        'public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer)',
      ]) {
        const row = (
          await rows(
            ctx.db,
            `SELECT p.proconfig, p.prosecdef,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
               FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [signature],
          )
        )[0];
        assert.ok(row, `${signature} exists`);
        assert.deepEqual(row.proconfig, ['search_path=""'], `${signature} search_path`);
        assert.equal(row.prosecdef, true, `${signature} stays SECURITY DEFINER`);
        assert.deepEqual([row.anon, row.authenticated, row.service], [false, false, true], `${signature} grants`);
      }
    });
  });
}

const LEDGER_ADMIN = '00000000-0000-4000-8000-0000000000f7';

const LEDGER_FUNCTIONS = [
  'public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb)',
  'public.rag_claim_ingestion_job(uuid, text, text)',
  'public.rag_claim_ingestion_jobs(text, integer, boolean, text)',
  'public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text)',
  'public.rag_enqueue_backfill_jobs(uuid, jsonb)',
  'public.rag_list_batch_jobs(uuid, text, uuid, integer)',
  'public.rag_ingest_job_status_for_stage(text)',
  'public.rag_ingest_mirror_processing_status(text)',
  'public.rag_purge_stale_ingestion_jobs(integer, integer)',
  'public.rag_publish_deferred_ingestion_job(uuid, text)',
];

for (const mode of MODES) {
  describe(`0801 ledger functions treat pending_review as terminal (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);
    const adminTenant = mode === 'single-tenant' ? 's:default' : `u:${LEDGER_ADMIN}`;

    before(async () => {
      ctx = await createCtx(mode);
      await ctx.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [LEDGER_ADMIN, 'ledger-admin@example.invalid']);
      await ctx.db.query('INSERT INTO admin_users (id) VALUES ($1)', [LEDGER_ADMIN]);
    });

    after(async () => {
      await ctx?.db.close();
    });

    const enqueue = async (tenantKey: string, documentId: string | null = null, status = 'queued'): Promise<string> => {
      const row = (
        await rows(
          ctx.db,
          `SELECT id FROM rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', $2, NULL, NULL, NULL, NULL, '{}'::jsonb, 100, $3::uuid, NULL, $4)`,
          [tenantKey, `ledger/${next('job')}`, documentId, status],
        )
      )[0];
      assert.ok(row?.id, 'enqueue returns a job id');
      return String(row.id);
    };

    const job = async (jobId: string): Promise<Row> =>
      (await rows(ctx.db, 'SELECT status, stage, retries, locked_by, lease_until, dead_letter_at FROM ingestion_jobs WHERE id = $1', [jobId]))[0] as Row;

    const advance = (jobId: string, worker: string, stage: string, status: string) =>
      failure(ctx.db, `SELECT rag_advance_ingestion_job($1, $2, $3, $4, NULL, 5, '{}'::jsonb)`, [jobId, worker, stage, status]);

    const batch = async (): Promise<string> =>
      String(
        (await rows(ctx.db, "INSERT INTO ingestion_batches (tenant_key, source_kind, source_ref) VALUES ($1, 'manifest', $2) RETURNING id", [ctx.a.key, next('manifest')]))[0]?.id,
      );

    let heldJob = '';
    let heldDocument = '';

    it('advance moves a leased job from its last working stage to pending_review, clears the lease and keeps the document unpublished', async () => {
      heldDocument = await begin(ctx, next('held-job-doc'));
      heldJob = await enqueue(ctx.a.key, heldDocument);
      const claimed = (await rows(ctx.db, 'SELECT id FROM rag_claim_ingestion_job($1, $2)', [heldJob, 'w1']))[0];
      assert.equal(claimed?.id, heldJob);
      assert.equal(await advance(heldJob, 'w1', 'publish', 'embedding'), null);
      assert.equal(await advance(heldJob, 'w1', 'pending_review', 'pending_review'), null, 'the transition to pending_review is accepted');
      const held = await job(heldJob);
      assert.equal(held.status, 'pending_review');
      assert.equal(held.stage, 'pending_review');
      assert.equal(held.locked_by, null);
      assert.equal(held.lease_until, null);
      const doc = (await rows(ctx.db, 'SELECT status, is_current, processing_status FROM documents WHERE id = $1', [heldDocument]))[0];
      assert.equal(doc?.is_current, false, 'the ledger transition publishes nothing');
      assert.notEqual(doc?.status, 'ready');
      assert.equal(doc?.processing_status, 'ready', 'processing is finished; the hold is the document status');
    });

    it('a pending_review job cannot be advanced again, failed or dead-lettered', async () => {
      assert.ok(heldJob, 'the previous test left a held job');
      const before = await job(heldJob);
      for (const [stage, status] of [['pending_review', 'pending_review'], ['ready', 'ready'], ['publish', 'embedding']] as const) {
        assert.equal((await advance(heldJob, 'w1', stage, status))?.code, '55000', `advance ${stage}`);
      }
      const failed = await failure(ctx.db, "SELECT rag_fail_ingestion_job($1, 'w1', 'probe', true, NULL)", [heldJob]);
      assert.equal(failed?.code, '55000');
      assert.deepEqual(await job(heldJob), before);
    });

    it('no claim call returns a pending_review job, even with an expired lease left on the row', async () => {
      assert.ok(heldJob);
      await rows(ctx.db, "UPDATE ingestion_jobs SET locked_by = 'w1', lease_until = now() - interval '1 hour', run_after = NULL WHERE id = $1", [heldJob]);
      const before = await job(heldJob);
      const single = (await rows(ctx.db, 'SELECT id FROM rag_claim_ingestion_job($1, $2)', [heldJob, 'w2']))[0];
      assert.equal(single?.id ?? null, null);
      const many = await rows(ctx.db, "SELECT id FROM rag_claim_ingestion_jobs('w2', 500, true)");
      assert.ok(!many.some((row) => row.id === heldJob), 'the batch claim skips it');
      const afterRow = await job(heldJob);
      assert.deepEqual(afterRow, before, 'not reaped: status, retries and dead-letter mark unchanged');
    });

    it('enqueue, backfill enqueue and batch listing accept the status pending_review; the enqueue kind list is unchanged', async () => {
      const queued = await enqueue(ctx.a.key, null, 'pending_review');
      assert.equal((await job(queued)).status, 'pending_review');
      const batchId = await batch();
      const inserted = (
        await rows(ctx.db, 'SELECT rag_enqueue_backfill_jobs($1, $2::jsonb) AS n', [batchId, JSON.stringify([{ kind: 'ingest', source_key: next('backfill'), status: 'pending_review' }])])
      )[0];
      assert.equal(inserted?.n, 1);
      const listed = await rows(ctx.db, "SELECT id, status FROM rag_list_batch_jobs($1, 'pending_review')", [batchId]);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.status, 'pending_review');
      const translate = await failure(
        ctx.db,
        `SELECT id FROM rag_enqueue_ingestion_job($1, 'translate', 'config_upload', $2, NULL, NULL, NULL, NULL, '{}'::jsonb, 100, NULL, NULL, 'queued')`,
        [ctx.a.key, next('translate')],
      );
      assert.match(translate?.message ?? '', /invalid_kind/, 'the enqueue function learns translate in a later plan');
    });

    it('retry refuses a pending_review job', async () => {
      const jobId = await enqueue(adminTenant, null, 'pending_review');
      const refused = await failure(ctx.db, 'SELECT rag_retry_ingestion_job($1, $2)', [jobId, LEDGER_ADMIN]);
      assert.match(refused?.message ?? '', /invalid_status_for_retry/);
      assert.equal((await job(jobId)).status, 'pending_review');
    });

    it('rag_publish_deferred_ingestion_job returns a batch job already at pending_review unchanged', async () => {
      const batchId = await batch();
      await rows(ctx.db, 'SELECT rag_enqueue_backfill_jobs($1, $2::jsonb)', [batchId, JSON.stringify([{ kind: 'ingest', source_key: next('deferred'), status: 'pending_review' }])]);
      const jobId = String((await rows(ctx.db, 'SELECT id FROM ingestion_jobs WHERE batch_id = $1', [batchId]))[0]?.id);
      const result = await failure(ctx.db, 'SELECT * FROM rag_publish_deferred_ingestion_job($1, $2)', [jobId, LEGACY_PROFILE]);
      assert.equal(result, null, 'no not_deferred refusal for a held job');
      assert.equal((await job(jobId)).status, 'pending_review');
    });

    it('retention archives a stale pending_review job like the other terminal statuses and leaves a fresh one', async () => {
      const stale = await enqueue(ctx.a.key, null, 'pending_review');
      const fresh = await enqueue(ctx.a.key, null, 'pending_review');
      await rows(ctx.db, "UPDATE ingestion_jobs SET updated_at = now() - interval '100 days' WHERE id = $1", [stale]);
      await rows(ctx.db, 'SELECT rag_purge_stale_ingestion_jobs(90, 5000)');
      assert.equal((await rows(ctx.db, 'SELECT 1 FROM ingestion_jobs WHERE id = $1', [stale])).length, 0);
      assert.equal((await rows(ctx.db, 'SELECT status FROM ingestion_jobs_archive WHERE id = $1', [stale]))[0]?.status, 'pending_review');
      assert.equal((await rows(ctx.db, 'SELECT status FROM ingestion_jobs WHERE id = $1', [fresh]))[0]?.status, 'pending_review');
    });

    it('every replaced ledger function keeps an empty search_path and service_role-only execute', async () => {
      for (const signature of LEDGER_FUNCTIONS) {
        const row = (
          await rows(
            ctx.db,
            `SELECT p.proconfig,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
               FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [signature],
          )
        )[0];
        assert.ok(row, `${signature} exists`);
        assert.deepEqual(row.proconfig, ['search_path=""'], `${signature} search_path`);
        assert.deepEqual([row.anon, row.authenticated, row.service], [false, false, true], `${signature} grants`);
      }
    });
  });
}
