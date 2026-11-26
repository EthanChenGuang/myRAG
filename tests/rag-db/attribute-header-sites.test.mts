import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

/**
 * TPL-05 (D-26, D-27, F-14), plan 03.3-17: the stored attribute header at every site that builds or rewrites embedding text and
 * lexical_text, over two tenants on the fake edge. Its own file: the suites of attribute-header.test.mts load the app environment before
 * the fake edge exists. Keys, templates and values are synthetic; the header markers prove absence from content and from the other tenant.
 */

type Row = Record<string, unknown>;

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await db.query(
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, in_header) VALUES ($1, 'alpha_code', 'code', true),
       ($1, 'beta_list', 'text_list', true), ($1, 'gamma_text', 'text', false) ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
}

describe('stored header in embedding text and lexical_text (two tenants, plan 03.3-17)', () => {
  const MARK_A = 'qxmarka';
  const MARK_B = 'qxmarkb';
  const PROFILE = 'hdr256';
  const HEADER_ENV = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_HEADER: 'true', RAG_EMBEDDING_PROFILES: 'off' };
  const OFF_ENV = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true', RAG_EMBEDDING_PROFILES: 'off' };
  const HEADERS_PATH = '/rest/v1/rpc/rag_attribute_headers';

  let fixture: import('../../eval/harness/two-tenant.mts').TwoTenantDatabase;
  let edge: import('../../eval/harness/fake-edge.mts').FakeEdge;
  let ids: typeof import('../../eval/harness/two-tenant.mts').TWO_TENANT_IDS;
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let activeModule: typeof import('@/lib/rag/embeddings/active-profile');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let headerModule: typeof import('@/lib/rag/ingest/attributes/header');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
  let embedded: string[] = [];
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const docs = { a: '', b: '', off: '' };
  const keyA = () => `u:${ids.userA}`;
  const keyB = () => `u:${ids.userB}`;

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const ingestDb = () => depsModule.getIngestDeps().db() as never;
  const headerCalls = () => edge.calls.filter((call) => call.path === HEADERS_PATH);
  const scopeFor = async (tenantKey: string) => {
    if (tenantKey === keyA()) return scopeModule.mintScope('personal', ids.userA, null);
    if (tenantKey === keyB()) return scopeModule.mintScope('personal', ids.userB, null);
    return null;
  };

  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => env,
      embedDocuments: async (texts) => {
        embedded.push(...texts);
        return texts.map((text, index) => Array.from({ length: 1536 }, (_, dim) => (dim === (text.length + index) % 1536 ? 1 : 0)));
      },
    });
    activeModule.resetActiveProfileForTests();
    headerModule.resetHeaderTemplateCacheForTests();
  };

  function body(label: string): string {
    return [
      `# Probe ${label}`,
      '',
      '## Part one',
      '',
      `The first neutral probe sentence of ${label} names a shape and a colour for the test.`,
      '',
      '## Part two',
      '',
      `The second neutral probe sentence of ${label} names a number and a direction for the test.`,
      '',
    ].join('\n');
  }

  async function upload(tenant: 'a' | 'b', label: string, attributes: Record<string, unknown>, text = body(label)): Promise<string> {
    const userId = tenant === 'a' ? ids.userA : ids.userB;
    const result = await ingestModule.ingest({
      scope: scopeModule.mintScope('personal', userId, null),
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text,
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      docType: 'contract_legal',
      attributes,
      signal: new AbortController().signal,
    } as Parameters<typeof ingestModule.ingest>[0]);
    assert.equal(result.status, 'ready', `${label} ingests: ${JSON.stringify({ status: result.status, reason: (result as { reason?: unknown }).reason ?? null })}`);
    return String(result.documentId);
  }

  const legacyChunks = (documentId: string) =>
    q(
      "SELECT id, content, lexical_text, attribute_header_stamp AS stamp, metadata FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'legacy' ORDER BY chunk_index",
      [documentId],
    );
  const profileChildren = (documentId: string) =>
    q('SELECT id, content, lexical_text, attribute_header_stamp AS stamp FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY chunk_index', [
      documentId,
      PROFILE,
    ]);
  const docStamp = async (documentId: string) => String((await q('SELECT attribute_header_stamp AS s FROM documents WHERE id = $1', [documentId]))[0]?.s);
  const resetProfile = () =>
    fixture.db.exec(`
      DELETE FROM chunking_build_gaps;
      DELETE FROM chunking_build_runs;
      DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE chunking_profile_id = '${PROFILE}');
      DELETE FROM document_chunks WHERE chunking_profile_id = '${PROFILE}';
      DELETE FROM document_parents WHERE chunking_profile_id = '${PROFILE}';
      UPDATE chunking_profiles SET status = 'building' WHERE id = '${PROFILE}';
    `);

  before(async () => {
    const twoTenant = await import('../../eval/harness/two-tenant.mts');
    const { fixtureProcessEnv, startFakeEdge } = await import('../../eval/harness/fake-edge.mts');
    ids = twoTenant.TWO_TENANT_IDS;
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'header-corpus-'));
    try {
      fixture = await twoTenant.createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => realFetch(input, init)) as typeof fetch;
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    activeModule = await import('@/lib/rag/embeddings/active-profile');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    headerModule = await import('@/lib/rag/ingest/attributes/header');
    ingestModule = await import('@/lib/rag/ingest');
    scopeModule = await import('@/lib/rag/tenant/scope');
    rechunk = await import('@/lib/rag/ingest/rechunk/run');
    objectStoreModule.setObjectStoreForTests((await import('../helpers/fake-object-store')).createFakeObjectStore());
    // The suite counts only its own documents: the fixture's seeded tenant documents are removed first.
    await fixture.db.exec('DELETE FROM document_chunks; DELETE FROM document_parents; DELETE FROM documents;');
    for (const key of [keyA(), keyB()]) await defineKeys(fixture.db, key);
    await q("INSERT INTO public.rag_attribute_header_templates (tenant_key, template, version) VALUES ($1, $2, 1), ($3, $4, 1)", [
      keyA(),
      `${MARK_A} {alpha_code}`,
      keyB(),
      `${MARK_B} {alpha_code}`,
    ]);
    await fixture.db.exec(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset) VALUES ('${PROFILE}', 'contract_legal', 256, 'structure', 1024, 'building', '256/1024') ON CONFLICT DO NOTHING`,
    );
    useEnv(HEADER_ENV);
    docs.a = await upload('a', 'hdr-a1', { alpha_code: 'K-1' });
    docs.b = await upload('b', 'hdr-b1', { alpha_code: 'K-2' });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    objectStoreModule?.resetObjectStoreForTests();
    depsModule?.resetIngestDepsForTests();
    headerModule?.resetHeaderTemplateCacheForTests();
    await edge?.close();
    await fixture?.db.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  beforeEach(() => {
    embedded = [];
    edge.calls.length = 0;
    useEnv(HEADER_ENV);
  });

  test('inline ingest: every chunk carries its own tenant header in lexical_text, never in content, and the document stamp in its column', async () => {
    for (const [documentId, own, other] of [
      [docs.a, MARK_A, MARK_B],
      [docs.b, MARK_B, MARK_A],
    ] as const) {
      const stamp = await docStamp(documentId);
      assert.match(stamp, /^t1\.[0-9a-f]{12}$/);
      const chunks = await legacyChunks(documentId);
      assert.ok(chunks.length > 0);
      for (const chunk of chunks) {
        assert.ok(String(chunk.lexical_text).includes(own), 'own header in lexical_text');
        assert.ok(!String(chunk.lexical_text).includes(other), 'never the other tenant header');
        assert.ok(!String(chunk.content).includes(own), 'header never in content');
        assert.equal(chunk.stamp, stamp);
      }
    }
  });

  test('re-chunk over both tenants: one batched read per tenant and page, each child carries its own tenant header and stamp', async () => {
    await resetProfile();
    const report = await rechunk.runRechunk({ db: ingestDb(), profileId: PROFILE, scopeFor });
    assert.equal(report.documentsWritten, 2);
    const reads = headerCalls();
    assert.equal(reads.length, 2, 'one read per tenant key of the page');
    for (const [documentId, own, other] of [
      [docs.a, MARK_A, MARK_B],
      [docs.b, MARK_B, MARK_A],
    ] as const) {
      const stamp = await docStamp(documentId);
      const children = await profileChildren(documentId);
      assert.ok(children.length > 0);
      for (const child of children) {
        assert.ok(String(child.lexical_text).includes(own));
        assert.ok(!String(child.lexical_text).includes(other));
        assert.ok(!String(child.content).includes(own));
        assert.equal(child.stamp, stamp);
      }
    }
    assert.ok(embedded.length > 0 && embedded.every((text) => text.includes(MARK_A) !== text.includes(MARK_B)), 'each embedded text holds exactly one tenant header');
  });

  /** Takes B's chunks out of step (its document stamp moves on) for the body of a test; A stays in step. */
  async function withBOutOfStep(run: () => Promise<void>): Promise<void> {
    const stamp = await docStamp(docs.b);
    await q('UPDATE documents SET attribute_header_stamp = $2 WHERE id = $1', [docs.b, 't9.aaaaaaaaaaaa']);
    try {
      await run();
    } finally {
      await q('UPDATE documents SET attribute_header_stamp = $2 WHERE id = $1', [docs.b, stamp]);
    }
  }

  /** Marks the document's legacy chunks stale for relex (column and metadata key, which a trigger keeps equal). */
  const markStale = (documentIds: string[]) =>
    q(
      `UPDATE document_chunks SET lexical_version = 0, lexical_text = 'stale', metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{lexical_version}', '0'::jsonb)
       WHERE document_id = ANY($1::uuid[]) AND chunking_profile_id = 'legacy'`,
      [documentIds],
    );

  const plainLexical = async (documentId: string, chunk: Row): Promise<string> => {
    const { chunkLexicalText } = await import('@/lib/rag/lexical/chunk-text');
    const meta = (await q('SELECT section_path, chunk_kind, d.filename FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1', [chunk.id]))[0] as Row;
    return chunkLexicalText({
      sectionPath: (meta.section_path as string[]) ?? [],
      content: String(chunk.content),
      chunkKind: String(meta.chunk_kind),
      metadata: chunk.metadata as Record<string, unknown>,
      documentFilename: String(meta.filename),
    });
  };

  test('relex: a chunk in step gets back exactly the lexical_text ingestion wrote; a chunk not in step gets today\'s text', async () => {
    const relex = await import('@/lib/rag/ingest/relex/run');
    const ingestedA = await legacyChunks(docs.a);
    const ingestedB = await legacyChunks(docs.b);
    await withBOutOfStep(async () => {
      await markStale([docs.a, docs.b]);
      edge.calls.length = 0;
      await relex.runRelex({ db: ingestDb(), attributeHeader: headerModule.attributeHeaderEnabled() });
      assert.ok(headerCalls().length >= 2, 'a read per tenant of the batch');
      const rebuiltA = await legacyChunks(docs.a);
      assert.deepEqual(rebuiltA.map((chunk) => chunk.lexical_text), ingestedA.map((chunk) => chunk.lexical_text), 'byte-equal to ingestion');
      const rebuiltB = await legacyChunks(docs.b);
      for (const chunk of rebuiltB) {
        assert.equal(chunk.lexical_text, await plainLexical(docs.b, chunk));
        assert.ok(!String(chunk.lexical_text).includes(MARK_B) && !String(chunk.lexical_text).includes(MARK_A));
        assert.equal(chunk.stamp, ingestedB[0]?.stamp, 'relex drops no stamp');
      }
    });
    const relexAgain = await import('@/lib/rag/ingest/relex/run');
    await markStale([docs.b]);
    await relexAgain.runRelex({ db: ingestDb(), attributeHeader: headerModule.attributeHeaderEnabled() });
    assert.deepEqual((await legacyChunks(docs.b)).map((chunk) => chunk.lexical_text), ingestedB.map((chunk) => chunk.lexical_text), 'back in step: header again');
  });

  test('relex, switch off: no header read', async () => {
    const relex = await import('@/lib/rag/ingest/relex/run');
    useEnv(OFF_ENV);
    const before = await legacyChunks(docs.a);
    await markStale([docs.a]);
    edge.calls.length = 0;
    await relex.runRelex({ db: ingestDb(), attributeHeader: headerModule.attributeHeaderEnabled() });
    assert.equal(headerCalls().length, 0);
    for (const chunk of await legacyChunks(docs.a)) assert.equal(chunk.lexical_text, await plainLexical(docs.a, chunk));
    useEnv(HEADER_ENV);
    await markStale([docs.a]);
    await relex.runRelex({ db: ingestDb(), attributeHeader: headerModule.attributeHeaderEnabled() });
    assert.deepEqual((await legacyChunks(docs.a)).map((chunk) => chunk.lexical_text), before.map((chunk) => chunk.lexical_text));
  });

  test('re-embed: a chunk in step is embedded with the text ingestion embedded; a chunk not in step with today\'s text', async () => {
    const reembed = await import('@/lib/rag/ingest/reembed/run');
    const registry = await import('@/lib/rag/embeddings/registry');
    const { buildEmbeddingText } = await import('@/lib/rag/ingest/text/embedding-text');
    const VOYAGE = 'voyage-4-large-2048';
    const model = String((await q('SELECT model FROM embedding_profiles WHERE id = $1', [VOYAGE]))[0]?.model);
    const seen: string[] = [];
    registry.setEmbeddingProvidersForTests({
      voyage: {
        id: 'voyage',
        model,
        maxInputTokens: 8000,
        supportedDims: [1024, 2048],
        normalize: true,
        async embedDocuments(texts, opts) {
          seen.push(...texts);
          return { vectors: texts.map((_, index) => Array.from({ length: opts.dims }, (_, dim) => (dim === index % opts.dims ? 1 : 0))), model, host: 'fake-host', usage: { tokens: texts.length } };
        },
        async embedQuery(_text, opts) {
          return { vectors: [Array.from({ length: opts.dims }, () => 0)], model, host: 'fake-host', usage: { tokens: 1 } };
        },
      },
    } as never);
    try {
      useEnv({ ...HEADER_ENV, RAG_EMBEDDING_PROFILES: 'on' });
      await withBOutOfStep(async () => {
        await q("DELETE FROM chunk_embeddings WHERE profile_id = $1", [VOYAGE]);
        await q('DELETE FROM embedding_backfill_gaps');
        await q('DELETE FROM embedding_backfill_runs');
        const report = await reembed.runReembed({ db: ingestDb(), profileId: VOYAGE, tenantKey: keyA(), batchSize: 8 });
        assert.equal(report.status, 'completed');
        const reportB = await reembed.runReembed({ db: ingestDb(), profileId: VOYAGE, tenantKey: keyB(), batchSize: 8 });
        assert.equal(reportB.status, 'completed');
      });
      const chunksA = await legacyChunks(docs.a);
      const sectionOf = async (id: unknown) => ((await q('SELECT section_path FROM document_chunks WHERE id = $1', [id]))[0]?.section_path as string[]) ?? [];
      for (const chunk of chunksA) {
        const expected = buildEmbeddingText({ section_path: await sectionOf(chunk.id), content: String(chunk.content), attribute_header: `${MARK_A} K-1` });
        assert.ok(seen.includes(expected), 'A chunk embedded with its header');
      }
      for (const chunk of await legacyChunks(docs.b)) {
        const expected = buildEmbeddingText({ section_path: await sectionOf(chunk.id), content: String(chunk.content) });
        assert.ok(seen.includes(expected), 'B chunk (not in step) embedded with today\'s text');
      }
      assert.ok(seen.every((text) => !text.includes(MARK_B)), 'no B header: B is out of step');
    } finally {
      registry.resetEmbeddingProvidersForTests();
      await q("DELETE FROM chunk_embeddings WHERE profile_id = 'voyage-4-large-2048'");
      await q('DELETE FROM embedding_backfill_gaps');
      await q('DELETE FROM embedding_backfill_runs');
    }
  });

  test('translation producer: the translation lexical_text carries the header of a chunk in step; translated content and its embedding input do not', async () => {
    const translator = await import('@/lib/rag/ingest/translate/translator');
    const produce = await import('@/lib/rag/ingest/translate/produce');
    const settings = await import('@/lib/rag/lang/settings');
    const { chunkLexicalText } = await import('@/lib/rag/lexical/chunk-text');
    settings.resetLanguageSettingsForTests();
    await q('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [ids.userA]);
    await q('SELECT rag_translation_settings_set($1, $2, $3::text[], true)', [ids.userA, keyA(), ['it']]);
    translator.setChunkTranslationModelForTests({ model: 'fixture-translator', translate: async (request) => ({ content: `[${request.targetLanguage}] ${request.text}` }) });
    try {
      useEnv({ ...HEADER_ENV, RAG_DOC_TRANSLATION: 'on' });
      const result = await produce.translateDocumentChunks(docs.a, keyA());
      assert.equal(result.ok, true, JSON.stringify(result));
      const translations = await q('SELECT chunk_id, content, lexical_text FROM chunk_translations WHERE document_id = $1', [docs.a]);
      assert.ok(translations.length > 0);
      for (const row of translations) {
        assert.ok(!String(row.content).includes(MARK_A));
        assert.equal(row.lexical_text, chunkLexicalText({ sectionPath: [], content: String(row.content), chunkKind: 'text', attributeHeader: `${MARK_A} K-1` }));
      }
      assert.ok(embedded.length > 0 && embedded.every((text) => !text.includes(MARK_A)), 'the translated content alone is embedded');
    } finally {
      translator.resetChunkTranslationModelForTests();
    }
  });

  test('the text sent to the model never holds the header: content, parents, the assembled context and citation quotes', async () => {
    useEnv(OFF_ENV);
    docs.off = await upload('b', 'hdr-a1-off', { alpha_code: 'K-1' }, body('hdr-a1'));
    useEnv(HEADER_ENV);
    const withHeader = await legacyChunks(docs.a);
    const without = await legacyChunks(docs.off);
    assert.deepEqual(withHeader.map((chunk) => chunk.content), without.map((chunk) => chunk.content), 'content byte-equal with the switch on and off');
    for (const chunk of without) {
      assert.equal(chunk.lexical_text, await plainLexical(docs.off, chunk), 'switch off: the builders of today');
      assert.ok(!Object.keys(chunk.metadata as Row).includes('attribute_header_stamp'));
      assert.equal(chunk.stamp, null);
    }

    await resetProfile();
    await rechunk.runRechunk({ db: ingestDb(), profileId: PROFILE, scopeFor });
    const parentsOf = (documentId: string) => q('SELECT content FROM document_parents WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY parent_index', [documentId, PROFILE]);
    const parentsA = await parentsOf(docs.a);
    assert.ok(parentsA.length > 0);
    assert.deepEqual(parentsA, await parentsOf(docs.off), 'parents byte-equal');

    const { assembleContext } = await import('@/lib/rag/context/assemble');
    const { createCitationLabeler, buildAliasMap } = await import('@/lib/rag/generation/citations/blocks');
    const { buildCitationRecords } = await import('@/lib/rag/generation/citations/record');
    const children = await profileChildren(docs.a);
    const assembled = assembleContext({
      queryText: 'first neutral probe sentence',
      candidates: [...withHeader, ...children].map((chunk, index) => ({ chunk_id: String(chunk.id), document_id: docs.a, content: String(chunk.content), similarity: 0.9 - index * 0.01 })),
      documents: new Map([[docs.a, { id: docs.a, filename: 'hdr-a1.md', created_at: '2026-01-01T00:00:00Z', content: null, metadata: null }]]),
      chunkMetadata: new Map(),
      referenced: null,
      isGPTModel: false,
      ragMode: 'strict',
      webSearchEnabled: false,
      applyRelevanceFilter: false,
      citationLabeler: createCitationLabeler(),
    });
    assert.ok(assembled.context.includes('first neutral probe sentence'));
    assert.ok(!assembled.context.includes(MARK_A), 'no header in the assembled context');
    const aliases = buildAliasMap(assembled.blocks, assembled.usedDocuments);
    const records = buildCitationRecords([...aliases.byAlias.keys()], aliases, 'chunk-alias');
    assert.ok(records.length > 0);
    for (const record of records) assert.ok(!record.quote.includes(MARK_A), 'no header in a citation quote');
  });

  test('rag:rebuild rechunk: a template change selects the stale documents and builds a side-by-side profile with the new header', async () => {
    const rebuild = await import('@/lib/rag/ingest/rebuild/run');
    const apply = await import('@/lib/rag/ingest/attributes/apply');
    const signal = new AbortController().signal;
    await q('UPDATE public.rag_attribute_header_templates SET template = $2, version = 2 WHERE tenant_key = $1', [keyA(), `${MARK_A} {alpha_code} v2`]);
    headerModule.resetHeaderTemplateCacheForTests();
    const rendered = await apply.renderPendingHeaders(ingestDb(), keyA(), { signal, deadlineMs: 20_000 });
    assert.equal(rendered.ok, true);
    const stampA = await docStamp(docs.a);
    assert.match(stampA, /^t2\./);
    const stampB = await docStamp(docs.b);

    const deps = { db: ingestDb(), scopeFor, ingestAsync: () => false };
    const dry = await rebuild.startRebuild({ mechanism: 'rechunk', dryRun: true, startedBy: null }, deps);
    assert.equal(dry.status, 'dry_run');
    assert.equal(dry.plan.kind, 'chunking_profile');
    // A's stale-header document only: B's documents keep their header state.
    assert.deepEqual(
      dry.plan.kind === 'chunking_profile' ? dry.plan.documents.map((document) => document.documentId).sort() : [],
      [docs.a],
    );

    const started = await rebuild.startRebuild({ mechanism: 'rechunk', startedBy: null }, deps);
    assert.equal(started.status, 'started');
    const profileId = started.plan.kind === 'chunking_profile' ? started.plan.profiles[0]!.profileId : '';
    assert.match(profileId, /^rb-[0-9a-f]{12}$/);
    const childrenIn = (documentId: string) =>
      q('SELECT content, lexical_text, attribute_header_stamp AS stamp FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2', [documentId, profileId]);
    for (const child of await childrenIn(docs.a)) {
      assert.ok(String(child.lexical_text).includes(MARK_A) && String(child.lexical_text).includes('v2'));
      assert.equal(child.stamp, stampA);
    }
    for (const child of await childrenIn(docs.b)) {
      assert.ok(String(child.lexical_text).includes(MARK_B) && !String(child.lexical_text).includes(MARK_A));
      assert.equal(child.stamp, stampB);
    }
    for (const child of await childrenIn(docs.off)) {
      assert.ok(!String(child.lexical_text).includes(MARK_A) && !String(child.lexical_text).includes(MARK_B));
      assert.equal(child.stamp, null);
    }

    const again = await rebuild.startRebuild({ mechanism: 'rechunk', startedBy: null }, deps);
    assert.equal(again.run?.id, started.run?.id, 'a second start in the same state finds the same run');

    await q("UPDATE chunking_profiles SET status = 'ready' WHERE id = 'legacy' AND doc_type = 'contract_legal'");
    await q("UPDATE chunking_profiles SET status = 'active' WHERE id = $1 AND doc_type = 'contract_legal'", [profileId]);
    try {
      const listed = await headerModule.listStaleHeaderDocuments(keyA(), { signal, db: ingestDb() });
      assert.deepEqual(listed.ok ? listed.items : null, [], 'no stale document once the profile serves');
      const after = await rebuild.startRebuild({ mechanism: 'rechunk', startedBy: null }, deps);
      assert.equal(after.status, 'nothing');
    } finally {
      await q("UPDATE chunking_profiles SET status = 'retired' WHERE id = $1 AND doc_type = 'contract_legal'", [profileId]);
      await q("UPDATE chunking_profiles SET status = 'active' WHERE id = 'legacy' AND doc_type = 'contract_legal'");
    }
  });

  test('switch off: re-chunk makes no header read and writes texts and stamps equal to today', async () => {
    useEnv(OFF_ENV);
    await resetProfile();
    const report = await rechunk.runRechunk({ db: ingestDb(), profileId: PROFILE, scopeFor });
    assert.equal(report.documentsWritten, docs.off ? 3 : 2);
    assert.equal(headerCalls().length, 0);
    for (const documentId of [docs.a, docs.b, docs.off].filter(Boolean)) {
      for (const child of await profileChildren(documentId)) {
        assert.ok(!String(child.lexical_text).includes(MARK_A) && !String(child.lexical_text).includes(MARK_B));
        assert.equal(child.stamp, null);
      }
    }
    assert.ok(embedded.every((text) => !text.includes(MARK_A) && !text.includes(MARK_B)));
  });
});
