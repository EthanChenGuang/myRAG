import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { ChunkTranslationModel, ChunkTranslationRequest } from '@/lib/rag/ingest/translate/translator';

// Plan 03.2-49 (XLG-04, D-28, D-29, D-31): retrieval-only chunk translations produced after publish, through the unified pipeline on the
// fake edge, with a fixture translator fed from a translation table and the fixture embedder. Neutral synthetic sentences only.

const LEGACY = 'openai-3-small-1536';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const ADMIN = TWO_TENANT_IDS.userA;

const ZH_SECTION = [
  '本节说明系统的总体结构以及各个组成部分之间的关系。',
  '每个模块都有明确的职责，模块之间通过约定的接口交换数据。',
  '数据在进入系统之前会经过校验，校验失败的数据不会被保存。',
  '运行期间产生的记录按照时间顺序保存，便于之后查阅和比较。',
  '配置项集中保存在一个文件中，修改之后需要重新启动服务才能生效。',
  '当某个模块出现异常时，其余模块继续工作，异常信息会被单独记录。',
].join('');
const EN_SECTION =
  'This section describes the general structure of the system and the relation between its parts. Each module has a clear task and the modules exchange data through agreed interfaces. Records produced while the service runs are kept in time order, so that they can be read and compared later on.';

const markdown = (marker: string) =>
  ['# 总体结构', '', `${ZH_SECTION}（编号 ${marker}）`, '', '# Overview', '', EN_SECTION, '', '# 42', '', '| 12 | 34 |', '| --- | --- |', '| 56 | 78 |', ''].join('\n');

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

type Row = Record<string, unknown>;

interface Recorder extends ChunkTranslationModel {
  calls: ChunkTranslationRequest[];
}

/** A deterministic translator: the target language tag followed by the source text, so every protected token is kept. */
function taggingModel(options: { fail?: boolean } = {}): Recorder {
  const calls: ChunkTranslationRequest[] = [];
  return {
    model: 'fixture-translator',
    calls,
    async translate(request) {
      calls.push(request);
      if (options.fail) throw new Error('translator exploded');
      return { content: `[${request.targetLanguage}] ${request.text}` };
    },
  };
}

describe('chunk translation producer (plan 03.2-49, D-29)', () => {
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
  let lexical: typeof import('@/lib/rag/lexical/chunk-text');
  let languageSettings: typeof import('@/lib/rag/lang/settings');

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
    lexical = await import('@/lib/rag/lexical/chunk-text');
    languageSettings = await import('@/lib/rag/lang/settings');
    languageSettings.resetLanguageSettingsForTests();
    await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN]);
    await fixture.db.query('SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ADMIN, TENANT_A, ['en']]);
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
  });

  const withSwitches = (translation: 'on' | 'off') => {
    const base = depsModule.getIngestDeps().ingestEnv;
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...base(), RAG_LANGUAGE_AWARE_INGEST: 'on', RAG_DOC_TRANSLATION: translation }) });
  };

  const upload = async (userId: string, filename: string, marker: string) => {
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
      text: markdown(marker),
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.ok(result.documentId);
    return result.documentId;
  };

  const chunksOf = async (documentId: string) =>
    (
      await fixture.db.query<{ id: string; content: string; language: string; chunk_kind: string }>(
        'SELECT id::text, content, language, chunk_kind FROM document_chunks WHERE document_id = $1 AND is_current ORDER BY chunk_index',
        [documentId],
      )
    ).rows;

  const translationsOf = async (documentId: string) =>
    (
      await fixture.db.query<Row>(
        `SELECT t.id::text, t.chunk_id::text, t.tenant_key, t.language, t.content, t.lexical_text, t.source_content_hash, t.model,
                t.glossary_version, e.profile_id, e.dims, e.embedding_model
         FROM chunk_translations t LEFT JOIN chunk_translation_embeddings e ON e.translation_id = t.id
         WHERE t.document_id = $1 ORDER BY t.chunk_id, e.profile_id`,
        [documentId],
      )
    ).rows;

  test('switch on, tenant enabled for en: each eligible chunk gets one translation with lexical text, hash, model, glossary and a vector', async () => {
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const documentId = await upload(TWO_TENANT_IDS.userA, 'translate-on.md', 'A-1');
    await postPublish.postPublishSettledForTests();

    const chunks = await chunksOf(documentId);
    const zh = chunks.filter((chunk) => chunk.language === 'zh' && chunk.chunk_kind === 'text');
    assert.ok(zh.length >= 1, JSON.stringify(chunks.map((chunk) => [chunk.language, chunk.chunk_kind])));
    assert.ok(chunks.some((chunk) => chunk.language === 'en'), 'an en chunk is already in the target');
    assert.ok(chunks.some((chunk) => chunk.language === 'und'), 'the table chunk is und');

    const rows = await translationsOf(documentId);
    assert.deepEqual(rows.map((row) => row.chunk_id).sort(), zh.map((chunk) => chunk.id).sort(), 'only the zh text chunks are translated');
    for (const row of rows) {
      const source = zh.find((chunk) => chunk.id === row.chunk_id)!;
      assert.equal(row.language, 'en');
      assert.equal(row.tenant_key, TENANT_A);
      assert.equal(row.content, `[en] ${source.content}`);
      assert.equal(row.lexical_text, lexical.chunkLexicalText({ sectionPath: [], content: String(row.content), chunkKind: 'text' }));
      assert.equal(row.source_content_hash, sha256(source.content));
      assert.equal(row.model, 'fixture-translator');
      assert.equal(row.glossary_version, 'none');
      assert.equal(row.profile_id, LEGACY);
      assert.equal(Number(row.dims), 1536);
      assert.equal(row.embedding_model, 'text-embedding-3-small');
    }
    assert.ok(model.calls.every((call) => call.targetLanguage === 'en' && call.sourceLanguage === 'zh'));
    assert.equal(model.calls.length, zh.length);
  });

  test('captions, und chunks and chunks already in the target are skipped when the producer runs directly', async () => {
    withSwitches('off');
    const documentId = await upload(TWO_TENANT_IDS.userA, 'translate-skip.md', 'A-2');
    await fixture.db.query(
      `INSERT INTO document_chunks (document_id, content, tenant_key, language, is_current, status, chunk_kind, doc_type, chunk_index, metadata)
       SELECT $1, 'Una didascalia di prova per una figura.', $2, 'it', true, 'ready', 'image', doc_type, 900, '{"image_url":"https://example.invalid/a.png"}'::jsonb
       FROM documents WHERE id = $1`,
      [documentId, TENANT_A],
    );
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const result = await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 });
    assert.ok(result.ok, JSON.stringify(result));
    const chunks = await chunksOf(documentId);
    const translatedIds = new Set((await translationsOf(documentId)).map((row) => String(row.chunk_id)));
    for (const chunk of chunks) {
      const eligible = chunk.language === 'zh' && (chunk.chunk_kind === 'text' || chunk.chunk_kind === 'table');
      assert.equal(translatedIds.has(chunk.id), eligible, `${chunk.language}/${chunk.chunk_kind}`);
    }
    assert.ok(!model.calls.some((call) => call.text.includes('didascalia')), 'the caption never reaches the model');
    assert.equal(result.remaining, 0);
  });

  test('a tenant without the setting gets nothing and the model is never called for it, even with the switch on', async () => {
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const documentId = await upload(TWO_TENANT_IDS.userB, 'translate-b.md', 'B-1');
    await postPublish.postPublishSettledForTests();
    assert.equal((await translationsOf(documentId)).length, 0);
    assert.equal(model.calls.length, 0);
    const direct = await produce.translateDocumentChunks(documentId, TENANT_B, { budgetMs: 30_000 });
    assert.deepEqual(direct, { ok: false, reason: 'tenant_disabled' });
    assert.equal(model.calls.length, 0);
    const pending = await produce.translatePending(TENANT_B, { budgetMs: 30_000 });
    assert.deepEqual(pending, { ok: false, reason: 'tenant_disabled' });
    assert.equal(model.calls.length, 0);
  });

  test('switch off: no hook runs, nothing is translated and no model is called', async () => {
    withSwitches('off');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const documentId = await upload(TWO_TENANT_IDS.userA, 'translate-off.md', 'A-3');
    await postPublish.postPublishSettledForTests();
    assert.equal((await translationsOf(documentId)).length, 0);
    assert.equal(model.calls.length, 0);
    assert.deepEqual(await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 }), { ok: false, reason: 'switch_off' });
    assert.equal(model.calls.length, 0);
  });

  test('a failing translator never affects the ingest result', async () => {
    withSwitches('on');
    const model = taggingModel({ fail: true });
    translator.setChunkTranslationModelForTests(model);
    const documentId = await upload(TWO_TENANT_IDS.userA, 'translate-fail.md', 'A-4');
    await postPublish.postPublishSettledForTests();
    const document = (await fixture.db.query<Row>('SELECT status, is_current FROM documents WHERE id = $1', [documentId])).rows[0];
    assert.equal(document?.status, 'ready');
    assert.equal(document?.is_current, true);
    assert.ok(model.calls.length >= 1, 'the translator was tried');
    assert.equal((await translationsOf(documentId)).length, 0);
  });
});
