import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const OTHER = 'voyage-4-large-1024';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const SOURCE = 'frase neutra di prova per lo stato';
const TRANSLATED = 'neutral sample sentence for the state check';
const STATE = 'SELECT language, enabled, targeted, has_translations, has_profile_vectors FROM rag_translation_query_state($1, $2, $3::text[])';

type Row = { language: string; enabled: boolean; targeted: boolean; has_translations: boolean; has_profile_vectors: boolean };

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { message: String((error as { message?: string }).message ?? error), code: String((error as { code?: string }).code ?? '') };
  }
}

describe('rag_translation_query_state (0821, XLG-04, D-28, D-30)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let chunkA: string;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    const docId = crypto.randomUUID();
    chunkA = crypto.randomUUID();
    await db.query("INSERT INTO documents (id, filename, content, user_id, language) VALUES ($1, 'state.md', $2, $3, 'it')", [docId, SOURCE, TWO_TENANT_IDS.userA]);
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, language, doc_type)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'it', 'general')`,
      [chunkA, docId, SOURCE, `[${embedText(SOURCE).join(',')}]`, TENANT_A],
    );
    await db.query('SELECT rag_write_chunk_translations($1, $2::jsonb)', [
      TENANT_A,
      JSON.stringify([
        {
          chunk_id: chunkA,
          language: 'en',
          content: TRANSLATED,
          lexical_text: TRANSLATED,
          source_content_hash: 'state-hash',
          model: 'fixture-translator',
          profile_id: LEGACY,
          embedding: embedText(TRANSLATED),
          embedding_model: 'text-embedding-3-small',
        },
      ]),
    ]);
    await db.query("INSERT INTO rag_translation_settings (tenant_key, target_languages, enabled) VALUES ($1, ARRAY['en'], true)", [TENANT_A]);
  });

  after(async () => {
    await db?.close();
  });

  const state = async (tenant: string, profile: string, languages: string[]) => (await db.query<Row>(STATE, [tenant, profile, languages])).rows;

  test('reports the setting, translations and active-profile vectors per language, in the order asked', async () => {
    assert.deepEqual(await state(TENANT_A, LEGACY, ['it', 'en']), [
      { language: 'it', enabled: true, targeted: false, has_translations: false, has_profile_vectors: false },
      { language: 'en', enabled: true, targeted: true, has_translations: true, has_profile_vectors: true },
    ]);
  });

  test('another profile sees the translations without vectors (stale after a flip)', async () => {
    assert.deepEqual(await state(TENANT_A, OTHER, ['en']), [
      { language: 'en', enabled: true, targeted: true, has_translations: true, has_profile_vectors: false },
    ]);
  });

  test("tenant B sees nothing of tenant A's setting or translations", async () => {
    assert.deepEqual(await state(TENANT_B, LEGACY, ['en']), [
      { language: 'en', enabled: false, targeted: false, has_translations: false, has_profile_vectors: false },
    ]);
  });

  test('a malformed tenant, profile or language is refused with 22023', async () => {
    assert.equal((await failure(db, STATE, ['u:not-a-uuid', LEGACY, ['en']]))?.code, '22023');
    assert.equal((await failure(db, STATE, ['s:default', LEGACY, ['en']]))?.code, '22023');
    assert.equal((await failure(db, STATE, [TENANT_A, 'Bad Profile', ['en']]))?.code, '22023');
    assert.equal((await failure(db, STATE, [TENANT_A, LEGACY, ['EN!']]))?.code, '22023');
    assert.equal((await failure(db, STATE, [TENANT_A, LEGACY, new Array(17).fill('en')]))?.code, '22023');
  });

  test('anon and authenticated cannot execute it; service_role can; search_path is empty', async () => {
    for (const role of ['anon', 'authenticated']) {
      const allowed = await db.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, 'public.rag_translation_query_state(text, text, text[])', 'EXECUTE') AS ok",
        [role],
      );
      assert.equal(allowed.rows[0]?.ok, false, role);
    }
    const service = await db.query<{ ok: boolean }>(
      "SELECT has_function_privilege('service_role', 'public.rag_translation_query_state(text, text, text[])', 'EXECUTE') AS ok",
    );
    assert.equal(service.rows[0]?.ok, true);
    const config = await db.query<{ proconfig: string[] | null; prosecdef: boolean }>(
      "SELECT proconfig, prosecdef FROM pg_proc WHERE oid = 'public.rag_translation_query_state(text, text, text[])'::regprocedure",
    );
    assert.deepEqual(config.rows[0]?.proconfig, ['search_path=""']);
    assert.equal(config.rows[0]?.prosecdef, false);
  });
});
