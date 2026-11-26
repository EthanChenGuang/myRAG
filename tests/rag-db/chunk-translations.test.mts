import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

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

describe('chunk translations follow their source chunk (0810, D-28 to D-31)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  });

  after(async () => {
    await db.close();
  });

  async function translated(text: string, options: SeedOptions = {}): Promise<Seeded & { query: string }> {
    const seeded = await seedChunk(db, `fonte ${text}`, options);
    const query = `${text} lifecycle neutral sentence`;
    await write(db, options.tenantKey ?? TENANT_A, [translationRow(seeded.chunkId, 'en', query)]);
    return { ...seeded, query };
  }

  async function found(seeded: { chunkId: string; query: string }, call: Partial<SearchCall> = {}): Promise<boolean> {
    const rows = await search(db, { language: 'en', query: seeded.query, ...call });
    const ids = chunkIds(rows);
    const dense = chunkIds(rows, 'dense').has(seeded.chunkId);
    const lexical = chunkIds(rows, 'lexical').has(seeded.chunkId);
    assert.equal(dense, lexical, 'dense and lexical legs agree');
    return ids.has(seeded.chunkId);
  }

  async function translationsOf(chunkId: string): Promise<{ translations: number; vectors: number }> {
    return {
      translations: await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE chunk_id = $1', [chunkId]),
      vectors: await count(
        db,
        'SELECT count(*) AS n FROM chunk_translation_embeddings e JOIN chunk_translations t ON t.id = e.translation_id WHERE t.chunk_id = $1',
        [chunkId],
      ),
    };
  }

  test('deleting the source chunk deletes its translations and their vectors', async () => {
    const seeded = await translated('cascadeword');
    assert.deepEqual(await translationsOf(seeded.chunkId), { translations: 1, vectors: 1 });
    await db.query('DELETE FROM document_chunks WHERE id = $1', [seeded.chunkId]);
    assert.deepEqual(await translationsOf(seeded.chunkId), { translations: 0, vectors: 0 });
    assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translation_embeddings e WHERE NOT EXISTS (SELECT 1 FROM chunk_translations t WHERE t.id = e.translation_id)'), 0);
  });

  test('a re-chunk (old chunks replaced) leaves no translation of the old chunks', async () => {
    const seeded = await translated('rechunkword');
    await db.query('DELETE FROM document_chunks WHERE document_id = $1', [seeded.docId]);
    const replacement = crypto.randomUUID();
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, language, is_current, status, doc_type)
       VALUES ($1, $2, 'fonte rechunkword', $3::vector, 'fonte rechunkword', $4, 'it', true, 'ready', 'general')`,
      [replacement, seeded.docId, vec('fonte rechunkword'), TENANT_A],
    );
    assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = $1', [seeded.docId]), 0);
    assert.equal(await found(seeded), false);
  });

  test('deleting the document deletes its translations', async () => {
    const seeded = await translated('docdeleteword');
    await db.query('DELETE FROM documents WHERE id = $1', [seeded.docId]);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = $1', [seeded.docId]), 0);
  });

  test('a replaced (superseded) document version is not returned', async () => {
    const seeded = await translated('supersededword');
    assert.equal(await found(seeded), true);
    await db.query('UPDATE documents SET is_current = false WHERE id = $1', [seeded.docId]);
    await db.query('UPDATE document_chunks SET is_current = false WHERE document_id = $1', [seeded.docId]);
    assert.equal(await found(seeded), false);
  });

  for (const status of ['quarantined', 'pending_review', 'deleted'] as const) {
    test(`a translation of a ${status} document is not returned`, async () => {
      const seeded = await translated(`status${status.replace('_', '')}word`);
      assert.equal(await found(seeded), true);
      await db.query('UPDATE documents SET status = $2, is_current = $3 WHERE id = $1', [seeded.docId, status, status !== 'deleted']);
      assert.equal(await found(seeded), false, 'the document status alone excludes it');
      await db.query('UPDATE document_chunks SET status = $2, is_current = $3 WHERE document_id = $1', [seeded.docId, status, status !== 'deleted']);
      assert.equal(await found(seeded), false);
    });
  }

  test('a held chunk under a ready document is not returned', async () => {
    const seeded = await translated('heldchunkword');
    await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE id = $1", [seeded.chunkId]);
    assert.equal(await found(seeded), false);
  });

  test('each DATA-08 filter that excludes the source chunk excludes its translation', async () => {
    const seeded = await translated('filterword', {
      docType: 'contract_legal',
      docDate: '2025-03-10',
      scopes: ['region:r-one'],
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
      language: 'it',
    });
    assert.equal(await found(seeded), true);
    assert.equal(await found(seeded, { documentIds: [seeded.docId] }), true);
    assert.equal(await found(seeded, { documentIds: [crypto.randomUUID()] }), false, 'document ids');
    assert.equal(await found(seeded, { docTypes: ['contract_legal'] }), true);
    assert.equal(await found(seeded, { docTypes: ['general'] }), false, 'doc types');
    assert.equal(await found(seeded, { dateFrom: '2025-03-01', dateTo: '2025-03-31' }), true);
    assert.equal(await found(seeded, { dateFrom: '2025-04-01' }), false, 'date range');
    assert.equal(await found(seeded, { scopes: ['region:r-one'] }), true);
    assert.equal(await found(seeded, { scopes: ['region:r-two'] }), false, 'scopes');
    assert.equal(await found(seeded, { effectiveOn: '2025-06-01' }), true);
    assert.equal(await found(seeded, { effectiveOn: '2026-06-01' }), false, 'effective date');
    assert.equal(await found(seeded, { languages: ['it'] }), true, 'the languages filter reads the source chunk language');
    assert.equal(await found(seeded, { languages: ['en'] }), false, 'languages');
  });

  test('a second translation for the same chunk and language updates the row and replaces its vector', async () => {
    const seeded = await translated('upsertword');
    const before = await db.query<{ id: string }>("SELECT id FROM chunk_translations WHERE chunk_id = $1 AND language = 'en'", [seeded.chunkId]);
    const next = 'upsertword revised neutral sentence';
    await write(db, TENANT_A, [translationRow(seeded.chunkId, 'en', next, { source_content_hash: 'hash-2' })]);
    const rows = await db.query<{ id: string; content: string; source_content_hash: string }>(
      "SELECT id, content, source_content_hash FROM chunk_translations WHERE chunk_id = $1 AND language = 'en'",
      [seeded.chunkId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.id, before.rows[0]?.id);
    assert.equal(rows.rows[0]?.content, next);
    assert.equal(rows.rows[0]?.source_content_hash, 'hash-2');
    assert.deepEqual(await translationsOf(seeded.chunkId), { translations: 1, vectors: 1 });
    const hit = await search(db, { language: 'en', query: next });
    assert.ok((hit.find((row) => row.leg === 'dense' && row.chunk_id === seeded.chunkId)?.translation_similarity ?? 0) > 0.99);
    const textOnly = translationRow(seeded.chunkId, 'en', 'upsertword third neutral sentence');
    delete textOnly.embedding;
    await write(db, TENANT_A, [textOnly]);
    assert.deepEqual(await translationsOf(seeded.chunkId), { translations: 1, vectors: 0 }, 'a changed text without a vector drops the stale vector');
  });

  test('a vector of the wrong dimension or of a scoped profile is refused', async () => {
    const seeded = await seedChunk(db, 'fonte dimsword');
    const wrong = translationRow(seeded.chunkId, 'en', 'dimsword neutral', { embedding: [0.1, 0.2, 0.3] });
    assert.equal((await failure(db, 'SELECT rag_write_chunk_translations($1, $2::jsonb)', [TENANT_A, JSON.stringify([wrong])]))?.code, '22000');
    const scoped = translationRow(seeded.chunkId, 'en', 'dimsword neutral', { profile_id: 'voyage-law-2-1024', embedding: new Array(1024).fill(0.01) });
    assert.match((await failure(db, 'SELECT rag_write_chunk_translations($1, $2::jsonb)', [TENANT_A, JSON.stringify([scoped])]))?.message ?? '', /scoped profile/);
  });

  test('settings: get returns defaults, set is admin-scoped, validated and read back', async () => {
    const empty = await db.query<{ target_languages: string[]; enabled: boolean }>('SELECT * FROM rag_translation_settings_get($1)', [TENANT_A]);
    assert.deepEqual(empty.rows[0]?.target_languages, []);
    assert.equal(empty.rows[0]?.enabled, false);
    await db.query('SELECT * FROM rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN, TENANT_A, ['en', 'zh', 'en']]);
    const saved = await db.query<{ target_languages: string[]; enabled: boolean; updated_by: string }>(
      'SELECT * FROM rag_translation_settings_get($1)',
      [TENANT_A],
    );
    assert.deepEqual(saved.rows[0]?.target_languages, ['en', 'zh']);
    assert.equal(saved.rows[0]?.enabled, true);
    assert.equal(saved.rows[0]?.updated_by, ADMIN);
    const other = `u:${TWO_TENANT_IDS.userB}`;
    assert.match((await failure(db, 'SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN, other, ['en']]))?.message ?? '', /not_admin/);
    assert.match(
      (await failure(db, 'SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [TWO_TENANT_IDS.userB, other, ['en']]))?.message ?? '',
      /not_admin/,
    );
    assert.equal((await failure(db, 'SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN, TENANT_A, ['EN!']]))?.code, '22023');
    assert.equal((await failure(db, 'SELECT rag_translation_settings_set($1, $2, ARRAY[NULL]::text[], true)', [ADMIN, TENANT_A]))?.code, '22023');
  });

  test('coverage and the pending page count eligible text and table chunks and skip up-to-date translations', async () => {
    const fresh = await createTwoTenantDatabase();
    const fdb = fresh.db;
    try {
      await fdb.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
      await fdb.query('SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN, TENANT_A, ['en']]);
      await fdb.query("DELETE FROM document_chunks WHERE tenant_key = $1", [TENANT_A]);
      const text = await seedChunk(fdb, 'fonte testo uno', { language: 'it' });
      const table = await seedChunk(fdb, 'fonte tabella due', { language: 'it', kind: 'table' });
      await seedChunk(fdb, 'image caption', { language: 'it', kind: 'image' });
      await seedChunk(fdb, 'already english', { language: 'en' });
      await seedChunk(fdb, 'unknown language', { language: 'und', docLanguage: 'it' });
      const held = await seedChunk(fdb, 'fonte trattenuta', { language: 'it' });
      await fdb.query("UPDATE documents SET status = 'pending_review' WHERE id = $1", [held.docId]);
      await fdb.query("UPDATE document_chunks SET content_hash = 'h-text' WHERE id = $1", [text.chunkId]);

      const pending = await fdb.query<{ chunk_id: string; source_content_hash: string; language: string }>(
        "SELECT chunk_id::text, source_content_hash, language FROM rag_translation_pending_page($1, 'en', 10)",
        [TENANT_A],
      );
      assert.deepEqual(new Set(pending.rows.map((row) => row.chunk_id)), new Set([text.chunkId, table.chunkId]));
      // 0820: the source hash is the sha256 of the content's UTF-8 bytes, whatever content_hash holds.
      const textHash = crypto.createHash('sha256').update('fonte testo uno', 'utf8').digest('hex');
      assert.equal(pending.rows.find((row) => row.chunk_id === text.chunkId)?.source_content_hash, textHash);
      const coverage = await fdb.query<{ language: string; translated: number; eligible: number }>('SELECT * FROM rag_translation_coverage($1)', [TENANT_A]);
      assert.deepEqual(coverage.rows.map((row) => ({ ...row, translated: Number(row.translated), eligible: Number(row.eligible) })), [
        { language: 'en', translated: 0, eligible: 2 },
      ]);

      await fdb.query('SELECT rag_write_chunk_translations($1, $2::jsonb)', [
        TENANT_A,
        JSON.stringify([translationRow(text.chunkId, 'en', 'text one', { source_content_hash: textHash })]),
      ]);
      await fdb.query('SELECT rag_write_chunk_translations($1, $2::jsonb)', [
        TENANT_A,
        JSON.stringify([translationRow(table.chunkId, 'en', 'table two', { source_content_hash: 'stale' })]),
      ]);
      const after1 = await fdb.query<{ chunk_id: string }>("SELECT chunk_id::text FROM rag_translation_pending_page($1, 'en', 10)", [TENANT_A]);
      assert.deepEqual(after1.rows.map((row) => row.chunk_id), [table.chunkId], 'a stale hash stays pending');
      const coverage2 = await fdb.query<{ translated: number; eligible: number }>('SELECT * FROM rag_translation_coverage($1)', [TENANT_A]);
      assert.equal(Number(coverage2.rows[0]?.translated), 1);
      const limited = await fdb.query("SELECT * FROM rag_translation_pending_page($1, 'en', 0)", [TENANT_A]);
      assert.equal(limited.rows.length, 0);
    } finally {
      await fdb.close();
    }
  });

  test('rag_language_document_counts returns per-language aggregates and no document id', async () => {
    const result = await db.query<Record<string, unknown>>('SELECT * FROM rag_language_document_counts()');
    assert.ok(result.rows.length > 0);
    for (const row of result.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['documents', 'language']);
    }
    const it = result.rows.find((row) => row.language === 'it');
    const expected = await count(db, "SELECT count(*) AS n FROM documents WHERE is_current AND status = 'ready' AND language = 'it'");
    assert.equal(Number(it?.documents), expected);
    const acl = await db.query<{ role: string; ok: boolean }>(
      `SELECT r.role, has_function_privilege(r.role, 'public.rag_language_document_counts()', 'EXECUTE') AS ok
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)`,
    );
    for (const row of acl.rows) assert.equal(row.ok, row.role === 'service_role');
  });

  test('the purge hook removes a tenant\'s translations by document or lineage and nothing else', async () => {
    const lineage = crypto.randomUUID();
    const byLineage = await translated('purgelineageword', { lineageId: lineage });
    const byDoc = await translated('purgedocword');
    const keep = await translated('purgekeepword');
    const other = `u:${TWO_TENANT_IDS.userB}`;
    const none = await db.query<{ n: number }>('SELECT rag_purge_hook_chunk_translations($1, $2, $3::uuid[]) AS n', [other, lineage, [byDoc.docId]]);
    assert.equal(Number(none.rows[0]?.n), 0, 'another tenant purges nothing');
    const purged = await db.query<{ n: number }>('SELECT rag_purge_hook_chunk_translations($1, $2, $3::uuid[]) AS n', [TENANT_A, lineage, [byDoc.docId]]);
    assert.equal(Number(purged.rows[0]?.n), 2);
    assert.equal((await translationsOf(byLineage.chunkId)).translations, 0);
    assert.equal((await translationsOf(byDoc.chunkId)).translations, 0);
    assert.deepEqual(await translationsOf(keep.chunkId), { translations: 1, vectors: 1 });
  });
});

describe('ledger kind translate (0810, D-29, research F-15)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let worker = 0;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
  });

  after(async () => {
    await db.close();
  });

  type Job = { id: string; kind: string; status: string; stage: string | null; source_key: string; attempts: unknown; locked_by: string | null };

  async function enqueueTranslate(documentId: string | null, settings: Record<string, unknown>, extra: { tenant?: string; status?: string; batch?: string | null; sourceKey?: string | null } = {}): Promise<Job> {
    const result = await db.query<Job>(
      `SELECT * FROM rag_enqueue_ingestion_job(
         p_tenant_key => $1, p_kind => 'translate', p_source => NULL, p_source_key => $2, p_settings => $3::jsonb,
         p_document_id => $4, p_batch_id => $5, p_status => $6)`,
      [extra.tenant ?? TENANT_A, extra.sourceKey ?? null, JSON.stringify(settings), documentId, extra.batch ?? null, extra.status ?? 'queued'],
    );
    const row = result.rows[0];
    assert.ok(row);
    return row;
  }

  async function job(id: string): Promise<Job> {
    const row = (await db.query<Job>('SELECT * FROM ingestion_jobs WHERE id = $1', [id])).rows[0];
    assert.ok(row);
    return row;
  }

  async function documentState(id: string): Promise<Record<string, unknown>> {
    return (await db.query<Record<string, unknown>>('SELECT status, processing_status, is_current, needs_review FROM documents WHERE id = $1', [id])).rows[0] ?? {};
  }

  async function claim(id: string): Promise<{ job: Job | null; worker: string }> {
    worker += 1;
    const name = `translate-worker-${worker}`;
    const row = (await db.query<Job>('SELECT * FROM rag_claim_ingestion_job($1, $2)', [id, name])).rows[0];
    return { job: row && row.id ? row : null, worker: name };
  }

  test('enqueue accepts kind translate with a document and a target language', async () => {
    const { docId } = await seedChunk(db, 'fonte coda uno');
    const queued = await enqueueTranslate(docId, { target_language: 'en' });
    assert.equal(queued.kind, 'translate');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.source_key, `translate:${docId}:en`);
    assert.deepEqual(queued.attempts, []);
  });

  test('enqueue refuses an unknown kind as before and a translate job without its inputs', async () => {
    const { docId } = await seedChunk(db, 'fonte coda rifiuti');
    const unknown = await failure(db, "SELECT rag_enqueue_ingestion_job($1, 'bogus', 'config_upload', 'k-1')", [TENANT_A]);
    assert.match(unknown?.message ?? '', /invalid_kind/);
    const noDocument = await failure(db, "SELECT rag_enqueue_ingestion_job(p_tenant_key => $1, p_kind => 'translate', p_settings => '{\"target_language\":\"en\"}'::jsonb)", [TENANT_A]);
    assert.match(noDocument?.message ?? '', /document_required/);
    for (const settings of [{}, { target_language: 'EN!' }, { target_language: '' }]) {
      const refused = await failure(db, "SELECT rag_enqueue_ingestion_job(p_tenant_key => $1, p_kind => 'translate', p_settings => $2::jsonb, p_document_id => $3)", [
        TENANT_A,
        JSON.stringify(settings),
        docId,
      ]);
      assert.match(refused?.message ?? '', /invalid_target_language/, JSON.stringify(settings));
    }
    const notQueued = await failure(
      db,
      "SELECT rag_enqueue_ingestion_job(p_tenant_key => $1, p_kind => 'translate', p_settings => '{\"target_language\":\"en\"}'::jsonb, p_document_id => $2, p_status => 'ready')",
      [TENANT_A, docId],
    );
    assert.match(notQueued?.message ?? '', /invalid_status/);
    const otherTenant = await failure(
      db,
      "SELECT rag_enqueue_ingestion_job(p_tenant_key => $1, p_kind => 'translate', p_settings => '{\"target_language\":\"en\"}'::jsonb, p_document_id => $2)",
      [`u:${TWO_TENANT_IDS.userB}`, docId],
    );
    assert.match(otherTenant?.message ?? '', /document_tenant_mismatch/);
  });

  test('a second enqueue for the same document and language returns the active job', async () => {
    const { docId } = await seedChunk(db, 'fonte coda doppia');
    const first = await enqueueTranslate(docId, { target_language: 'en' });
    const second = await enqueueTranslate(docId, { target_language: 'en' });
    assert.equal(second.id, first.id);
    const zh = await enqueueTranslate(docId, { target_language: 'zh' });
    assert.notEqual(zh.id, first.id);
    assert.equal(await count(db, "SELECT count(*) AS n FROM ingestion_jobs WHERE kind = 'translate' AND document_id = $1", [docId]), 2);
  });

  test('a translate job is claimed into embedding, advanced to ready, and writes no parse attempt, cache or budget row', async () => {
    const { docId } = await seedChunk(db, 'fonte coda percorso');
    const before = await documentState(docId);
    const cacheBefore = await count(db, 'SELECT count(*) AS n FROM rag_parse_cache');
    const queued = await enqueueTranslate(docId, { target_language: 'en' });
    const claimed = await claim(queued.id);
    assert.equal(claimed.job?.status, 'embedding');
    assert.equal(claimed.job?.locked_by, claimed.worker);
    const refused = await failure(db, "SELECT rag_advance_ingestion_job($1, $2, 'parse', 'parsing')", [queued.id, claimed.worker]);
    assert.match(refused?.message ?? '', /invalid_stage_for_kind/);
    await db.query("SELECT rag_advance_ingestion_job($1, $2, 'embed', 'embedding')", [queued.id, claimed.worker]);
    assert.deepEqual(await documentState(docId), before, 'the document is untouched while translating');
    await db.query("SELECT rag_advance_ingestion_job($1, $2, 'ready', 'ready')", [queued.id, claimed.worker]);
    const done = await job(queued.id);
    assert.equal(done.status, 'ready');
    assert.equal(done.locked_by, null);
    assert.deepEqual(done.attempts, []);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM rag_parse_cache'), cacheBefore);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM rag_parse_budget_reservations WHERE job_id = $1', [queued.id]), 0);
    assert.deepEqual(await documentState(docId), before);
    const again = await enqueueTranslate(docId, { target_language: 'en' });
    assert.notEqual(again.id, queued.id, 'a finished job does not block a new one');
  });

  test('a translate job reaching ready never releases a quarantined document', async () => {
    const { docId } = await seedChunk(db, 'fonte coda quarantena');
    const queued = await enqueueTranslate(docId, { target_language: 'en' });
    await db.query("UPDATE documents SET status = 'quarantined', processing_status = 'quarantined' WHERE id = $1", [docId]);
    const before = await documentState(docId);
    const claimed = await claim(queued.id);
    await db.query("SELECT rag_advance_ingestion_job($1, $2, 'ready', 'ready')", [queued.id, claimed.worker]);
    assert.deepEqual(await documentState(docId), before);
  });

  test('a failed translate job leaves its document unchanged, even a superseded one', async () => {
    const { docId } = await seedChunk(db, 'fonte coda fallita');
    const queued = await enqueueTranslate(docId, { target_language: 'en' });
    await db.query('UPDATE documents SET is_current = false WHERE id = $1', [docId]);
    const before = await documentState(docId);
    const claimed = await claim(queued.id);
    await db.query("SELECT rag_fail_ingestion_job($1, $2, 'translate_error', false)", [queued.id, claimed.worker]);
    assert.equal((await job(queued.id)).status, 'failed');
    assert.deepEqual(await documentState(docId), before);
  });

  test('the batch claim hands translate jobs out next to ingest jobs', async () => {
    await db.query("UPDATE ingestion_jobs SET status = 'failed', locked_by = NULL, lease_until = NULL WHERE status NOT IN ('ready', 'failed')");
    const { docId } = await seedChunk(db, 'fonte coda lotto');
    const queued = await enqueueTranslate(docId, { target_language: 'en' });
    const claimed = await db.query<Job>("SELECT * FROM rag_claim_ingestion_jobs('translate-batch-worker', 5, false)");
    assert.deepEqual(claimed.rows.map((row) => [row.id, row.status]), [[queued.id, 'embedding']]);
  });

  test('a second apply of 0810 is a no-op that keeps every translation, job and claim index', async () => {
    const before = await count(db, "SELECT count(*) AS n FROM ingestion_jobs WHERE kind = 'translate'");
    await applyMigrationFiles(db, ['supabase/migrations/0810_chunk_translations.sql']);
    assert.equal(await count(db, "SELECT count(*) AS n FROM ingestion_jobs WHERE kind = 'translate'"), before);
    for (const name of ['ingestion_jobs_claim_queued_idx', 'ingestion_jobs_claim_active_lease_idx']) {
      const def = await db.query<{ d: string }>('SELECT pg_get_indexdef(to_regclass($1)) AS d', [`public.${name}`]);
      assert.match(def.rows[0]?.d ?? '', /'translate'/, name);
    }
  });
});
