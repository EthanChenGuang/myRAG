import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;

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

const markdown = (variant: number) => ['# 总体结构', '', `${ZH_SECTION}（第${variant}版）`, '', '# Overview', '', EN_SECTION, '', '# 42', '', '| 12 | 34 |', '| --- | --- |', '| 56 | 78 |', ''].join('\n');

interface ChunkRow {
  id: string;
  content: string;
  language: string | null;
  language_confidence: number | null;
  metadata_language: string | null;
}

describe('per-chunk language through the unified pipeline (D-13, D-14, LANG-05)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');

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
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    configModule.resetIngestConfigForTests();
  });

  const withSwitch = (value: 'on' | 'off') => {
    const base = depsModule.getIngestDeps().ingestEnv;
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...base(), RAG_LANGUAGE_AWARE_INGEST: value }) });
  };

  let variant = 0;
  const upload = async (filename: string) => {
    variant += 1;
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: TWO_TENANT_IDS.userA }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    const result = await ingestModule.ingest({
      scope: resolved.scope,
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text: markdown(variant),
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
      await fixture.db.query<ChunkRow>(
        `SELECT id::text, content, language, language_confidence, metadata ->> 'language' AS metadata_language
         FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
        [documentId],
      )
    ).rows;

  const documentOf = async (documentId: string) =>
    (await fixture.db.query<{ language: string | null; languages: string[] }>('SELECT language, languages FROM documents WHERE id = $1', [documentId]))
      .rows[0]!;

  const pick = (rows: ChunkRow[], kind: 'zh' | 'en' | 'table') =>
    rows.find((row) =>
      kind === 'zh' ? row.content.includes('本节说明') : kind === 'en' ? row.content.includes('This section describes') : row.content.includes('| 56 | 78 |'),
    );

  test('switch off: chunks mirror the document language, no confidence, no und, empty language list', async () => {
    withSwitch('off');
    const documentId = await upload('mixed-off.md');
    const rows = await chunksOf(documentId);
    assert.ok(rows.length >= 3);
    const document = await documentOf(documentId);
    assert.equal(document.language, 'zh');
    assert.deepEqual(document.languages, []);
    for (const row of rows) {
      assert.equal(row.language, 'zh');
      assert.equal(row.metadata_language, 'zh');
      assert.equal(row.language_confidence, null);
    }
    const und = await fixture.db.query('SELECT 1 FROM document_chunks WHERE language = $1', ['und']);
    assert.equal(und.rows.length, 0);
  });

  test('switch on: zh, en and und chunks with confidences; the document is zh with languages [zh, en]', async () => {
    withSwitch('on');
    const documentId = await upload('mixed-on.md');
    const rows = await chunksOf(documentId);
    const zh = pick(rows, 'zh');
    const en = pick(rows, 'en');
    const table = pick(rows, 'table');
    assert.ok(zh && en && table, JSON.stringify(rows.map((row) => row.content.slice(0, 30))));
    assert.equal(zh.language, 'zh');
    assert.equal(en.language, 'en');
    assert.equal(table.language, 'und');
    assert.equal(table.metadata_language, 'und');
    for (const row of [zh, en, table]) {
      assert.ok(row.language_confidence !== null && row.language_confidence >= 0 && row.language_confidence <= 1, String(row.language_confidence));
    }
    assert.equal(table.language_confidence, 0);
    const document = await documentOf(documentId);
    assert.equal(document.language, 'zh');
    assert.deepEqual(document.languages, ['zh', 'en']);

    // D-14 (plan 13): the und chunk matches a zh filter through its document, and not an it filter.
    const search = async (languages: string[]) =>
      new Set(
        (
          await fixture.db.query<{ chunk_id: string }>(
            `SELECT chunk_id::text FROM hybrid_search_chunks(
               p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
               p_dense_limit => 50, p_lexical_limit => 50, p_document_ids => $5::uuid[], p_languages => $6::text[]
             ) WHERE leg = 'dense'`,
            [TENANT_A, LEGACY, `[${embedText('table').join(',')}]`, ['table'], [documentId], languages],
          )
        ).rows.map((row) => row.chunk_id),
      );
    assert.ok((await search(['zh'])).has(table.id));
    assert.ok((await search(['zh'])).has(zh.id));
    assert.ok(!(await search(['zh'])).has(en.id));
    assert.ok((await search(['en'])).has(en.id));
    assert.ok(!(await search(['en'])).has(table.id));
    assert.equal((await search(['it'])).size, 0);

    const shares = (
      await fixture.db.query<{ language: string; docs: number }>('SELECT language, docs FROM public.rag_tenant_language_shares($1)', [TENANT_A])
    ).rows;
    assert.ok(shares.some((row) => row.language === 'zh' && Number(row.docs) >= 1));
    assert.ok(!shares.some((row) => row.language === 'und'));
  });

  test('rag_write_chunks refuses a chunk language that is not a language code', async () => {
    withSwitch('off');
    const documentId = await upload('mixed-refuse.md');
    await assert.rejects(
      fixture.db.query(
        `SELECT * FROM rag_write_chunks($1, $2, $3::jsonb, NULL, false, NULL)`,
        [documentId, TENANT_A, JSON.stringify([{ content: 'x', chunk_index: 900, language: 'Not A Code' }])],
      ),
      /invalid_chunk: language/,
    );
    await assert.rejects(
      fixture.db.query(`SELECT * FROM rag_write_chunks($1, $2, $3::jsonb, NULL, false, NULL)`, [
        documentId,
        TENANT_A,
        JSON.stringify([{ content: 'x', chunk_index: 901, language: 7 }]),
      ]),
      /invalid_chunk: language/,
    );
  });
});
