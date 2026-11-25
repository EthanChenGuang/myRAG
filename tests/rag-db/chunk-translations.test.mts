import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const ADMIN = TWO_TENANT_IDS.userA;

type Row = {
  leg: 'dense' | 'lexical';
  rank: number;
  chunk_id: string;
  document_id: string;
  translation_id: string;
  translation_language: string;
  content: string;
  translation_similarity: number | null;
  lexical_score: number | null;
};

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { message: String((error as { message?: string }).message ?? error), code: String((error as { code?: string }).code ?? '') };
  }
}

interface SeedOptions {
  tenantKey?: string;
  userId?: string;
  language?: string;
  docLanguage?: string | null;
  kind?: string;
  docType?: string;
  docDate?: string | null;
  scopes?: string[];
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  lineageId?: string | null;
}

interface Seeded {
  docId: string;
  chunkId: string;
}

export async function seedChunk(db: PGlite, text: string, options: SeedOptions = {}): Promise<Seeded> {
  const docId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, user_id, language, is_current, status, lineage_id)
     VALUES ($1, $2, $3, $4, $5, true, 'ready', $6)`,
    [docId, `${docId}.md`, text, options.userId ?? TWO_TENANT_IDS.userA, options.docLanguage ?? options.language ?? 'it', options.lineageId ?? null],
  );
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, language, is_current, status, chunk_kind,
       doc_type, doc_date, scopes, effective_from, effective_to)
     VALUES ($1, $2, $3, $4::vector, $3, $5, $6, true, 'ready', $7, $8, $9::date, $10::text[], $11::date, $12::date)`,
    [
      chunkId,
      docId,
      text,
      vec(text),
      options.tenantKey ?? TENANT_A,
      options.language ?? 'it',
      options.kind ?? 'text',
      options.docType ?? 'general',
      options.docDate ?? null,
      options.scopes ?? [],
      options.effectiveFrom ?? null,
      options.effectiveTo ?? null,
    ],
  );
  return { docId, chunkId };
}

export function translationRow(chunkId: string, language: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunk_id: chunkId,
    language,
    content: text,
    lexical_text: tokens(text).join(' '),
    source_content_hash: 'hash-1',
    model: 'fixture-translator',
    glossary_version: null,
    profile_id: LEGACY,
    embedding: embedText(text),
    embedding_model: 'text-embedding-3-small',
    ...extra,
  };
}

async function write(db: PGlite, tenantKey: string, rows: Record<string, unknown>[]): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT rag_write_chunk_translations($1, $2::jsonb) AS n', [tenantKey, JSON.stringify(rows)]);
  return Number(result.rows[0]?.n ?? 0);
}

interface SearchCall {
  tenantKey?: string;
  language: string;
  query: string;
  documentIds?: string[] | null;
  docTypes?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  scopes?: string[] | null;
  effectiveOn?: string | null;
  languages?: string[] | null;
}

async function search(db: PGlite, call: SearchCall): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text, document_id::text, translation_id::text, translation_language, content,
              translation_similarity, lexical_score
       FROM hybrid_search_translations(
         p_tenant_key => $1, p_profile_id => $2, p_language => $3,
         p_query_embedding => $4::vector, p_lexical_tokens => $5::text[],
         p_dense_limit => 20, p_lexical_limit => 20,
         p_document_ids => $6::uuid[], p_doc_types => $7::text[], p_date_from => $8::date, p_date_to => $9::date,
         p_scopes => $10::text[], p_effective_on => $11::date, p_languages => $12::text[]
       ) ORDER BY leg, rank`,
      [
        call.tenantKey ?? TENANT_A,
        LEGACY,
        call.language,
        vec(call.query),
        tokens(call.query),
        call.documentIds ?? null,
        call.docTypes ?? null,
        call.dateFrom ?? null,
        call.dateTo ?? null,
        call.scopes ?? null,
        call.effectiveOn ?? null,
        call.languages ?? null,
      ],
    )
  ).rows;
}

function chunkIds(rows: Row[], leg?: 'dense' | 'lexical'): Set<string> {
  return new Set(rows.filter((row) => !leg || row.leg === leg).map((row) => row.chunk_id));
}

async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number | string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

describe('chunk translations (0810, D-28, D-30)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
  });

  after(async () => {
    await db.close();
  });

  test('the translation tables and functions exist', async () => {
    const names = await db.query<{ t1: string | null; t2: string | null; f1: string | null; f2: string | null }>(
      `SELECT to_regclass('public.chunk_translations')::text AS t1, to_regclass('public.chunk_translation_embeddings')::text AS t2,
              to_regproc('public.hybrid_search_translations')::text AS f1, to_regproc('public.rag_write_chunk_translations')::text AS f2`,
    );
    const row = names.rows[0];
    assert.ok(row?.t1 && row.t2, 'tables exist');
    assert.ok(row?.f1 && row.f2, 'functions exist');
  });

  test('a stored translation is found by both legs and maps to its source chunk, never to the translation id', async () => {
    const source = 'ordinamento campione frase neutra trentuno';
    const translated = 'tracerword sample neutral sentence thirtyone';
    const seeded = await seedChunk(db, source, { language: 'it' });
    const chunksBefore = await count(db, 'SELECT count(*) AS n FROM document_chunks');
    assert.equal(await write(db, TENANT_A, [translationRow(seeded.chunkId, 'en', translated)]), 1);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM document_chunks'), chunksBefore, 'document_chunks row count is unchanged');

    const rows = await search(db, { language: 'en', query: translated });
    const dense = rows.filter((row) => row.leg === 'dense');
    const lexical = rows.filter((row) => row.leg === 'lexical');
    assert.equal(dense[0]?.chunk_id, seeded.chunkId);
    assert.equal(dense[0]?.rank, 1);
    assert.equal(lexical[0]?.chunk_id, seeded.chunkId);
    assert.equal(lexical[0]?.rank, 1);
    for (const row of rows) {
      assert.notEqual(row.chunk_id, row.translation_id);
      assert.equal(row.translation_language, 'en');
      assert.equal(row.document_id, seeded.docId);
    }
    assert.equal(dense[0]?.content, source, 'the row carries the original chunk text');
    assert.ok((dense[0]?.translation_similarity ?? 0) > 0.99);
    assert.ok((lexical[0]?.lexical_score ?? 0) > 0);
  });

  test('a query in a language without translations returns nothing', async () => {
    const rows = await search(db, { language: 'zh', query: 'tracerword sample neutral sentence thirtyone' });
    assert.equal(rows.length, 0);
  });

  test('hybrid_search_chunks does not see translation text', async () => {
    const rows = await db.query<{ chunk_id: string }>(
      `SELECT chunk_id::text FROM hybrid_search_chunks(
         p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL, p_lexical_tokens => $3::text[],
         p_dense_limit => 0, p_lexical_limit => 20)`,
      [TENANT_A, LEGACY, ['tracerword']],
    );
    assert.equal(rows.rows.length, 0);
  });

  test('only service_role may execute the search and writer functions', async () => {
    for (const fn of ['hybrid_search_translations', 'rag_write_chunk_translations']) {
      const acl = await db.query<{ role: string; ok: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') AS ok
         FROM pg_proc p, (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
         WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`,
        [fn],
      );
      assert.ok(acl.rows.length >= 3, `${fn} exists`);
      for (const row of acl.rows) {
        assert.equal(row.ok, row.role === 'service_role', `${fn} for ${row.role}`);
      }
    }
  });
});
