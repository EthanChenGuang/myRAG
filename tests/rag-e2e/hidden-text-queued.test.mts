/**
 * SEC-07 on the queued path (plan 03.2-38, D-33, D-34): under tiered routing the real sidecar worker checks the original at preflight and
 * sends its report with the advance calls; the app's scan stage uses it and calls /v1/hidden-text no more. The document ends exactly as
 * the inline run of the same file does: spans removed, artifacts rewritten, quarantined with the same reason, hidden_text_check recorded.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import type { DocumentParser } from '@/lib/rag/ingest/parsers/shared';
import type { IngestEnvInput } from '@/lib/rag/ingest/config';

type Row = Record<string, unknown>;

const WHITE = 'white-on-white.pdf';
const CLEAN = 'clean-plain.pdf';
const PRESETS = ['fast', 'structured_layout', 'structured_full', 'structured_ocr'];
const TITLE = 'Relay Notes';
const BEFORE = 'The blue module joins the second relay after the amber light turns steady and the counter reads twelve.';
const AFTER = 'The panel stays closed during the night cycle and opens again at the first bell.';

/** The lines a parser reads from the page: the visible paragraphs and, for the white PDF, the hidden sentence like any other text. */
function pageLines(hidden: string | null): string[] {
  return [BEFORE, ...(hidden ? [hidden] : []), AFTER];
}

/** A one-page Docling recording of those lines, in the shape of eval/fixtures/parse/recorded. */
function recording(name: string, hidden: string | null): string {
  const lines = [TITLE, ...pageLines(hidden)];
  const texts = lines.map((text, index) => ({
    children: [],
    content_layer: 'body',
    label: index === 0 ? 'section_header' : 'text',
    ...(index === 0 ? { level: 1 } : {}),
    orig: text,
    parent: { $ref: '#/body' },
    prov: [{ bbox: { b: 86 + index * 30, coord_origin: 'TOPLEFT', l: 56.7, r: 538.58, t: 60 + index * 30 }, charspan: [0, text.length], page_no: 1 }],
    self_ref: `#/texts/${index}`,
    text,
  }));
  return JSON.stringify({
    body: { children: texts.map((_, index) => ({ $ref: `#/texts/${index}` })), content_layer: 'body', label: 'unspecified', name: '_root_', self_ref: '#/body' },
    form_items: [],
    furniture: { children: [], content_layer: 'furniture', label: 'unspecified', name: '_root_', self_ref: '#/furniture' },
    groups: [],
    key_value_items: [],
    name,
    origin: { binary_hash: 1, filename: `${name}.pdf`, mimetype: 'application/pdf' },
    pages: { '1': { page_no: 1, size: { height: 841.89, width: 595.28 } } },
    pictures: [],
    schema_name: 'DoclingDocument',
    tables: [],
    texts,
    version: '1.11.0',
  });
}

describe('hidden text on the queued path: the worker checks at preflight, the app uses the stored report (SEC-07)', () => {
  let harness: QueuedHarness;
  let recordedDir: string;
  let m: {
    enqueue: typeof import('@/lib/rag/ingest/enqueue');
    ingest: typeof import('@/lib/rag/ingest');
    deps: typeof import('@/lib/rag/ingest/deps');
    config: typeof import('@/lib/rag/ingest/config');
    objectStore: typeof import('@/lib/rag/ingest/object-store');
    hiddenText: typeof import('@/lib/rag/security/hidden-text');
    fakeSidecar: typeof import('../helpers/fake-sidecar');
    llama: typeof import('@/lib/rag/ingest/parsers/llamaparse-v2');
    docling: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
    contracts: typeof import('@/lib/rag-eval/contracts.generated');
  };
  const signal = () => new AbortController().signal;
  const normalized = (text: unknown) => String(text ?? '').replace(/\s/g, '');
  const sentence = () => String(m.fakeSidecar.securityPdfEntry(WHITE).hidden_text);

  /** Inline stand-in for the parsers: the same lines as the worker's recordings. */
  function linesParser(name: 'llamaparse' | 'docling', hidden: string | null): DocumentParser {
    return {
      name,
      unavailableReason: () => null,
      async parse() {
        const markdown = [`# ${TITLE}`, '', ...pageLines(hidden).flatMap((line) => [line, '']), ''].join('\n');
        const chunkText = pageLines(hidden).join(' ');
        return {
          kind: 'done',
          result: {
            markdown,
            chunks: [{ text: chunkText, contextualized_text: `${TITLE}\n${chunkText}`, headings: [TITLE], is_table: false, pages: [1], table_header: null }],
            pictures: [],
            page_count: 1,
            language: 'en',
            parser: name,
            parser_version: `${name}-test`,
            partial: false,
            text_layer_page_share: null,
            warnings: [],
          },
          artifacts: [],
          warnings: [],
        };
      },
    };
  }

  before(async () => {
    harness = await startQueuedHarness({ env: { RAG_PARSE_ROUTING: 'tiered', RAG_HIDDEN_TEXT_CHECK: 'quarantine' } });
    m = {
      enqueue: await import('@/lib/rag/ingest/enqueue'),
      ingest: await import('@/lib/rag/ingest'),
      deps: await import('@/lib/rag/ingest/deps'),
      config: await import('@/lib/rag/ingest/config'),
      objectStore: await import('@/lib/rag/ingest/object-store'),
      hiddenText: await import('@/lib/rag/security/hidden-text'),
      fakeSidecar: await import('../helpers/fake-sidecar'),
      llama: await import('@/lib/rag/ingest/parsers/llamaparse-v2'),
      docling: await import('@/lib/rag/ingest/parsers/sidecar-docling'),
      contracts: await import('@/lib/rag-eval/contracts.generated'),
    };
    // The worker reads the original and writes its cache objects over HTTP: the app uses the same storage, the fake edge's.
    m.objectStore.resetObjectStoreForTests();
    const ingestEnv = m.deps.getIngestDeps().ingestEnv();
    m.deps.setIngestDepsForTests({ ingestEnv: (): IngestEnvInput => ({ ...ingestEnv, RAG_HIDDEN_TEXT_CHECK: 'quarantine' }) });
    m.config.resetIngestConfigForTests();
    const sidecar = harness.fakes.sidecar;
    m.hiddenText.setHiddenTextClientForTests(m.hiddenText.createHiddenTextClient({ baseUrl: sidecar.url, secret: sidecar.secret }));

    recordedDir = mkdtempSync(path.join(os.tmpdir(), 'hidden-text-queued-recorded-'));
    for (const [fixture, hidden] of [[WHITE, sentence()], [CLEAN, null]] as const) {
      const sha = m.fakeSidecar.securityPdfEntry(fixture).sha256;
      for (const preset of PRESETS) {
        mkdirSync(path.join(recordedDir, sha, preset), { recursive: true });
        writeFileSync(path.join(recordedDir, sha, preset, 'page-1.json'), recording(fixture.replace('.pdf', ''), hidden));
      }
    }
  });

  after(async () => {
    m?.hiddenText.resetHiddenTextClientForTests();
    if (recordedDir) rmSync(recordedDir, { recursive: true, force: true });
    await harness?.close();
  });

  async function queuedRun(fixture: string) {
    const queued = await m.enqueue.enqueueIngest({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: `root/queued-${fixture}`,
      file: m.fakeSidecar.securityPdfBytes(fixture),
      filename: fixture,
      mimeType: 'application/pdf',
      docType: 'general',
      signal: signal(),
    });
    assert.equal(queued.status, 'queued');
    const [job] = await harness.rows('SELECT settings FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.equal((job?.settings as Row).routing, 'tiered');
    assert.equal((job?.settings as Row).hidden_text_check, 'quarantine', 'the snapshot asks the worker for the check');
    const before = harness.fakes.sidecar.hiddenTextRequests.length;
    const worker = await harness.runWorker(String(queued.jobId), { RAG_INGEST_CONVERTER: 'recorded', RAG_INGEST_RECORDED_DIR: recordedDir });
    assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-1000)} stderr: ${worker.stderr.slice(-3000)}`);
    assert.ok(!worker.stdout.includes(sentence()) && !worker.stderr.includes(sentence()), 'the worker never logs the hidden sentence');
    const summary = JSON.parse(worker.stdout.trim().split('\n').at(-1) ?? '{}') as Row;
    return { jobId: String(queued.jobId), documentId: String(queued.documentId), summary, sidecarCalls: harness.fakes.sidecar.hiddenTextRequests.length - before };
  }

  async function inlineRun(fixture: string, hidden: string | null) {
    m.llama.setLlamaParseParserForTests(linesParser('llamaparse', hidden));
    m.docling.setSidecarParserForTests(linesParser('docling', hidden));
    const before = harness.fakes.sidecar.hiddenTextRequests.length;
    try {
      const result = await m.ingest.ingest({
        scope: harness.scopeB,
        source: 'config_upload',
        sourceKey: `root/inline-${fixture}`,
        file: m.fakeSidecar.securityPdfBytes(fixture),
        filename: fixture,
        mimeType: 'application/pdf',
        docType: 'general',
        signal: signal(),
      });
      return { ...result, documentId: String(result.documentId), sidecarCalls: harness.fakes.sidecar.hiddenTextRequests.length - before };
    } finally {
      m.llama.resetLlamaParseParserForTests();
      m.docling.resetSidecarParserForTests();
    }
  }

  const documentOf = async (documentId: string) =>
    (await harness.rows('SELECT status, hidden_text_check, metadata, content, lineage_id, version, tenant_key FROM documents WHERE id = $1', [documentId]))[0] as Row;
  const reasonsOf = async (documentId: string) =>
    ((((await documentOf(documentId)).metadata as Row).quarantine as Row).reasons as Row[]).map((reason) => m.contracts.QuarantineReasonSchema.parse(reason));
  const storedText = async (row: Row, name: string) => {
    const found = await m.objectStore.getObjectStore().get(`${row.tenant_key}/${row.lineage_id}/${row.version}/${name}`, { signal: signal() });
    return found ? new TextDecoder().decode(found.bytes) : null;
  };

  async function assertSanitized(documentId: string) {
    const needle = normalized(sentence());
    const document = await documentOf(documentId);
    const chunks = await harness.rows('SELECT content, lexical_text FROM document_chunks WHERE document_id = $1', [documentId]);
    assert.ok(chunks.length > 0, 'the document has chunks');
    for (const chunk of chunks) {
      assert.ok(!normalized(chunk.content).includes(needle), 'no chunk content holds the hidden sentence');
      assert.ok(!normalized(chunk.lexical_text).includes(needle), 'no lexical_text holds the hidden sentence');
    }
    assert.ok(!normalized(document.content).includes(needle), 'documents.content does not hold it');
    const parseMd = await storedText(document, 'parse.md');
    assert.ok(parseMd, 'parse.md is stored');
    assert.ok(!normalized(parseMd).includes(needle), 'parse.md holds the sanitized text');
    assert.match(parseMd, /panel stays closed/);
    const chunksJson = await storedText(document, 'chunks.json');
    if (chunksJson !== null) assert.ok(!normalized(chunksJson).includes(needle), 'chunks.json holds the sanitized chunks');
  }

  let inlineReasons: unknown;

  test('inline baseline: the white PDF is quarantined after one sidecar call', async () => {
    const inline = await inlineRun(WHITE, sentence());
    assert.equal(inline.status, 'quarantined');
    assert.equal(inline.sidecarCalls, 1);
    const document = await documentOf(inline.documentId);
    assert.equal(document.hidden_text_check, 'hidden_found');
    assert.equal((document.metadata as Row).hidden_text_sanitized, true);
    inlineReasons = await reasonsOf(inline.documentId);
    await assertSanitized(inline.documentId);
  });

  test('queued: the white PDF ends as the inline one did, from the report the worker stored, with no sidecar call by the app', async () => {
    assert.ok(inlineReasons, 'the inline baseline ran first');
    const run = await queuedRun(WHITE);
    assert.equal(run.summary.status, 'quarantined');
    assert.equal(run.sidecarCalls, 0, 'the app used the worker report and made no /v1/hidden-text call');

    const [job] = await harness.rows('SELECT status, error_class FROM ingestion_jobs WHERE id = $1', [run.jobId]);
    assert.equal(job?.status, 'quarantined');
    const document = await documentOf(run.documentId);
    assert.equal(document.status, 'quarantined');
    assert.equal(document.hidden_text_check, 'hidden_found');
    assert.equal((document.metadata as Row).hidden_text_sanitized, true);
    const reasons = await reasonsOf(run.documentId);
    assert.deepEqual(reasons, inlineReasons, 'the same reasons as the inline run');
    const reason = reasons[0];
    assert.ok(reason?.kind === 'hidden_text');
    assert.deepEqual(reason.spans, [{ page: 1, text: sentence(), reason: 'color_near_background' }]);
    assert.equal(reason.unlocated, 0);
    await assertSanitized(run.documentId);
  });

  test('queued: the clean PDF is ready and recorded clean, with no sidecar call by the app', async () => {
    const run = await queuedRun(CLEAN);
    assert.equal(run.summary.status, 'ready');
    assert.equal(run.sidecarCalls, 0);
    const document = await documentOf(run.documentId);
    assert.equal(document.status, 'ready');
    assert.equal(document.hidden_text_check, 'clean');
    assert.equal((document.metadata as Row).hidden_text_sanitized, undefined);
    assert.equal((document.metadata as Row).quarantine, undefined);
  });
});
