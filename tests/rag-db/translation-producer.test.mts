import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { ChunkTranslationModel, ChunkTranslationRequest } from '@/lib/rag/ingest/translate/translator';
import { embedText } from '../../eval/harness/fixture-embedder.mts';

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
function taggingModel(options: { fail?: boolean; delayMs?: number } = {}): Recorder {
  const calls: ChunkTranslationRequest[] = [];
  return {
    model: 'fixture-translator',
    calls,
    async translate(request) {
      calls.push(request);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
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
  let activeProfileModule: typeof import('@/lib/rag/embeddings/active-profile');
  let registryModule: typeof import('@/lib/rag/embeddings/registry');
  let tokensModule: typeof import('@/lib/rag/ingest/text/tokens');

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
    activeProfileModule = await import('@/lib/rag/embeddings/active-profile');
    registryModule = await import('@/lib/rag/embeddings/registry');
    tokensModule = await import('@/lib/rag/ingest/text/tokens');
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

  const withSwitches = (translation: 'on' | 'off', extra: Record<string, string> = {}) => {
    depsModule.resetIngestDepsForTests();
    const base = depsModule.getIngestDeps().ingestEnv;
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...base(), RAG_LANGUAGE_AWARE_INGEST: 'on', RAG_DOC_TRANSLATION: translation, ...extra }) });
  };

  const upload = async (userId: string, filename: string, marker: string, text?: string) => {
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
      text: text ?? markdown(marker),
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

  // --- Task 2: limits, staleness and re-translation ---------------------------------------------------------------------------------

  const zhChunkOf = async (documentId: string) => {
    const zh = (await chunksOf(documentId)).find((chunk) => chunk.language === 'zh' && chunk.chunk_kind === 'text');
    assert.ok(zh, 'the document has a zh text chunk');
    return zh;
  };

  const gapsOf = async (documentId: string) =>
    (await fixture.db.query<Row>('SELECT chunk_id::text, language, reason, source_content_hash, model FROM chunk_translation_gaps WHERE document_id = $1', [documentId]))
      .rows;

  test('a chunk exactly at the input limit is translated; one token over is a too_long gap, never cut and never sent', async () => {
    withSwitches('off');
    const atLimit = await upload(TWO_TENANT_IDS.userA, 'limit-at.md', 'L-1');
    const overLimit = await upload(TWO_TENANT_IDS.userA, 'limit-over.md', 'L-2');
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);

    const at = await zhChunkOf(atLimit);
    const limit = tokensModule.countTokens(at.content);
    const first = await produce.translateDocumentChunks(atLimit, TENANT_A, { budgetMs: 30_000, maxInputTokens: limit });
    assert.ok(first.ok && first.translated === 1 && first.gaps === 0, JSON.stringify(first));
    assert.equal((await translationsOf(atLimit))[0]?.content, `[en] ${at.content}`);

    const over = await zhChunkOf(overLimit);
    const calls = model.calls.length;
    const second = await produce.translateDocumentChunks(overLimit, TENANT_A, {
      budgetMs: 30_000,
      maxInputTokens: tokensModule.countTokens(over.content) - 1,
    });
    assert.ok(second.ok && second.translated === 0 && second.gaps === 1 && second.remaining === 0, JSON.stringify(second));
    assert.equal(model.calls.length, calls, 'an over-long chunk is never sent');
    assert.equal((await translationsOf(overLimit)).length, 0);
    assert.deepEqual(
      (await gapsOf(overLimit)).map((gap) => [gap.chunk_id, gap.language, gap.reason, gap.source_content_hash]),
      [[over.id, 'en', 'too_long', sha256(over.content)]],
    );
    const again = await produce.translateDocumentChunks(overLimit, TENANT_A, { budgetMs: 30_000, maxInputTokens: 1 });
    assert.ok(again.ok && again.translated === 0 && again.gaps === 0, 'a recorded gap is not tried again for the same source');
  });

  test('a lost protected token is retried once and then recorded as a gap; nothing is stored for the chunk', async () => {
    withSwitches('off');
    const documentId = await upload(TWO_TENANT_IDS.userA, 'protected.md', 'P-1', '# Modulo\n\nIl modulo ABC-1234 elabora 25 kg di materiale entro il 2026-03-01 secondo la procedura interna del reparto di prova.\n');
    withSwitches('on');
    const calls: ChunkTranslationRequest[] = [];
    translator.setChunkTranslationModelForTests({
      model: 'fixture-translator',
      async translate(request) {
        calls.push(request);
        return { content: 'The module processes material according to the internal procedure.' };
      },
    });
    const result = await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 });
    assert.ok(result.ok, JSON.stringify(result));
    const eligible = (await chunksOf(documentId)).filter((chunk) => chunk.language === 'it');
    assert.ok(eligible.length >= 1);
    assert.equal(calls.length, 2 * eligible.length, 'one retry per chunk');
    assert.equal((await translationsOf(documentId)).length, 0);
    assert.ok((await gapsOf(documentId)).every((gap) => gap.reason === 'protected_token_lost'));
  });

  test('the inline run stops at its time budget, reports what remains, and the next run translates only the rest', async () => {
    withSwitches('off');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await upload(TWO_TENANT_IDS.userA, `budget-${i}.md`, `T-${i}`));
    withSwitches('on');
    const model = taggingModel({ delayMs: 60 });
    translator.setChunkTranslationModelForTests(model);
    const pendingBefore = (await produce.estimateTranslation(TENANT_A)) as { ok: true; chunks: number };
    assert.ok(pendingBefore.ok && pendingBefore.chunks >= 4);
    const first = await produce.translatePending(TENANT_A, { budgetMs: 100, pageSize: 1 });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.stopped, 'time_budget');
    assert.ok(first.translated >= 1 && first.translated < pendingBefore.chunks, JSON.stringify(first));
    assert.equal(first.remaining, pendingBefore.chunks - first.translated);
    const callsAfterFirst = model.calls.length;
    const second = await produce.translatePending(TENANT_A, { budgetMs: 60_000 });
    assert.ok(second.ok && second.stopped === null && second.remaining === 0, JSON.stringify(second));
    assert.equal(second.translated, first.remaining);
    assert.equal(model.calls.length - callsAfterFirst, first.remaining, 'nothing translated twice');
  });

  test('changing one accent of the source makes its translation stale; the next run replaces it', async () => {
    withSwitches('off');
    const documentId = await upload(TWO_TENANT_IDS.userA, 'stale.md', 'S-1', '# Nota\n\nLa sezione descrive il caffè servito durante la riunione mensile del gruppo di lavoro tecnico.\n');
    withSwitches('on');
    translator.setChunkTranslationModelForTests(taggingModel());
    assert.ok((await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 })).ok);
    const [before] = await translationsOf(documentId);
    assert.ok(before);
    const source = (await chunksOf(documentId)).find((chunk) => chunk.id === before.chunk_id)!;
    const edited = source.content.replace('caffè', 'caffé');
    assert.notEqual(edited, source.content);
    await fixture.db.query('UPDATE document_chunks SET content = $2 WHERE id = $1', [source.id, edited]);
    assert.equal(await produce.translatePending(TENANT_A, { budgetMs: 0 }).then((r) => (r.ok ? r.remaining >= 1 : false)), true, 'the translation is stale');
    const rerun = await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 });
    assert.ok(rerun.ok && rerun.translated === 1 && rerun.remaining === 0, JSON.stringify(rerun));
    const [after] = await translationsOf(documentId);
    assert.equal(after?.id, before.id, 'the row is replaced in place');
    assert.equal(after?.content, `[en] ${edited}`);
    assert.equal(after?.source_content_hash, sha256(edited));
    assert.equal(after?.profile_id, LEGACY, 'the new text has a vector again');
  });

  test('a new version gets fresh translations; the old version keeps none in search and its translations go with its chunks', async () => {
    withSwitches('on');
    translator.setChunkTranslationModelForTests(taggingModel());
    const v1 = await upload(TWO_TENANT_IDS.userA, 'versioned.md', 'V-1');
    await postPublish.postPublishSettledForTests();
    assert.equal((await translationsOf(v1)).length, 1);
    const v2 = await upload(TWO_TENANT_IDS.userA, 'versioned.md', 'V-2');
    await postPublish.postPublishSettledForTests();
    assert.notEqual(v2, v1);
    const fresh = await translationsOf(v2);
    assert.equal(fresh.length, 1);
    assert.match(String(fresh[0]?.content), /V-2/);
    const oldCurrent = await fixture.db.query<Row>(
      'SELECT count(*)::int AS n FROM chunk_translations t JOIN document_chunks c ON c.id = t.chunk_id WHERE t.document_id = $1 AND c.is_current',
      [v1],
    );
    assert.equal(oldCurrent.rows[0]?.n, 0, 'the old version has no translation of a current chunk');
    await fixture.db.query('DELETE FROM document_chunks WHERE document_id = $1', [v1]);
    assert.equal((await translationsOf(v1)).length, 0);
  });

  test('after a global profile flip old vectors are not used and reembedOnly writes the new profile without calling the model', async () => {
    withSwitches('off');
    const documentId = await upload(TWO_TENANT_IDS.userA, 'flip.md', 'F-1');
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    assert.ok((await produce.translateDocumentChunks(documentId, TENANT_A, { budgetMs: 30_000 })).ok);
    const callsBefore = model.calls.length;

    const PROFILE = 'voyage-4-large-1024';
    const fakeVoyage = {
      id: 'voyage' as const,
      model: 'voyage-4-large',
      maxInputTokens: 32_000,
      supportedDims: [256, 512, 1024, 2048] as const,
      normalize: true,
      async embedDocuments(texts: string[], opts: { dims: number }) {
        return { vectors: texts.map((text) => embedText(text).slice(0, opts.dims)), model: 'voyage-4-large', host: 'fixture', usage: { tokens: 0 } };
      },
      async embedQuery(text: string, opts: { dims: number }) {
        return { vectors: [embedText(text).slice(0, opts.dims)], model: 'voyage-4-large', host: 'fixture', usage: { tokens: 0 } };
      },
    };
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeVoyage });
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE status = 'active'");
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [PROFILE]);
    activeProfileModule.resetActiveProfileForTests();
    try {
      withSwitches('on', { RAG_EMBEDDING_PROFILES: 'on' });
      const missing = async () =>
        (await fixture.db.query<Row>('SELECT * FROM rag_translation_vectors_missing($1, $2, NULL, 100)', [TENANT_A, PROFILE])).rows.length;
      assert.ok((await missing()) >= 1, 'the old translations lack a vector of the new profile');
      const result = await produce.translatePending(TENANT_A, { reembedOnly: true, budgetMs: 30_000 });
      assert.ok(result.ok && result.reembedded >= 1 && result.translated === 0, JSON.stringify(result));
      assert.equal(model.calls.length, callsBefore, 'the re-embed path never calls the translation model');
      assert.equal(await missing(), 0);
      const vectors = (await translationsOf(documentId)).filter((row) => row.profile_id === PROFILE);
      assert.equal(vectors.length, 1);
      assert.equal(Number(vectors[0]?.dims), 1024);
    } finally {
      await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [PROFILE]);
      await fixture.db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [LEGACY]);
      activeProfileModule.resetActiveProfileForTests();
      registryModule.resetEmbeddingProvidersForTests();
    }
  });

  test('0820 functions and the gap table are for the service role only, and the gap writer stays in its tenant', async () => {
    const functions = [
      'public.rag_translation_pending_scan(text, text, uuid, uuid, integer)',
      'public.rag_translation_pending_count(text, text, uuid)',
      'public.rag_translation_vectors_missing(text, text, uuid, integer)',
      'public.rag_record_translation_gaps(text, jsonb)',
      'public.rag_purge_hook_chunk_translation_gaps(text, uuid, uuid[])',
    ];
    for (const fn of functions) {
      const acl = await fixture.db.query<{ role: string; ok: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS ok FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)`,
        [fn],
      );
      assert.deepEqual(Object.fromEntries(acl.rows.map((row) => [row.role, row.ok])), { anon: false, authenticated: false, service_role: true }, fn);
    }
    const table = await fixture.db.query<{ role: string; ok: boolean }>(
      `SELECT r.role, has_table_privilege(r.role, 'public.chunk_translation_gaps', 'SELECT') AS ok FROM (VALUES ('anon'), ('authenticated')) AS r(role)`,
    );
    assert.ok(table.rows.every((row) => row.ok === false));
    const foreign = await fixture.db.query<{ id: string }>('SELECT id::text FROM document_chunks WHERE tenant_key = $1 LIMIT 1', [TENANT_B]);
    assert.ok(foreign.rows[0], 'tenant B has a chunk');
    await assert.rejects(
      fixture.db.query('SELECT rag_record_translation_gaps($1, $2::jsonb)', [
        TENANT_A,
        JSON.stringify([{ chunk_id: foreign.rows[0].id, language: 'en', source_content_hash: 'h', reason: 'too_long', model: 'm' }]),
      ]),
      /chunk_tenant_mismatch/,
    );
    await assert.rejects(
      fixture.db.query('SELECT * FROM rag_translation_pending_scan($1, $2, NULL, NULL, 10)', ['u:not-a-tenant', 'en']),
    );
  });
  // --- Task 3: npm run rag:translate --------------------------------------------------------------------------------------------------

  const runCli = async (argv: string[]) => {
    const cli = await import('@/lib/rag/ingest/translate/cli');
    const out: string[] = [];
    const err: string[] = [];
    const code = await cli.main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  const stored = async () =>
    Number((await fixture.db.query<Row>('SELECT (SELECT count(*) FROM chunk_translations) + (SELECT count(*) FROM chunk_translation_gaps) AS n')).rows[0]?.n);

  test('rag:translate --dry-run prints chunks per target and a 4-decimal cost from integer tokens, writes nothing, exits 2', async () => {
    withSwitches('off');
    await upload(TWO_TENANT_IDS.userA, 'cli-dry.md', 'C-1');
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const before = await stored();
    const estimate = await produce.estimateTranslation(TENANT_A);
    assert.ok(estimate.ok);
    const en = estimate.languages.find((entry) => entry.language === 'en')!;
    assert.ok(en.chunks >= 1 && Number.isInteger(en.inputTokens) && Number.isInteger(en.outputTokens));
    const expected = Math.round(((en.inputTokens * 0.1 + en.outputTokens * 0.4 + en.outputTokens * 0.02) / 1_000_000) * 10_000) / 10_000;
    assert.equal(en.estimatedUsd, expected);
    const result = await runCli(['--tenant', TENANT_A, '--dry-run']);
    assert.equal(result.code, 2, result.err);
    assert.match(result.out, new RegExp(`en: ${en.chunks} chunks, ${en.inputTokens} input tokens, ${en.outputTokens} output tokens, \\$${en.estimatedUsd.toFixed(4)}`));
    assert.match(result.out, /total: \d+ chunks, estimated \$\d+\.\d{4}/);
    assert.equal(await stored(), before, 'the dry run writes nothing');
    assert.equal(model.calls.length, 0, 'the dry run calls no model');
  });

  test('rag:translate without --budget stops after the report; with --budget it stops before exceeding it, --resume continues', async () => {
    withSwitches('off');
    for (let i = 0; i < 3; i += 1) await upload(TWO_TENANT_IDS.userA, `cli-budget-${i}.md`, `C-B${i}`);
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const before = await stored();
    const noBudget = await runCli(['--tenant', TENANT_A]);
    assert.equal(noBudget.code, 2, noBudget.err);
    assert.match(noBudget.out, /no --budget/);
    assert.equal(model.calls.length, 0);
    assert.equal(await stored(), before);

    const estimate = await produce.estimateTranslation(TENANT_A);
    assert.ok(estimate.ok && estimate.chunks >= 3);
    const zero = await runCli(['--tenant', TENANT_A, '--budget', '0']);
    assert.equal(zero.code, 3, zero.out + zero.err);
    assert.equal(model.calls.length, 0, 'a zero budget starts no chunk');
    assert.match(zero.out, new RegExp(`remaining ${estimate.chunks}`));

    const small = await runCli(['--tenant', TENANT_A, '--budget', '0.0001']);
    assert.ok(small.code === 3 || small.code === 0, small.out + small.err);
    const spent = /estimated \$(\d+\.\d{4})/.exec(small.out.split('\n').filter((line) => line.startsWith('[Translation] translated')).join('\n'));
    assert.ok(spent && Number(spent[1]) <= 0.0001, small.out);

    const resume = await runCli(['--tenant', TENANT_A, '--resume', '--budget', '5']);
    assert.equal(resume.code, 0, resume.out + resume.err);
    assert.match(resume.out, /remaining 0/);
    const done = await produce.estimateTranslation(TENANT_A);
    assert.ok(done.ok && done.chunks === 0);
  });

  test('rag:translate --reembed runs the re-embed path; a tenant without the setting and a switched-off deployment are refused', async () => {
    withSwitches('on');
    const model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    const reembed = await runCli(['--tenant', TENANT_A, '--reembed', '--budget', '1']);
    assert.equal(reembed.code, 0, reembed.out + reembed.err);
    assert.match(reembed.out, /re-embedded \d+ translations/);
    assert.equal(model.calls.length, 0);

    for (const argv of [['--tenant', TENANT_B, '--dry-run'], ['--tenant', TENANT_B, '--budget', '5'], ['--tenant', TENANT_B, '--reembed', '--budget', '5']]) {
      const refused = await runCli(argv);
      assert.equal(refused.code, 64, argv.join(' '));
      assert.match(refused.err, /has not enabled translation/);
    }
    assert.equal(model.calls.length, 0, 'tenant B text never reaches the model');

    withSwitches('off');
    for (const argv of [['--tenant', TENANT_A, '--dry-run'], ['--tenant', TENANT_A, '--budget', '5'], ['--tenant', TENANT_A, '--reembed', '--budget', '5']]) {
      const off = await runCli(argv);
      assert.equal(off.code, 64, argv.join(' '));
      assert.match(off.err, /RAG_DOC_TRANSLATION=off/);
    }
    assert.equal(model.calls.length, 0);

    const usage = await runCli(['--tenant', 'not-a-key']);
    assert.equal(usage.code, 64);
  });
});
