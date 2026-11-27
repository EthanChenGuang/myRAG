import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { ChunkTranslationModel, ChunkTranslationRequest } from '@/lib/rag/ingest/translate/translator';

// Plan 06.2-17 (XLG-05, D-14): document translation enforces the tenant's TERM glossary. A translation keeping the target term is stored
// with the TERM version as glossary_version, one keeping the untranslated source surface is corrected once and stored, one losing both is
// not stored (gap glossary_term_lost, counted on the run). Each tenant's job sees only its own pairs. Invented, neutral terms only.

const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const ADMIN = TWO_TENANT_IDS.userA;
const ADMIN_B = TWO_TENANT_IDS.userB;
const SOURCE_TERM = '晶格中继模块';
const TARGET_A = 'lattice relay module';
const TARGET_B = 'grid relay block';
const SWITCH_ENV = { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_TRANSLATION_GLOSSARY: 'true' } as const;

const ZH_BODY = [
  `本节说明${SOURCE_TERM}的总体结构以及各个组成部分之间的关系。`,
  '每个模块都有明确的职责，模块之间通过约定的接口交换数据。',
  '数据在进入系统之前会经过校验，校验失败的数据不会被保存。',
  '运行期间产生的记录按照时间顺序保存，便于之后查阅和比较。',
  '配置项集中保存在一个文件中，修改之后需要重新启动服务才能生效。',
].join('');

type Row = Record<string, unknown>;
type Behaviour = 'keep' | 'fix' | 'lose';

interface Recorder extends ChunkTranslationModel {
  calls: ChunkTranslationRequest[];
}

/** Keeps the text after a language tag; `keep` writes the target term, `fix` leaves the source surface, `lose` writes neither. */
function glossaryModel(behaviour: (text: string) => Behaviour, target: string): Recorder {
  const calls: ChunkTranslationRequest[] = [];
  return {
    model: 'fixture-translator',
    calls,
    async translate(request) {
      calls.push(request);
      const mode = behaviour(request.text);
      const body = mode === 'keep' ? request.text.replace(SOURCE_TERM, target) : mode === 'lose' ? request.text.replace(SOURCE_TERM, 'unit') : request.text;
      return { content: `[${request.targetLanguage}] ${body}` };
    },
  };
}

describe('document translation glossary (plan 06.2-17, D-14)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let postPublish: typeof import('@/lib/rag/ingest/post-publish');
  let translator: typeof import('@/lib/rag/ingest/translate/translator');
  let produce: typeof import('@/lib/rag/ingest/translate/produce');
  let ragConfig: typeof import('@/lib/rag/config');
  let terminologyLoad: typeof import('@/lib/rag/terminology/load');
  let lexicon: typeof import('@/lib/rag/terminology/lexicon');
  let languageSettings: typeof import('@/lib/rag/lang/settings');

  const upsertPair = async (actor: string, layer: string, target: string) => {
    await fixture.db.query('SELECT entry_id FROM public.rag_term_upsert_entry(p_actor => $1, p_layer_key => $2, p_entry => $3::jsonb, p_expected_version => $4)', [
      actor,
      layer,
      JSON.stringify({
        canonical: target,
        variants: [SOURCE_TERM],
        normalized_variants: [SOURCE_TERM],
        language: 'zh',
        kind: 'translation',
        mode: 'one_way',
        source_language: 'zh',
        target_language: 'en',
      }),
      0,
    ]);
  };

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    postPublish = await import('@/lib/rag/ingest/post-publish');
    translator = await import('@/lib/rag/ingest/translate/translator');
    produce = await import('@/lib/rag/ingest/translate/produce');
    ragConfig = await import('@/lib/rag/config');
    terminologyLoad = await import('@/lib/rag/terminology/load');
    lexicon = await import('@/lib/rag/terminology/lexicon');
    languageSettings = await import('@/lib/rag/lang/settings');
    languageSettings.resetLanguageSettingsForTests();
    for (const admin of [ADMIN, ADMIN_B]) await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [admin]);
    await fixture.db.query('SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN, TENANT_A, ['en']]);
    await fixture.db.query('SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN_B, TENANT_B, ['en']]);
    await upsertPair(ADMIN, TENANT_A, TARGET_A);
    await upsertPair(ADMIN_B, TENANT_B, TARGET_B);
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
  });

  afterEach(async () => {
    await postPublish.postPublishSettledForTests();
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    configModule.resetIngestConfigForTests();
    translator.resetChunkTranslationModelForTests();
    postPublish.resetPostPublishHooksForTests();
    for (const name of Object.keys(SWITCH_ENV)) delete process.env[name];
    ragConfig.resetRagConfigForTests();
    terminologyLoad.invalidateTerminologyCache('all');
    lexicon.resetTerminologyLexiconForTests();
  });

  const withTranslation = (translation: 'on' | 'off') => {
    depsModule.resetIngestDepsForTests();
    const base = depsModule.getIngestDeps().ingestEnv;
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...base(), RAG_LANGUAGE_AWARE_INGEST: 'on', RAG_DOC_TRANSLATION: translation }) });
  };

  const glossaryOn = () => {
    Object.assign(process.env, SWITCH_ENV);
    ragConfig.resetRagConfigForTests();
  };

  const upload = async (userId: string, filename: string, marker: string) => {
    withTranslation('off');
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    const result = await ingestModule.ingest({
      scope: resolved.scope,
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text: ['# 总体结构', '', `${ZH_BODY}（编号 ${marker}）`, ''].join('\n'),
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.ok(result.documentId);
    await postPublish.postPublishSettledForTests();
    return result.documentId;
  };

  const zhChunks = async (documentId: string) =>
    (
      await fixture.db.query<{ id: string; content: string }>(
        "SELECT id::text, content FROM document_chunks WHERE document_id = $1 AND is_current AND language = 'zh' AND chunk_kind = 'text' ORDER BY chunk_index",
        [documentId],
      )
    ).rows;

  const translationsOf = async (documentId: string) =>
    (await fixture.db.query<Row>('SELECT chunk_id::text, content, glossary_version FROM chunk_translations WHERE document_id = $1 ORDER BY chunk_id', [documentId])).rows;

  const gapsOf = async (documentId: string) =>
    (await fixture.db.query<Row>('SELECT chunk_id::text, reason FROM chunk_translation_gaps WHERE document_id = $1 ORDER BY chunk_id', [documentId])).rows;

  const termVersion = async (tenant: string): Promise<string> => {
    const { getTerminologyLexicon } = lexicon;
    const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
    const scoped = await backfillScope(tenant, { deploymentMode: 'multi-tenant', admin: supabaseModule.getSupabaseAdmin() as never });
    assert.ok(scoped.ok);
    return (await getTerminologyLexicon(scoped.scope, { kinds: ['translation'], includeTranslations: true })).version;
  };

  test('switch on: the target term is kept, the source surface is corrected once, a lost term is a gap and counted', async () => {
    const keep = await upload(TWO_TENANT_IDS.userA, 'glossary-keep.md', 'K-1');
    const fix = await upload(TWO_TENANT_IDS.userA, 'glossary-fix.md', 'F-1');
    const lose = await upload(TWO_TENANT_IDS.userA, 'glossary-lose.md', 'L-1');
    glossaryOn();
    withTranslation('on');
    const model = glossaryModel((text) => (text.includes('K-1') ? 'keep' : text.includes('F-1') ? 'fix' : 'lose'), TARGET_A);
    translator.setChunkTranslationModelForTests(model);
    const version = await termVersion(TENANT_A);

    const results = [];
    for (const documentId of [keep, fix, lose]) results.push(await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 }));
    for (const result of results) assert.ok(result.ok, JSON.stringify(result));

    for (const documentId of [keep, fix]) {
      const rows = await translationsOf(documentId);
      assert.equal(rows.length, (await zhChunks(documentId)).length);
      for (const row of rows) {
        assert.ok(String(row.content).includes(TARGET_A), 'the stored translation carries the target term');
        assert.ok(!String(row.content).includes(SOURCE_TERM), 'the source surface was replaced');
        assert.equal(row.glossary_version, version);
      }
    }
    assert.deepEqual(await translationsOf(lose), []);
    const gaps = await gapsOf(lose);
    assert.ok(gaps.length >= 1 && gaps.every((gap) => gap.reason === 'glossary_term_lost'), JSON.stringify(gaps));
    const lost = results[2]!;
    assert.ok(lost.ok);
    assert.equal(lost.glossaryRejected, gaps.length);
    assert.equal(lost.gaps, gaps.length);
    assert.equal(lost.remaining, 0, 'a rejected chunk is not pending again, so the job finishes');
    const withTerm = model.calls.filter((call) => call.text.includes(SOURCE_TERM));
    assert.ok(withTerm.length >= 3);
    for (const call of withTerm) assert.deepEqual(call.glossary.terms, [{ source: SOURCE_TERM, target: TARGET_A }]);
  });

  test("two tenants: tenant B's job gets only tenant B's pair", async () => {
    const documentId = await upload(TWO_TENANT_IDS.userB, 'glossary-b.md', 'B-1');
    glossaryOn();
    withTranslation('on');
    const model = glossaryModel(() => 'keep', TARGET_B);
    translator.setChunkTranslationModelForTests(model);
    const result = await produce.translateDocumentChunks(documentId, TENANT_B, { budgetMs: 30_000 });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(model.calls.length >= 1);
    for (const call of model.calls) {
      assert.ok(!JSON.stringify(call.glossary).includes(TARGET_A), "tenant A's pair never reaches tenant B's job");
      assert.deepEqual(call.glossary.terms, [{ source: SOURCE_TERM, target: TARGET_B }]);
    }
    const rows = await translationsOf(documentId);
    assert.ok(rows.length >= 1 && rows.every((row) => String(row.content).includes(TARGET_B)));
    assert.equal(rows[0]!.glossary_version, await termVersion(TENANT_B));
  });

  test('switch off: the producer output and stored rows are as before', async () => {
    const documentId = await upload(TWO_TENANT_IDS.userA, 'glossary-off.md', 'O-1');
    withTranslation('on');
    const model = glossaryModel(() => 'lose', TARGET_A);
    translator.setChunkTranslationModelForTests(model);
    const result = await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal('glossaryRejected' in result, false);
    const chunks = await zhChunks(documentId);
    const rows = await translationsOf(documentId);
    assert.equal(rows.length, chunks.length);
    for (const row of rows) {
      const source = chunks.find((chunk) => chunk.id === row.chunk_id)!;
      assert.equal(row.content, `[en] ${source.content.replace(SOURCE_TERM, 'unit')}`);
      assert.equal(row.glossary_version, 'none');
    }
    assert.deepEqual(await gapsOf(documentId), []);
    for (const call of model.calls) assert.deepEqual(call.glossary, { version: 'none', terms: [] });
  });
});
