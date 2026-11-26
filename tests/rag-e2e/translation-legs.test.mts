import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;
type RetrievalResult = import('@/lib/rag/types').RetrievalResult;

const LEGACY = 'openai-3-small-1536';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const SOURCE_IT = 'Il modulo zeffiro registra ogni lettura del sensore ogni dieci minuti.';
const TRANSLATED_EN = 'The zephyr module logs every sensor reading every ten minutes.';
const QUESTION_EN = 'How often does the zephyr module log sensor readings?';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };
const V2_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_DOC_TRANSLATION: 'on',
};

const DOC_A = { docId: '00000000-0000-4000-8000-00000000a501', chunkId: '00000000-0000-4000-8000-00000000a5c1' };
const DOC_B = { docId: '00000000-0000-4000-8000-00000000b501', chunkId: '00000000-0000-4000-8000-00000000b5c1' };

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

describe('translation legs through the v2 pipeline, two tenants (XLG-04, D-30)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let configModule: typeof import('@/lib/rag/config');
  let registryModule: typeof import('@/lib/rag/backend/registry');
  let blocksModule: typeof import('@/lib/rag/generation/citations/blocks');
  let recordModule: typeof import('@/lib/rag/generation/citations/record');
  let floorModule: typeof import('@/lib/rag/refusal/floor');
  const saved: Record<string, string | undefined> = {};

  async function seedItalian(userId: string, tenantKey: string, doc: { docId: string; chunkId: string }) {
    await fixture.db.query("INSERT INTO documents (id, filename, content, user_id, language) VALUES ($1, 'zeffiro.md', $2, $3, 'it')", [
      doc.docId,
      SOURCE_IT,
      userId,
    ]);
    await fixture.db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, tenant_key, language, doc_type)
       VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb, $5, 'it', 'general')`,
      [doc.chunkId, doc.docId, SOURCE_IT, vec(SOURCE_IT), tenantKey],
    );
  }

  before(async () => {
    fixture = await createTwoTenantDatabase();
    await seedItalian(TWO_TENANT_IDS.userA, TENANT_A, DOC_A);
    await seedItalian(TWO_TENANT_IDS.userB, TENANT_B, DOC_B);
    await fixture.db.query('SELECT rag_write_chunk_translations($1, $2::jsonb)', [
      TENANT_A,
      JSON.stringify([
        {
          chunk_id: DOC_A.chunkId,
          language: 'en',
          content: TRANSLATED_EN,
          lexical_text: TRANSLATED_EN.toLowerCase(),
          source_content_hash: 'fixture-source-hash',
          model: 'fixture-translator',
          profile_id: LEGACY,
          embedding: embedText(TRANSLATED_EN),
          embedding_model: 'text-embedding-3-small',
        },
      ]),
    ]);
    await fixture.db.query("INSERT INTO rag_translation_settings (tenant_key, target_languages, enabled) VALUES ($1, ARRAY['en'], true)", [TENANT_A]);
    await fixture.db.query("INSERT INTO rag_translation_settings (tenant_key, target_languages, enabled) VALUES ($1, ARRAY['en'], true)", [TENANT_B]);
    edge = await startFakeEdge({ db: fixture.db });
    for (const name of [...Object.keys(V2_ENV), 'RAG_CITATIONS']) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), V2_ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    configModule = await import('@/lib/rag/config');
    registryModule = await import('@/lib/rag/backend/registry');
    blocksModule = await import('@/lib/rag/generation/citations/blocks');
    recordModule = await import('@/lib/rag/generation/citations/record');
    floorModule = await import('@/lib/rag/refusal/floor');
    // The fixture embedder scores across languages near zero; a fixture floor keeps the eval profile's floor out of the way (eval only).
    floorModule.setEvalScoreCalibration({ context_threshold: 0.01, context_image_threshold: 0.01 });
    configModule.resetRagConfigForTests();
    registryModule.resetRetrievalBackendForTests();
  });

  after(async () => {
    floorModule?.resetEvalScoreCalibration();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    configModule?.resetRagConfigForTests();
    registryModule?.resetRetrievalBackendForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  const scopeOf = async (userId: string): Promise<TenantScope> => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const retrieve = async (userId: string, env: Record<string, string> = {}, profile: 'chat' | 'voice' | 'eval' = 'chat') => {
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(env)) {
      previous[name] = process.env[name];
      process.env[name] = value;
    }
    configModule.resetRagConfigForTests();
    try {
      const scope = await scopeOf(userId);
      const start = edge.calls.length;
      const result: RetrievalResult = await rag.runRetrieval({
        scope,
        query: QUESTION_EN,
        profile,
        options: OPTIONS,
        signal: new AbortController().signal,
        citationLabeler: blocksModule.createCitationLabeler(),
      });
      const calls = edge.calls.slice(start).map((call) => call.path);
      return { result, calls };
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      configModule.resetRagConfigForTests();
    }
  };

  const translationCalls = (calls: string[]) => calls.filter((path) => path.endsWith('/rpc/hybrid_search_translations'));

  test('a question in English finds the Italian chunk through its translation; context, citation and snapshot hold the original', async () => {
    const { result, calls } = await retrieve(TWO_TENANT_IDS.userA, {}, 'eval');
    assert.equal(translationCalls(calls).length, 1, 'one translation search');
    const candidate = result.candidates.find((entry) => entry.chunk_id === DOC_A.chunkId);
    assert.ok(candidate, 'the source chunk is a candidate');
    assert.ok(Object.keys(candidate.legs ?? {}).some((leg) => leg.startsWith('dense_tr:en') || leg.startsWith('lexical_tr:en')), 'found by a translation leg');
    assert.equal(candidate.content.includes(SOURCE_IT), true);
    assert.ok(result.context?.includes(SOURCE_IT), 'the context holds the original sentence');
    assert.ok(!result.context?.includes(TRANSLATED_EN), 'no translated sentence in the context');
    assert.ok(!result.context?.toLowerCase().includes('zephyr'), 'no translated word in the context');
    const aliasMap = blocksModule.buildAliasMap(result.blocks);
    const block = aliasMap.ordered.find((entry) => entry.chunkIds.includes(DOC_A.chunkId));
    assert.ok(block, 'the source chunk has a citation block');
    const [record] = recordModule.buildCitationRecords([block.alias], aliasMap, 'chunk-alias');
    assert.ok(record, 'a citation record');
    assert.ok(record.quote.includes(SOURCE_IT), 'the snapshot quotes the original');
    assert.ok(!record.quote.includes(TRANSLATED_EN) && !record.quote.toLowerCase().includes('zephyr'), 'the snapshot holds no translated text');
    assert.ok(!JSON.stringify(result.candidates).includes(TRANSLATED_EN), 'no candidate carries the translated text');
  });

  test('tenant B, with the same question and no translations, makes no translation search and never sees A', async () => {
    const { result, calls } = await retrieve(TWO_TENANT_IDS.userB, {}, 'eval');
    assert.equal(translationCalls(calls).length, 0);
    assert.ok(!result.candidates.some((entry) => entry.chunk_id === DOC_A.chunkId));
    assert.ok(!result.candidates.some((entry) => Object.keys(entry.legs ?? {}).some((leg) => leg.includes('_tr:'))));
  });
});
