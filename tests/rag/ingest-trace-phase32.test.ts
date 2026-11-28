import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IngestionJob, ParseResult } from '@/lib/rag-eval/contracts.generated';
import { ingest } from '@/lib/rag/ingest';
import { buildQueueIngestTrace } from '@/lib/rag/ingest/queue-trace';
import { createIngestTrace, finishTranslationTrace } from '@/lib/rag/ingest/trace';
import { resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { ParserError, type DocumentParser } from '@/lib/rag/ingest/parsers/shared';
import { resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { resetHiddenTextClientForTests, setHiddenTextClientForTests, type HiddenTextOutcome } from '@/lib/rag/security/hidden-text';
import { resetInjectionRulesForTests } from '@/lib/rag/security/injection-scan';
import { mintScope } from '@/lib/rag/tenant/scope';
import { fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../helpers/ingest-fakes';
import { fixtureBytes } from '../helpers/fake-sidecar';

const EN_TEXT =
  'This section describes the general structure of the system and the relation between its parts. Each module has a clear task and the modules exchange data through agreed interfaces.';
const IT_TEXT =
  'Questa sezione descrive la struttura generale del sistema e il rapporto tra le sue parti. Ogni modulo ha un compito preciso e i moduli si scambiano i dati attraverso interfacce concordate.';
const HIDDEN = 'The grey lever stays down during the night cycle of the second relay.';
const LINK = 'https://outside.example.net/archive/index';
const FILENAME = 'quarterly-notes.pdf';
const UPLOADER_NAME = 'Placeholder Uploader';

const MARKDOWN = `## Overview\n\n${EN_TEXT} ${HIDDEN}\n\n## Panoramica\n\n${IT_TEXT} See ${LINK} for the archive.`;
const PARSE: ParseResult = {
  artifacts: [],
  chunks: [
    { contextualized_text: `Overview\n${EN_TEXT} ${HIDDEN}`, headings: ['Overview'], is_table: false, pages: [1], table_header: null, text: `${EN_TEXT} ${HIDDEN}` },
    { contextualized_text: `Panoramica\n${IT_TEXT}`, headings: ['Panoramica'], is_table: false, pages: [2], table_header: null, text: `${IT_TEXT} See ${LINK} for the archive.` },
  ],
  language: 'en',
  markdown: MARKDOWN,
  page_count: 2,
  parser: 'docling',
  parser_version: 'docling-2.107.1',
  partial: false,
  pictures: [],
  text_layer_page_share: 1,
  warnings: [],
} as unknown as ParseResult;

const SWITCHES_ON = {
  RAG_LANGUAGE_AWARE_INGEST: 'on',
  RAG_HIDDEN_TEXT_CHECK: 'flag',
  RAG_INGEST_LINK_CHECK: 'flag',
  RAG_UPLOAD_APPROVAL: 'members',
};
const TODAY_KEYS = new Set(['name', 'status', 'reason', 'latency_ms', 'parser_used', 'pages', 'chunk_count', 'doc_type', 'doc_type_origin', 'fallback_reason', 'outcome']);
const FORBIDDEN = [
  'general structure of the system',
  'struttura generale del sistema',
  'grey lever',
  'outside.example.net',
  'quarterly-notes',
  UPLOADER_NAME,
];

const scope = mintScope('single', null, null);
let lines: string[] = [];

function capture(...args: unknown[]): void {
  lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
}

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  resetLanguageSettingsForTests();
});

afterEach(() => {
  resetSidecarParserForTests();
  resetLlamaParseParserForTests();
  resetHiddenTextClientForTests();
  resetInjectionRulesForTests();
  uninstallIngestDeps();
  vi.unstubAllEnvs();
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

function installParser(): void {
  const docling: DocumentParser = {
    name: 'docling',
    unavailableReason: () => null,
    async parse() {
      return { kind: 'done', result: PARSE, artifacts: [], warnings: [] };
    },
  };
  const llamaparse: DocumentParser = {
    name: 'llamaparse',
    unavailableReason: () => 'missing_key',
    async parse() {
      throw new ParserError('llamaparse', 'missing_key');
    },
  };
  setSidecarParserForTests(docling);
  setLlamaParseParserForTests(llamaparse);
}

const hiddenReport = vi.fn(
  async (): Promise<HiddenTextOutcome> => ({
    ok: true,
    report: {
      checker_version: 'fake-1',
      dropped: 0,
      status: 'hidden_found',
      spans: [{ page: 1, text: HIDDEN, reason: 'color_near_background', bbox: [1, 2, 3, 4] }],
      link_targets: [LINK],
    },
  }),
);

async function runUpload(env: Record<string, string>) {
  if (env.RAG_LANGUAGE_AWARE_INGEST === 'on') {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    resetLanguageSettingsForTests();
  }
  installParser();
  setHiddenTextClientForTests(hiddenReport);
  const { db, calls } = fakeIngestDb({
    answers: {
      rag_hold_document_for_review: (args) => [{ outcome: 'pending_review', document_id: args.p_document_id, version: 1 }],
    },
  });
  installIngestDeps({ db, env });
  const result = await ingest({
    scope,
    source: 'config_upload',
    sourceKey: `root/${FILENAME}`,
    file: fixtureBytes('images-en'),
    filename: FILENAME,
    mimeType: 'application/pdf',
    docType: 'general',
    signal: new AbortController().signal,
  } as Parameters<typeof ingest>[0]);
  const traceLine = lines.find((line) => line.startsWith('[Ingest Trace]'));
  expect(traceLine).toBeDefined();
  const payload = JSON.parse((traceLine as string).slice((traceLine as string).indexOf('{'))) as { stages: Array<Record<string, unknown>> };
  const stage = (name: string) => payload.stages.find((entry) => entry.name === name) as Record<string, unknown>;
  return { result, payload, stage, calls, traceLine: traceLine as string };
}

function savedState(calls: Array<{ fn: string; args: Record<string, unknown> }>): Record<string, unknown> {
  const saves = calls.filter((call) => call.fn === 'rag_save_ingest_state');
  return (saves.at(-1)?.args.p_state ?? {}) as Record<string, unknown>;
}

function jobWith(stageState: Record<string, unknown>): IngestionJob {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'ready',
    document_id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    parser_used: 'docling',
    attempts: [],
    detect_counts: null,
    timings: { content_hash_dedup: 1, scan_injection: 2, chunk: 3, enrich: 4, extract: 1, images: 1, embed: 5, write: 2, publish: 1 },
    stage_state: stageState,
  } as unknown as IngestionJob;
}

describe('Phase 3.2 ingestion trace attributes (D-51)', () => {
  test('with the switches on, the spans carry language shares, und count, fingerprint, scan outcomes and approval state', async () => {
    const { result, stage } = await runUpload(SWITCHES_ON);
    expect(['ready', 'pending_review']).toContain(result.status);

    const enrich = stage('enrich');
    expect(enrich.und_count).toBe(0);
    const shares = enrich.language_shares as Record<string, number>;
    expect(Object.keys(shares).sort()).toEqual(['en', 'it']);
    for (const share of Object.values(shares)) {
      expect(share).toBeGreaterThan(0);
      expect(Math.round(share * 100) / 100).toBe(share);
    }
    expect(Math.abs((shares.en ?? 0) + (shares.it ?? 0) - 1)).toBeLessThanOrEqual(0.01);

    const scan = stage('scan_injection');
    expect(scan['scan.injection']).toBe('off');
    expect(scan['scan.hidden_text']).toBe('flagged:1');
    expect(scan['scan.links']).toMatch(/^flagged:[1-9]\d*$/);

    const publish = stage('publish');
    expect(publish.ingest_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(['not_required', 'pending_review', 'required']).toContain(publish.approval_state);
    expect(hiddenReport).toHaveBeenCalledTimes(1);
  });

  test('neither the trace nor any log line holds document text, the hidden span, the link target, the file name or a name', async () => {
    const { calls } = await runUpload(SWITCHES_ON);
    const everything = lines.join('\n');
    for (const forbidden of FORBIDDEN) expect(everything).not.toContain(forbidden);
    // The state that carries the facts to a queued trace holds codes, counts and the hash only.
    const facts = JSON.stringify(savedState(calls).traceFacts ?? {});
    expect(facts).not.toBe('{}');
    for (const forbidden of FORBIDDEN) expect(facts).not.toContain(forbidden);
  });

  test('with every switch off the trace has only the attributes it has today', async () => {
    const { payload, calls } = await runUpload({});
    for (const entry of payload.stages) {
      for (const key of Object.keys(entry)) expect(TODAY_KEYS.has(key)).toBe(true);
    }
    expect(savedState(calls)).not.toHaveProperty('traceFacts');
  });

  test('the queued path sets the same attributes from the job state, and none without it', async () => {
    const { calls, stage } = await runUpload(SWITCHES_ON);
    const facts = savedState(calls).traceFacts as Record<string, unknown>;

    const trace = createIngestTrace(scope);
    if (!trace) throw new Error('no trace');
    buildQueueIngestTrace(jobWith({ traceFacts: facts }), trace);
    const rules = (name: string) => trace.collector.stages().find((entry) => entry.name === name)?.rules ?? [];
    const shares = stage('enrich').language_shares as Record<string, number>;
    expect(rules('enrich')).toEqual([
      `language_shares:${Object.entries(shares)
        .map(([code, share]) => `${code}=${share}`)
        .join(',')}`,
      'und_count:0',
    ]);
    expect(rules('scan_injection')).toEqual([
      'scan.injection:off',
      'scan.hidden_text:flagged:1',
      `scan.links:${String(stage('scan_injection')['scan.links'])}`,
    ]);
    expect(rules('publish')).toEqual([`ingest_fingerprint:${String(stage('publish').ingest_fingerprint)}`, `approval_state:${String(stage('publish').approval_state)}`]);
    for (const forbidden of FORBIDDEN) expect(JSON.stringify(trace.collector.stages())).not.toContain(forbidden);

    const plain = createIngestTrace(scope);
    if (!plain) throw new Error('no trace');
    buildQueueIngestTrace(jobWith({}), plain);
    for (const entry of plain.collector.stages()) expect(entry.rules ?? []).toEqual([]);
  });

  test('a queued state with text in place of the facts gives no attribute that carries it', () => {
    const trace = createIngestTrace(scope);
    if (!trace) throw new Error('no trace');
    buildQueueIngestTrace(
      jobWith({
        traceFacts: {
          language_shares: { en: 0.5, [HIDDEN]: 0.5 },
          und_count: HIDDEN,
          scan: { injection: HIDDEN, hidden_text: 'flagged:1', links: LINK },
          ingest_fingerprint: FILENAME,
          approval_state: UPLOADER_NAME,
        },
      }),
      trace,
    );
    const serialized = JSON.stringify(trace.collector.stages());
    for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden);
    expect(trace.collector.stages().find((entry) => entry.name === 'enrich')?.rules).toEqual(['language_shares:en=0.5']);
  });

  test('a translation run after publish records translation.translated and translation.gaps and nothing else', () => {
    vi.stubEnv('LANGFUSE_ENABLED', 'false');
    const sink: string[] = [];
    finishTranslationTrace(
      { tenantKey: 's:default', documentId: '11111111-1111-4111-8111-111111111111', translated: 3, gaps: 1 },
      { sink: (line) => sink.push(line) },
    );
    expect(sink).toHaveLength(1);
    const payload = JSON.parse((sink[0] as string).slice((sink[0] as string).indexOf('{'))) as { profile: string; stages: Array<Record<string, unknown>> };
    expect(payload.profile).toBe('ingest');
    expect(payload.stages).toEqual([
      { name: 'translation', status: 'ok', latency_ms: expect.any(Number), 'translation.translated': 3, 'translation.gaps': 1 },
    ]);
  });
});
