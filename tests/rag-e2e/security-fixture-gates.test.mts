/**
 * D-46: the security fixtures are absolute gates. Every hidden-text fixture (PDF, Word, zero-width text) and every link fixture is
 * ingested with RAG_HIDDEN_TEXT_CHECK=quarantine, RAG_INGEST_LINK_CHECK=quarantine and the one-entry allowlist of the link corpus, once
 * inline and once through the queue (the sidecar worker drives the job through the app's callbacks). Every bad fixture must be
 * quarantined with a reason of the expected kind and no chunk may keep its hidden text; every clean fixture must be ready. The case list
 * is built from the fixture folders: a file without a manifest entry, or a folder the gate does not know, fails the test.
 *
 * The sidecar answers from the manifests (tests/helpers/fake-sidecar.ts); rag-sidecar/tests/test_hidden_text*.py pin each manifest to
 * the real checker's answer.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import type { DocumentParser } from '@/lib/rag/ingest/parsers/shared';
import type { IngestEnvInput } from '@/lib/rag/ingest/config';
import type { TenantScope } from '@/lib/rag/tenant/scope';

type Row = Record<string, unknown>;
type ReasonKind = 'hidden_text' | 'untrusted_link';

const SECURITY_DIR = path.join(process.cwd(), 'eval', 'fixtures', 'security');
const FOLDERS = ['docx', 'links', 'pdf', 'text'] as const;
const ALLOWLIST = 'example.com';
const SITE_URL = 'https://app.myrag.example';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZERO_WIDTH = /[​‌‍⁠﻿]/u;
const VISIBLE = [
  'The blue module joins the second relay after the amber light turns steady and the counter reads twelve.',
  'The panel stays closed during the night cycle and opens again at the first bell.',
];

interface GateCase {
  folder: (typeof FOLDERS)[number];
  name: string;
  bytes: Uint8Array;
  mime: string;
  /** Reason kinds in the stored order; empty for a clean fixture. */
  kinds: ReasonKind[];
  /** The span reason the hidden_text reason must carry. */
  spanReason: string | null;
  /** Text no chunk may hold: the hidden sentence (PDF, Word) or null (zero-width text: no zero-width character may remain). */
  hiddenText: string | null;
  /** Expected untrusted_link targets, in the stored order. */
  targets: string[];
  /** What a parser extracts: the visible text and, for a hidden-text fixture, the hidden sentence; a text file's own text. */
  parsed: string;
}

function allowed(target: string): boolean {
  const host = (() => {
    try {
      return new URL(target).hostname.toLowerCase();
    } catch {
      return (target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target).toLowerCase();
    }
  })();
  return host === ALLOWLIST || host.endsWith(`.${ALLOWLIST}`);
}

function readManifest(folder: string): { allowlist?: string; fixtures: Record<string, Row> } {
  return JSON.parse(fs.readFileSync(path.join(SECURITY_DIR, folder, 'manifest.json'), 'utf8')) as { allowlist?: string; fixtures: Record<string, Row> };
}

/** The case list from the folders. Throws on a file without an entry, an entry without a file, a digest mismatch or an unknown folder. */
function buildCases(): GateCase[] {
  const folders = fs.readdirSync(SECURITY_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !/^[_.]/.test(entry.name)).map((entry) => entry.name).sort();
  assert.deepEqual(folders, [...FOLDERS], 'every security fixture folder has gate expectations');
  const cases: GateCase[] = [];
  for (const folder of FOLDERS) {
    const manifest = readManifest(folder);
    if (folder === 'links') assert.equal(manifest.allowlist, ALLOWLIST, 'the gate uses the link corpus allowlist');
    const files = fs.readdirSync(path.join(SECURITY_DIR, folder)).filter((name) => name !== 'manifest.json').sort();
    assert.deepEqual(files, Object.keys(manifest.fixtures).sort(), `${folder}: every fixture file has a manifest expectation and every expectation a file`);
    for (const name of files) {
      const entry = manifest.fixtures[name] as Row;
      const bytes = new Uint8Array(fs.readFileSync(path.join(SECURITY_DIR, folder, name)));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${folder}/${name} matches its manifest digest`);
      const kinds: ReasonKind[] = [];
      let targets: string[] = [];
      let spanReason: string | null = null;
      let hiddenText: string | null = null;
      let parsed = VISIBLE.join('\n\n');
      let mime = 'application/pdf';
      if (folder === 'pdf' || folder === 'docx') {
        mime = folder === 'pdf' ? 'application/pdf' : DOCX;
        assert.ok(entry.expected === 'clean' || entry.expected === 'hidden_found', `${folder}/${name} has an expected status`);
        if (entry.expected === 'hidden_found') {
          assert.equal(typeof entry.hidden_text, 'string', `${folder}/${name} names its hidden text`);
          assert.equal(typeof entry.reason, 'string', `${folder}/${name} names its reason`);
          kinds.push('hidden_text');
          spanReason = String(entry.reason);
          hiddenText = String(entry.hidden_text);
          parsed = [VISIBLE[0], hiddenText, VISIBLE[1]].join('\n\n');
        }
        targets = ((entry.link_targets as string[] | undefined) ?? []).filter((target) => !allowed(target));
      } else if (folder === 'links') {
        mime = String(entry.mime);
        assert.ok(entry.expected === 'quarantined' || entry.expected === 'ready', `${folder}/${name} has an expected status`);
        targets = ((entry.targets as Array<{ target: string }>) ?? []).map((target) => target.target);
        assert.equal(entry.expected === 'quarantined', targets.length > 0, `${folder}/${name}: quarantined exactly when it names targets`);
        if (mime === 'application/pdf') parsed = String(entry.visible_text ?? '');
      } else {
        mime = String(entry.mime);
        assert.ok(entry.expected === 'clean' || entry.expected === 'hidden_found', `${folder}/${name} has an expected status`);
        if (entry.expected === 'hidden_found') {
          kinds.push('hidden_text');
          spanReason = String(entry.reason);
        }
      }
      if (mime.startsWith('text/')) parsed = new TextDecoder().decode(bytes);
      if (targets.length > 0) kinds.push('untrusted_link');
      cases.push({ folder, name, bytes, mime, kinds, spanReason, hiddenText, targets, parsed });
    }
  }
  return cases;
}

const CASES = buildCases();

describe('the security fixture corpus is an absolute gate on the inline and the queued path (D-46, SEC-07, SEC-08)', () => {
  let harness: QueuedHarness;
  let m: {
    enqueue: typeof import('@/lib/rag/ingest/enqueue');
    ingest: typeof import('@/lib/rag/ingest');
    deps: typeof import('@/lib/rag/ingest/deps');
    config: typeof import('@/lib/rag/ingest/config');
    objectStore: typeof import('@/lib/rag/ingest/object-store');
    hiddenText: typeof import('@/lib/rag/security/hidden-text');
    llama: typeof import('@/lib/rag/ingest/parsers/llamaparse-v2');
    docling: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
    contracts: typeof import('@/lib/rag-eval/contracts.generated');
  };
  let current: GateCase | null = null;
  let env: IngestEnvInput = {};
  const signal = () => new AbortController().signal;

  /** Parser stand-in: what a parser extracts from the current fixture, the hidden sentence included like any visible text. */
  function fixtureParser(name: 'llamaparse' | 'docling'): DocumentParser {
    return {
      name,
      unavailableReason: () => null,
      async parse() {
        // A distinct title per fixture, so the content-hash dedup never answers for another fixture's text.
        const title = `Relay Notes ${current ? CASES.indexOf(current) + 1 : 0}`;
        const text = current?.parsed ?? '';
        const markdown = `# ${title}\n\n${text}\n`;
        return {
          kind: 'done',
          result: {
            markdown,
            chunks: [{ text, contextualized_text: `${title}\n${text}`, headings: [title], is_table: false, pages: [1], table_header: null }],
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
    harness = await startQueuedHarness({ env: { RAG_HIDDEN_TEXT_CHECK: 'quarantine', RAG_INGEST_LINK_CHECK: 'quarantine' } });
    m = {
      enqueue: await import('@/lib/rag/ingest/enqueue'),
      ingest: await import('@/lib/rag/ingest'),
      deps: await import('@/lib/rag/ingest/deps'),
      config: await import('@/lib/rag/ingest/config'),
      objectStore: await import('@/lib/rag/ingest/object-store'),
      hiddenText: await import('@/lib/rag/security/hidden-text'),
      llama: await import('@/lib/rag/ingest/parsers/llamaparse-v2'),
      docling: await import('@/lib/rag/ingest/parsers/sidecar-docling'),
      contracts: await import('@/lib/rag-eval/contracts.generated'),
    };
    m.objectStore.resetObjectStoreForTests();
    const base = m.deps.getIngestDeps().ingestEnv();
    env = {
      ...base,
      RAG_HIDDEN_TEXT_CHECK: 'quarantine',
      RAG_INGEST_LINK_CHECK: 'quarantine',
      RAG_OUTPUT_LINK_ALLOWLIST: ALLOWLIST,
      NEXT_PUBLIC_SITE_URL: SITE_URL,
    };
    m.deps.setIngestDepsForTests({ ingestEnv: (): IngestEnvInput => env });
    m.config.resetIngestConfigForTests();
    const sidecar = harness.fakes.sidecar;
    m.hiddenText.setHiddenTextClientForTests(m.hiddenText.createHiddenTextClient({ baseUrl: sidecar.url, secret: sidecar.secret }));
    m.llama.setLlamaParseParserForTests(fixtureParser('llamaparse'));
    m.docling.setSidecarParserForTests(fixtureParser('docling'));
  });

  after(async () => {
    m?.hiddenText.resetHiddenTextClientForTests();
    m?.docling.resetSidecarParserForTests();
    await harness?.close();
  });

  const documentOf = async (documentId: string) =>
    (await harness.rows('SELECT status, is_current, hidden_text_check, metadata FROM documents WHERE id = $1', [documentId]))[0] as Row;
  const chunksOf = (documentId: string) => harness.rows('SELECT content, lexical_text, status FROM document_chunks WHERE document_id = $1', [documentId]);
  const normalized = (text: unknown) => String(text ?? '').replace(/\s/g, '');

  async function inline(fixture: GateCase, scope: TenantScope): Promise<{ status: string; documentId: string }> {
    const result = await m.ingest.ingest({
      scope,
      source: 'config_upload',
      sourceKey: `gate/inline/${fixture.folder}/${fixture.name}`,
      file: fixture.bytes,
      filename: fixture.name,
      mimeType: fixture.mime,
      docType: 'general',
      signal: signal(),
    });
    assert.ok(result.documentId, `${fixture.name} has a document: ${JSON.stringify(result)}`);
    return { status: result.status, documentId: String(result.documentId) };
  }

  async function queued(fixture: GateCase, scope: TenantScope): Promise<{ status: string; documentId: string }> {
    const enqueued = await m.enqueue.enqueueIngest({
      scope,
      source: 'config_upload',
      sourceKey: `gate/queued/${fixture.folder}/${fixture.name}`,
      file: fixture.bytes,
      filename: fixture.name,
      mimeType: fixture.mime,
      docType: 'general',
      signal: signal(),
    });
    assert.equal(enqueued.status, 'queued', `${fixture.name} is queued`);
    const worker = await harness.runWorker(String(enqueued.jobId));
    assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-800)} stderr: ${worker.stderr.slice(-2000)}`);
    const [job] = await harness.rows('SELECT status FROM ingestion_jobs WHERE id = $1', [enqueued.jobId]);
    return { status: String(job?.status), documentId: String(enqueued.documentId) };
  }

  async function assertGate(fixture: GateCase, path: string, outcome: { status: string; documentId: string }): Promise<void> {
    const label = `${path} ${fixture.folder}/${fixture.name}`;
    const document = await documentOf(outcome.documentId);
    const chunks = await chunksOf(outcome.documentId);
    assert.ok(chunks.length > 0, `${label}: chunks were written`);
    if (fixture.kinds.length === 0) {
      assert.equal(outcome.status, 'ready', `${label} is ready`);
      assert.equal(document.status, 'ready', `${label}: the document is ready`);
      assert.equal((document.metadata as Row).quarantine, undefined, `${label} carries no quarantine`);
      assert.ok(chunks.every((chunk) => chunk.status === 'ready'), `${label}: every chunk is ready`);
      return;
    }
    assert.equal(outcome.status, 'quarantined', `${label} is quarantined`);
    assert.equal(document.status, 'quarantined', `${label}: the document is quarantined`);
    assert.equal(document.is_current, false, `${label} is not current`);
    assert.ok(chunks.every((chunk) => chunk.status === 'quarantined'), `${label}: every chunk is quarantined`);
    const reasons = (((document.metadata as Row).quarantine as Row).reasons as unknown[]).map((reason) => m.contracts.QuarantineReasonSchema.parse(reason));
    assert.deepEqual(reasons.map((reason) => reason.kind), fixture.kinds, `${label}: reason kinds`);
    for (const reason of reasons) {
      if (reason.kind === 'hidden_text') {
        assert.ok(reason.spans.some((span) => span.reason === fixture.spanReason), `${label}: a span with reason ${fixture.spanReason}`);
        assert.equal(document.hidden_text_check, 'hidden_found', `${label}: hidden_text_check`);
      }
      if (reason.kind === 'untrusted_link') assert.deepEqual(reason.targets, fixture.targets, `${label}: link targets`);
    }
    if (fixture.kinds.includes('hidden_text')) {
      for (const chunk of chunks) {
        if (fixture.hiddenText !== null) {
          assert.ok(!normalized(chunk.content).includes(normalized(fixture.hiddenText)), `${label}: no chunk content holds the hidden text`);
          assert.ok(!normalized(chunk.lexical_text).includes(normalized(fixture.hiddenText)), `${label}: no lexical_text holds the hidden text`);
        } else {
          assert.ok(!ZERO_WIDTH.test(String(chunk.content)) && !ZERO_WIDTH.test(String(chunk.lexical_text ?? '')), `${label}: no zero-width character remains`);
        }
      }
    }
  }

  test('the case list covers every fixture, with hidden-text and link fixtures in every folder that has them', () => {
    const bad = CASES.filter((fixture) => fixture.kinds.length > 0);
    const clean = CASES.filter((fixture) => fixture.kinds.length === 0);
    assert.ok(bad.length >= 18 && clean.length >= 16, `${bad.length} bad and ${clean.length} clean fixtures`);
    for (const folder of FOLDERS) assert.ok(bad.some((fixture) => fixture.folder === folder), `${folder} has a bad fixture`);
    const spanReasons = new Set(bad.map((fixture) => fixture.spanReason).filter((reason) => reason !== null));
    for (const reason of ['color_near_background', 'font_too_small', 'outside_page', 'invisible_render_mode', 'covered_by_object', 'vanished_run', 'comment', 'tracked_deletion', 'zero_width']) {
      assert.ok(spanReasons.has(reason), `a fixture exercises ${reason}`);
    }
    const linkFixtures = bad.filter((fixture) => fixture.kinds.includes('untrusted_link'));
    assert.ok(linkFixtures.some((fixture) => fixture.mime === 'application/pdf'), 'a link annotation fixture');
    assert.ok(linkFixtures.some((fixture) => fixture.targets.some((target) => target.includes('@'))), 'an e-mail address fixture');
    assert.ok(linkFixtures.some((fixture) => fixture.targets.some((target) => !target.includes('://') && !target.includes('@'))), 'a bare domain fixture');
    assert.ok(linkFixtures.some((fixture) => fixture.targets.some((target) => target.startsWith('https://'))), 'a URL fixture');
  });

  test('inline: every bad fixture is quarantined with its reason and keeps no hidden text, every clean fixture is ready', async () => {
    for (const fixture of CASES) {
      current = fixture;
      await assertGate(fixture, 'inline', await inline(fixture, harness.scopeB));
    }
  });

  test('queued: the same outcome for every fixture', async () => {
    for (const fixture of CASES) {
      current = fixture;
      await assertGate(fixture, 'queued', await queued(fixture, harness.scopeA));
    }
  });
});
