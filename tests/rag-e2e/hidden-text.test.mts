import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { FakeObjectStore } from '../helpers/fake-object-store';
import type { FakeSidecar } from '../helpers/fake-sidecar';
import type { DocumentParser, ParseRequest } from '@/lib/rag/ingest/parsers/shared';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

type Row = Record<string, unknown>;

const WHITE = 'white-on-white.pdf';
const CLEAN = 'clean-plain.pdf';
const PROFILE = 'p37';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What a parser makes of a PDF: visible text around the sentence the PDF hides, which every parser extracts like visible text. */
function parsedMarkdown(hidden: string | null, label: string): string {
  return [
    `# Relay Notes ${label}`,
    '',
    'The blue module joins the second relay after the amber light turns steady and the counter reads twelve.',
    '',
    ...(hidden ? [hidden, ''] : []),
    'The panel stays closed during the night cycle and opens again at the first bell.',
    '',
  ].join('\n');
}

describe('hidden text on the inline path: removal, quarantine, stored artifacts and every mode (SEC-07)', () => {
  let db: TwoTenantDatabase;
  let edge: FakeEdge;
  let sidecar: FakeSidecar;
  let store: FakeObjectStore;
  let m: {
    ingest: typeof import('@/lib/rag/ingest');
    admin: typeof import('@/lib/rag/ingest/quarantine-admin');
    change: typeof import('@/lib/rag/ingest/change-doc-type');
    deps: typeof import('@/lib/rag/ingest/deps');
    config: typeof import('@/lib/rag/ingest/config');
    objectStore: typeof import('@/lib/rag/ingest/object-store');
    fakeStore: typeof import('../helpers/fake-object-store');
    fakeSidecar: typeof import('../helpers/fake-sidecar');
    hiddenText: typeof import('@/lib/rag/security/hidden-text');
    llama: typeof import('@/lib/rag/ingest/parsers/llamaparse-v2');
    docling: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
    resolver: typeof import('@/lib/rag/tenant/resolve-chat');
    supabase: typeof import('@/lib/supabase');
    postPublish: typeof import('@/lib/rag/ingest/post-publish');
    rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
    scopes: typeof import('@/lib/rag/tenant/scope');
    contracts: typeof import('@/lib/rag-eval/contracts.generated');
  };
  let env: Record<string, string> = {};
  let embedded: string[] = [];
  let parseCalls: ParseRequest[] = [];
  let hiddenSentence: string | null = null;
  let counter = 0;

  const A = TWO_TENANT_IDS.userA;
  const B = TWO_TENANT_IDS.userB;
  const encoder = new TextEncoder();
  const signal = () => new AbortController().signal;
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.db.query<Row>(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => {
    const found = await rows(sql, params);
    assert.equal(found.length, 1, sql);
    return found[0] as Row;
  };

  /** Parser stand-in for LlamaParse and Docling: the markdown, Docling's own chunks and a docling.json, all holding the hidden sentence. */
  function recordingParser(name: 'llamaparse' | 'docling'): DocumentParser {
    return {
      name,
      unavailableReason: () => null,
      async parse(request) {
        parseCalls.push(request);
        counter += 1;
        const markdown = parsedMarkdown(hiddenSentence, `nr${counter}`);
        const chunkText = markdown.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#')).join(' ');
        return {
          kind: 'done',
          result: {
            markdown,
            chunks: [{ text: chunkText, contextualized_text: `Relay Notes\n${chunkText}`, headings: ['Relay Notes'], is_table: false, pages: [1], table_header: null }],
            pictures: [],
            page_count: 1,
            language: 'en',
            parser: name,
            parser_version: `${name}-test`,
            partial: false,
            text_layer_page_share: null,
            warnings: [],
          },
          artifacts: [{ name: 'docling.json', bytes: encoder.encode(JSON.stringify({ texts: [hiddenSentence ?? 'none'] })), contentType: 'application/json' }],
          warnings: [],
        };
      },
    };
  }

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-text-corpus-'));
    try {
      db = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: db.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    m = {
      ingest: await import('@/lib/rag/ingest'),
      admin: await import('@/lib/rag/ingest/quarantine-admin'),
      change: await import('@/lib/rag/ingest/change-doc-type'),
      deps: await import('@/lib/rag/ingest/deps'),
      config: await import('@/lib/rag/ingest/config'),
      objectStore: await import('@/lib/rag/ingest/object-store'),
      fakeStore: await import('../helpers/fake-object-store'),
      fakeSidecar: await import('../helpers/fake-sidecar'),
      hiddenText: await import('@/lib/rag/security/hidden-text'),
      llama: await import('@/lib/rag/ingest/parsers/llamaparse-v2'),
      docling: await import('@/lib/rag/ingest/parsers/sidecar-docling'),
      resolver: await import('@/lib/rag/tenant/resolve-chat'),
      supabase: await import('@/lib/supabase'),
      postPublish: await import('@/lib/rag/ingest/post-publish'),
      rechunk: await import('@/lib/rag/ingest/rechunk/run'),
      scopes: await import('@/lib/rag/tenant/scope'),
      contracts: await import('@/lib/rag-eval/contracts.generated'),
    };
    await db.db.query('INSERT INTO admin_users (id) VALUES ($1), ($2)', [A, B]);
    await db.db.exec(`
      INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
      VALUES ('${PROFILE}', 'general', 256, 'structure', 1024, 'building', '256/1024')
      ON CONFLICT DO NOTHING`);
    sidecar = await m.fakeSidecar.startFakeSidecar();
  });

  after(async () => {
    await sidecar?.close();
    await edge?.close();
    await db?.db.close();
  });

  beforeEach(async () => {
    // Every test uploads the corpus files again: earlier versions are deleted so the file-hash skip does not answer.
    await db.db.exec("UPDATE documents SET status = 'deleted', is_current = false WHERE status <> 'deleted'");
    env = { RAG_INGEST_PIPELINE: 'unified', RAG_HIDDEN_TEXT_CHECK: 'quarantine' };
    embedded = [];
    parseCalls = [];
    hiddenSentence = null;
    store = m.fakeStore.createFakeObjectStore();
    m.objectStore.setObjectStoreForTests(store);
    m.config.resetIngestConfigForTests();
    const realEmbed = m.deps.getIngestDeps().embedDocuments;
    m.deps.setIngestDepsForTests({
      ingestEnv: () => env,
      embedDocuments: async (texts, options) => {
        embedded.push(...texts);
        return realEmbed(texts, options);
      },
    });
    m.llama.setLlamaParseParserForTests(recordingParser('llamaparse'));
    m.docling.setSidecarParserForTests(recordingParser('docling'));
    m.hiddenText.setHiddenTextClientForTests(m.hiddenText.createHiddenTextClient({ baseUrl: sidecar.url, secret: sidecar.secret }));
    sidecar.hiddenTextRequests.length = 0;
  });

  afterEach(() => {
    m.hiddenText.resetHiddenTextClientForTests();
    m.llama.resetLlamaParseParserForTests();
    m.docling.resetSidecarParserForTests();
    m.objectStore.resetObjectStoreForTests();
    m.deps.resetIngestDepsForTests();
    m.config.resetIngestConfigForTests();
    m.postPublish.resetPostPublishHooksForTests();
  });

  const scopeOf = async (userId: string) => {
    const resolved = await m.resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: m.supabase.getSupabaseAdmin(),
      signal: signal(),
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  /** Uploads a corpus PDF; the parser output holds the fixture's hidden sentence, as a real parser's would. */
  const uploadPdf = async (fixture: string, options: { userId?: string; mimeType?: string; filename?: string } = {}) => {
    const entry = m.fakeSidecar.securityPdfEntry(fixture);
    hiddenSentence = entry.hidden_text;
    const result = await m.ingest.ingest({
      scope: await scopeOf(options.userId ?? A),
      source: 'config_upload',
      sourceKey: `root/${counter}-${fixture}`,
      file: m.fakeSidecar.securityPdfBytes(fixture),
      filename: options.filename ?? fixture,
      mimeType: options.mimeType ?? 'application/pdf',
      docType: 'general',
      signal: signal(),
    });
    assert.ok(result.documentId, `${fixture} has a document`);
    return { ...result, documentId: String(result.documentId) };
  };

  const documentOf = (documentId: string) => one('SELECT status, is_current, hidden_text_check, metadata, content, lineage_id, version, tenant_key FROM documents WHERE id = $1', [documentId]);
  const chunksOf = (documentId: string) => rows('SELECT content, lexical_text, status FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);
  const reasonsOf = async (documentId: string) => (((await documentOf(documentId)).metadata as Row).quarantine as Row).reasons as Row[];
  const storedText = (documentId: string, row: Row, name: string): string | null => {
    const key = `${row.tenant_key}/${row.lineage_id}/${row.version}/${name}`;
    const found = store.objects.get(key);
    return found ? new TextDecoder().decode(found.bytes) : null;
  };
  const normalized = (text: unknown) => String(text ?? '').replace(/\s/g, '');

  const assertAbsent = async (documentId: string, sentence: string) => {
    const needle = normalized(sentence);
    const chunks = await chunksOf(documentId);
    assert.ok(chunks.length > 0, 'the document has chunks');
    for (const chunk of chunks) {
      assert.ok(!normalized(chunk.content).includes(needle), 'no chunk content holds the hidden sentence');
      assert.ok(!normalized(chunk.lexical_text).includes(needle), 'no lexical_text holds the hidden sentence');
    }
    assert.ok(!normalized((await documentOf(documentId)).content).includes(needle), 'documents.content does not hold it');
  };

  test('quarantine: the white-on-white PDF is quarantined with the span as its reason and the sentence reaches no stored text', async () => {
    const entry = m.fakeSidecar.securityPdfEntry(WHITE);
    const result = await uploadPdf(WHITE);
    assert.equal(result.status, 'quarantined');
    const sentence = String(entry.hidden_text);

    const document = await documentOf(result.documentId);
    assert.equal(document.status, 'quarantined');
    assert.equal(document.hidden_text_check, 'hidden_found');
    assert.equal((document.metadata as Row).hidden_text_sanitized, true);
    const reasons = (await reasonsOf(result.documentId)).map((reason) => m.contracts.QuarantineReasonSchema.parse(reason));
    assert.deepEqual(reasons.map((reason) => reason.kind), ['hidden_text']);
    const reason = reasons[0];
    assert.ok(reason?.kind === 'hidden_text');
    assert.deepEqual(reason.spans, [{ page: 1, text: sentence, reason: 'color_near_background' }]);
    assert.equal(reason.unlocated, 0);
    assert.equal(reason.checker_version, m.fakeSidecar.FAKE_HIDDEN_TEXT_CHECKER_VERSION);

    await assertAbsent(result.documentId, sentence);
    assert.ok(embedded.length > 0, 'the chunks were embedded');
    assert.ok(embedded.every((text) => !normalized(text).includes(normalized(sentence))), 'no embedding text holds the sentence');

    const parseMd = storedText(result.documentId, document, 'parse.md');
    const chunksJson = storedText(result.documentId, document, 'chunks.json');
    assert.ok(parseMd && chunksJson, 'parse.md and chunks.json are stored');
    assert.ok(!normalized(parseMd).includes(normalized(sentence)), 'parse.md was overwritten with the sanitized text');
    assert.ok(!normalized(chunksJson).includes(normalized(sentence)), 'chunks.json was overwritten with the sanitized chunks');
    assert.match(parseMd, /panel stays closed/);

    assert.equal(sidecar.hiddenTextRequests.length, 1);
    const request = sidecar.hiddenTextRequests[0]?.request as Row;
    assert.deepEqual(Object.keys(request).sort(), ['filename', 'mime_type', 'sha256', 'size_bytes']);
    assert.equal(request.filename, 'original.pdf', 'the user filename never reaches the sidecar');
  });

  test('quarantine: the clean PDF is ready and recorded clean, with no marker', async () => {
    const result = await uploadPdf(CLEAN);
    assert.equal(result.status, 'ready');
    const document = await documentOf(result.documentId);
    assert.equal(document.hidden_text_check, 'clean');
    assert.equal((document.metadata as Row).hidden_text_sanitized, undefined);
    assert.equal((document.metadata as Row).quarantine, undefined);
  });

  test('after release, a re-chunk and a doc-type change the sentence is still absent, and docling.json is not reused', async () => {
    const sentence = String(m.fakeSidecar.securityPdfEntry(WHITE).hidden_text);
    const quarantined = await uploadPdf(WHITE, { userId: B });
    assert.equal(quarantined.status, 'quarantined');

    const released = await m.admin.releaseQuarantined({ documentId: quarantined.documentId, actorUserId: B, signal: signal() });
    assert.ok(released.ok, 'the release answers');
    const document = await documentOf(quarantined.documentId);
    assert.equal(document.status, 'ready');
    assert.ok((await chunksOf(quarantined.documentId)).every((chunk) => chunk.status === 'ready'));
    await assertAbsent(quarantined.documentId, sentence);

    embedded = [];
    const report = await m.rechunk.runRechunk({
      db: m.deps.getIngestDeps().db() as RpcClient,
      profileId: PROFILE,
      scopeFor: async (tenantKey) => (tenantKey === document.tenant_key ? m.scopes.mintScope('personal', B, null) : null),
    });
    assert.equal(report.reason, null);
    const children = await rows('SELECT content, lexical_text FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2', [quarantined.documentId, PROFILE]);
    assert.ok(children.length > 0, 'the profile build wrote children for the document');
    assert.ok(children.every((child) => !normalized(child.content).includes(normalized(sentence)) && !normalized(child.lexical_text).includes(normalized(sentence))));

    parseCalls = [];
    sidecar.hiddenTextRequests.length = 0;
    const changed = await m.change.changeDocumentType({ scope: await scopeOf(B), documentId: quarantined.documentId, docType: 'contract_legal', signal: signal() });
    assert.ok(changed.ok, JSON.stringify(changed));
    const next = String(changed.result.documentId);
    assert.notEqual(next, quarantined.documentId);
    assert.equal(parseCalls.length, 0, 'no parser ran: the sanitized parse output was reused');
    await assertAbsent(next, sentence);
    const nextRow = await documentOf(next);
    assert.equal(storedText(next, nextRow, 'docling.json'), null, 'the docling.json of a sanitized version is not carried over');
    assert.equal(nextRow.status, 'quarantined', 'the new version is checked again and quarantined');
    const nextReason = m.contracts.QuarantineReasonSchema.parse((await reasonsOf(next))[0]);
    assert.equal(nextReason.unlocated, 0, 'spans removed by the version before are not counted as unlocated');
  });

  test('a span the remover cannot locate is counted as unlocated and the document is still quarantined', async () => {
    sidecar.enqueueHiddenText({
      report: {
        status: 'hidden_found',
        spans: [{ page: 1, text: 'A sentence that the parser rendered in a different way.', reason: 'font_too_small', bbox: null }],
        link_targets: [],
        checker_version: m.fakeSidecar.FAKE_HIDDEN_TEXT_CHECKER_VERSION,
        dropped: 0,
      },
    });
    const result = await uploadPdf(CLEAN);
    assert.equal(result.status, 'quarantined');
    const reason = m.contracts.QuarantineReasonSchema.parse((await reasonsOf(result.documentId))[0]);
    assert.equal(reason.unlocated, 1);
    const listed = await m.admin.listQuarantine({ actorUserId: A, limit: 100, signal: signal() });
    assert.ok(listed.ok);
    const item = listed.items.find((entry) => entry.documentId === result.documentId);
    assert.equal(item?.unlocated, 1, 'the admin list shows the unlocated count');
    assert.equal(item?.hiddenTextCheck, 'hidden_found');
  });

  test('flag stores the report and hidden_text_check and changes nothing else', async () => {
    env = { RAG_INGEST_PIPELINE: 'unified', RAG_HIDDEN_TEXT_CHECK: 'flag' };
    const sentence = String(m.fakeSidecar.securityPdfEntry(WHITE).hidden_text);
    const result = await uploadPdf(WHITE);
    assert.equal(result.status, 'ready');
    const document = await documentOf(result.documentId);
    assert.equal(document.hidden_text_check, 'hidden_found');
    const report = m.contracts.HiddenTextReportSchema.parse((document.metadata as Row).hidden_text_report);
    assert.equal(report.status, 'hidden_found');
    assert.deepEqual(report.spans?.map((span) => span.text), [sentence]);
    assert.equal((document.metadata as Row).hidden_text_sanitized, undefined);
    assert.ok((await chunksOf(result.documentId)).some((chunk) => normalized(chunk.content).includes(normalized(sentence))), 'flag removes nothing');
  });

  test('off makes no sidecar call and writes no hidden_text_check', async () => {
    env = { RAG_INGEST_PIPELINE: 'unified' };
    const result = await uploadPdf(WHITE);
    assert.equal(result.status, 'ready');
    assert.equal(sidecar.hiddenTextRequests.length, 0);
    assert.equal((await documentOf(result.documentId)).hidden_text_check, null);
  });

  test('text-only connector content, scraper HTML, a presentation and a spreadsheet are not_checked, indexed and never clean', async () => {
    const text = await m.ingest.ingest({
      scope: await scopeOf(A),
      source: 'nango',
      sourceKey: 'drive/notes-1',
      text: '# Notes\n\nThe blue module joins the second relay after the amber light turns steady.\n',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      signal: signal(),
    });
    const html = await m.ingest.ingest({
      scope: await scopeOf(A),
      source: 'scraper',
      sourceKey: 'https://example.invalid/page',
      text: '# Page\n\nThe panel stays closed during the night cycle and opens again at the first bell.\n',
      filename: 'page.html',
      mimeType: 'text/html',
      signal: signal(),
    });
    const files = [];
    // The same bytes under two tenants, so the file-hash skip does not answer the second upload.
    for (const [mimeType, filename, userId] of [
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx', A],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx', B],
    ]) {
      files.push(await uploadPdf(CLEAN, { mimeType, filename, userId }));
    }
    for (const result of [text, html, ...files]) {
      assert.equal(result.status, 'ready', JSON.stringify(result));
      assert.equal((await documentOf(String(result.documentId))).hidden_text_check, 'not_checked');
    }
    assert.equal(sidecar.hiddenTextRequests.length, 0, 'formats without a checker are never sent');
  });

  test('a Word file the sidecar answers not_checked for is indexed as not_checked', async () => {
    sidecar.enqueueHiddenText({ report: { status: 'not_checked', spans: [], link_targets: [], checker_version: m.fakeSidecar.FAKE_HIDDEN_TEXT_CHECKER_VERSION, dropped: 0 } });
    const result = await uploadPdf(CLEAN, { mimeType: DOCX, filename: 'notes.docx' });
    assert.equal(result.status, 'ready');
    assert.equal((await documentOf(result.documentId)).hidden_text_check, 'not_checked');
    assert.equal(sidecar.hiddenTextRequests.length, 1);
  });

  test('under quarantine a 5xx or an invalid report fails the run retryably: nothing is published or written, and a retry quarantines', async () => {
    for (const spec of [{ status: 503, error: 'checker_unavailable' }, { report: { status: 'hidden_found', spans: [], checker_version: 'x', dropped: 0 } }]) {
      sidecar.enqueueHiddenText(spec);
      const failed = await uploadPdf(WHITE);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.reason, 'hidden_text_checker_unavailable');
      const document = await documentOf(failed.documentId);
      assert.equal(document.status, 'failed');
      assert.equal(document.is_current, false);
      assert.equal((await chunksOf(failed.documentId)).length, 0, 'no chunk was written');
    }
    const retried = await uploadPdf(WHITE);
    assert.equal(retried.status, 'quarantined', 'the same file goes through once the checker answers');
  });

  test('under flag the same failure records not_checked with a warning and continues', async () => {
    env = { RAG_INGEST_PIPELINE: 'unified', RAG_HIDDEN_TEXT_CHECK: 'flag' };
    sidecar.enqueueHiddenText({ status: 500, error: 'hidden_text_failed' });
    const result = await uploadPdf(WHITE);
    assert.equal(result.status, 'ready');
    assert.ok(result.warnings.includes('hidden_text_not_checked'));
    assert.equal((await documentOf(result.documentId)).hidden_text_check, 'not_checked');
  });

  test('two ingests of the same original give the same reasons in the same order', async () => {
    const first = await uploadPdf(WHITE, { userId: A });
    const second = await uploadPdf(WHITE, { userId: B });
    assert.equal(first.status, 'quarantined');
    assert.equal(second.status, 'quarantined');
    assert.deepEqual(await reasonsOf(second.documentId), await reasonsOf(first.documentId));
  });
});
