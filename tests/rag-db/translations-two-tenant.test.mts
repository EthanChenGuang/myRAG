import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const SOURCE = 'fonte gemella frase neutra';
const TRANSLATED = 'twinword identical neutral sentence';

type Role = 'anon' | 'authenticated';

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { message: String((error as { message?: string }).message ?? error), code: String((error as { code?: string }).code ?? '') };
  }
}

async function asRole<T>(db: PGlite, role: Role, userId: string, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function seed(db: PGlite, userId: string, tenantKey: string): Promise<{ docId: string; chunkId: string }> {
  const docId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  await db.query("INSERT INTO documents (id, filename, content, user_id, language) VALUES ($1, 'twin.md', $2, $3, 'it')", [docId, SOURCE, userId]);
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, language, doc_type)
     VALUES ($1, $2, $3, $4::vector, $3, $5, 'it', 'general')`,
    [chunkId, docId, SOURCE, vec(SOURCE), tenantKey],
  );
  await db.query('SELECT rag_write_chunk_translations($1, $2::jsonb)', [
    tenantKey,
    JSON.stringify([
      {
        chunk_id: chunkId,
        language: 'en',
        content: TRANSLATED,
        lexical_text: TRANSLATED,
        source_content_hash: 'same-hash',
        model: 'fixture-translator',
        profile_id: LEGACY,
        embedding: embedText(TRANSLATED),
        embedding_model: 'text-embedding-3-small',
      },
    ]),
  ]);
  return { docId, chunkId };
}

const SEARCH = `SELECT leg, chunk_id::text FROM hybrid_search_translations(
  p_tenant_key => $1, p_profile_id => $2, p_language => 'en', p_query_embedding => $3::vector,
  p_lexical_tokens => $4::text[], p_dense_limit => 50, p_lexical_limit => 50)`;

describe('chunk translations across two tenants (0810, D-30)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let a: { docId: string; chunkId: string };
  let b: { docId: string; chunkId: string };

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    a = await seed(db, TWO_TENANT_IDS.userA, TENANT_A);
    b = await seed(db, TWO_TENANT_IDS.userB, TENANT_B);
  });

  after(async () => {
    await db.close();
  });

  test('each tenant finds only its own translation, with identical text and vectors', async () => {
    for (const [tenant, own, foreign] of [
      [TENANT_A, a, b],
      [TENANT_B, b, a],
    ] as const) {
      const rows = (await db.query<{ leg: string; chunk_id: string }>(SEARCH, [tenant, LEGACY, vec(TRANSLATED), TRANSLATED.split(' ')])).rows;
      const ids = new Set(rows.map((row) => row.chunk_id));
      assert.ok(ids.has(own.chunkId));
      assert.ok(!ids.has(foreign.chunkId), `${tenant} must not see the other tenant`);
      assert.deepEqual(new Set(rows.map((row) => row.leg)), new Set(['dense', 'lexical']));
    }
  });

  test('a filter naming the other tenant\'s document returns nothing', async () => {
    const rows = await db.query(`${SEARCH.replace('p_lexical_limit => 50)', 'p_lexical_limit => 50, p_document_ids => $5::uuid[])')}`, [
      TENANT_B,
      LEGACY,
      vec(TRANSLATED),
      TRANSLATED.split(' '),
      [a.docId],
    ]);
    assert.equal(rows.rows.length, 0);
  });

  test('a malformed or other-mode tenant key is refused', async () => {
    assert.equal((await failure(db, SEARCH, ['s:default', LEGACY, vec(TRANSLATED), ['twinword']]))?.code, '22023');
    assert.equal((await failure(db, SEARCH, ['u:not-a-uuid', LEGACY, vec(TRANSLATED), ['twinword']]))?.code, '22023');
  });

  test('the writer refuses a chunk of another tenant', async () => {
    const refused = await failure(db, 'SELECT rag_write_chunk_translations($1, $2::jsonb)', [
      TENANT_B,
      JSON.stringify([{ chunk_id: a.chunkId, language: 'zh', content: 'x', lexical_text: 'x', source_content_hash: 'h', model: 'm' }]),
    ]);
    assert.match(refused?.message ?? '', /chunk_tenant_mismatch/);
    const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM chunk_translations WHERE chunk_id = $1 AND language = 'zh'", [a.chunkId]);
    assert.equal(count.rows[0]?.n, 0);
  });

  test('a translation or a vector row cannot carry a tenant key other than its chunk\'s', async () => {
    const translation = await failure(
      db,
      "INSERT INTO chunk_translations (chunk_id, tenant_key, language, content, source_content_hash, model) VALUES ($1, $2, 'zh', 'x', 'h', 'm')",
      [a.chunkId, TENANT_B],
    );
    assert.match(translation?.message ?? '', /tenant_mismatch/);
    const tid = (await db.query<{ id: string }>("SELECT id FROM chunk_translations WHERE chunk_id = $1 AND language = 'en'", [a.chunkId])).rows[0]?.id;
    const vector = await failure(
      db,
      `INSERT INTO chunk_translation_embeddings (translation_id, profile_id, tenant_key, embedding, embedding_model, dims)
       VALUES ($1, 'voyage-4-large-1024', $2, $3::halfvec, 'm', 1024)`,
      [tid, TENANT_B, `[${new Array(1024).fill(0.01).join(',')}]`],
    );
    assert.match(vector?.message ?? '', /tenant_mismatch/);
    const moved = await failure(db, 'UPDATE chunk_translation_embeddings SET tenant_key = $2 WHERE translation_id = $1', [tid, TENANT_B]);
    assert.match(moved?.message ?? '', /tenant_mismatch/);
    const stored = await db.query<{ tenant_key: string }>('SELECT tenant_key FROM chunk_translation_embeddings WHERE translation_id = $1', [tid]);
    assert.deepEqual(stored.rows.map((row) => row.tenant_key), [TENANT_A]);
  });

  test('settings, coverage and pending page are tenant-checked', async () => {
    for (const fn of ['rag_translation_settings_get($1)', 'rag_translation_coverage($1)', "rag_translation_pending_page($1, 'en', 5)"]) {
      assert.equal((await failure(db, `SELECT * FROM ${fn}`, ['s:default']))?.code, '22023', fn);
    }
    const pending = await db.query<{ chunk_id: string }>("SELECT chunk_id::text FROM rag_translation_pending_page($1, 'zh', 50)", [TENANT_B]);
    assert.ok(!pending.rows.some((row) => row.chunk_id === a.chunkId));
  });

  for (const role of ['anon', 'authenticated'] as const) {
    test(`as ${role} every statement on the three tables and every function call fails`, async () => {
      const user = TWO_TENANT_IDS.userA;
      const statements: [string, unknown[]][] = [
        ['SELECT 1 FROM chunk_translations LIMIT 1', []],
        ['SELECT 1 FROM chunk_translation_embeddings LIMIT 1', []],
        ['SELECT 1 FROM rag_translation_settings LIMIT 1', []],
        ["INSERT INTO chunk_translations (chunk_id, language, content, source_content_hash, model) VALUES ($1, 'zh', 'x', 'h', 'm')", [a.chunkId]],
        ["INSERT INTO rag_translation_settings (tenant_key, target_languages, enabled) VALUES ($1, '{en}', true)", [TENANT_A]],
        ['UPDATE chunk_translations SET content = $1', ['x']],
        ['DELETE FROM chunk_translation_embeddings', []],
        ['DELETE FROM rag_translation_settings', []],
        [SEARCH, [TENANT_A, LEGACY, vec(TRANSLATED), ['twinword']]],
        ['SELECT rag_write_chunk_translations($1, $2::jsonb)', [TENANT_A, '[]']],
        ['SELECT * FROM rag_translation_settings_get($1)', [TENANT_A]],
        ["SELECT rag_translation_settings_set($1, $2, '{en}'::text[], true)", [user, TENANT_A]],
        ['SELECT * FROM rag_translation_coverage($1)', [TENANT_A]],
        ["SELECT * FROM rag_translation_pending_page($1, 'en', 5)", [TENANT_A]],
        ['SELECT * FROM rag_language_document_counts()', []],
        ['SELECT rag_purge_hook_chunk_translations($1, NULL, $2::uuid[])', [TENANT_A, [a.docId]]],
      ];
      for (const [sql, params] of statements) {
        const err = await asRole(db, role, user, () => failure(db, sql, params));
        assert.ok(err, `${role} must not run: ${sql}`);
        assert.equal(err.code, '42501', `${sql}: ${err.message}`);
      }
    });
  }
});
