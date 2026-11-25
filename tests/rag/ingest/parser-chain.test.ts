import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { ingest, resumeIngest } from '@/lib/rag/ingest';
import { setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { buildParserChain, parseWithFallback } from '@/lib/rag/ingest/parsers/chain';
import { resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { parsePlainText } from '@/lib/rag/ingest/parsers/plain-text';
import { resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import {
  ParserError,
  type DocumentParser,
  type NetworkParserName,
  type ParseArtifact,
  type ParseAttempt,
  type ParseRequest,
} from '@/lib/rag/ingest/parsers/shared';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_LINEAGE_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';

const scope = mintScope('single', null, null);
const PDF = new TextEncoder().encode('%PDF-1.4 fixture bytes');
const encoder = new TextEncoder();

const TEXT_BODY = [
  '# Handbook',
  '',
  'The night crew scans every pallet at the dock and stages it beside bay four for the morning team.',
  '',
  '## Receiving',
  '',
  'Pallets arriving at the receiving dock are scanned by the crew and staged beside bay four.',
  '',
].join('\n');

function resultOf(parser: 'docling' | 'llamaparse' | 'text', extra: Partial<ParseResult> = {}): ParseResult {
  return {
    markdown: TEXT_BODY,
    chunks: [],
    pictures: [],
    page_count: 2,
    language: 'en',
    parser,
    parser_version: parser === 'docling' ? 'docling-test' : parser === 'llamaparse' ? 'llamaparse-v2/cost_effective@latest' : 'native',
    partial: false,
    text_layer_page_share: null,
    warnings: [],
    ...extra,
  } as ParseResult;
}

interface FakeParser extends DocumentParser {
  calls: ParseRequest[];
}

function fakeParser(
  name: NetworkParserName,
  options: { unavailable?: string | null; script?: (request: ParseRequest, call: number) => ParseAttempt | Promise<ParseAttempt> } = {},
): FakeParser {
  const calls: ParseRequest[] = [];
  return {
    name,
    calls,
    unavailableReason: () => options.unavailable ?? null,
    async parse(request) {
      calls.push(request);
      if (!options.script) return { kind: 'done', result: resultOf(name), artifacts: [], warnings: [] };
      return options.script(request, calls.length - 1);
    },
  };
}

const failing = (parser: NetworkParserName, reason: string) =>
  fakeParser(parser, {
    script: () => {
      throw new ParserError(parser, reason);
    },
  });

function request(overrides: Partial<ParseRequest> = {}, profileType: Parameters<typeof getProcessingProfile>[0] = 'general'): ParseRequest {
  return {
    scope,
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: PDF,
    profile: getProcessingProfile(profileType),
    signal: new AbortController().signal,
    now: () => 0,
    deadline: 50_000,
    pollUntil: 45_000,
    resume: null,
    onSubmitted: async () => undefined,
    ...overrides,
  };
}

const textRequest = (filename: string, body: string, mimeType: string) => request({ filename, mimeType, bytes: encoder.encode(body) });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetLlamaParseParserForTests();
  resetSidecarParserForTests();
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

describe('buildParserChain', () => {
  test('puts the configured parser first, then the other parser, then plain text for text-like files only', () => {
    const general = getProcessingProfile('general');
    expect(buildParserChain(general, { parser: 'llamaparse' }, { filename: 'a.pdf', mimeType: 'application/pdf' })).toEqual(['llamaparse', 'docling']);
    expect(buildParserChain(general, { parser: 'docling' }, { filename: 'a.pdf', mimeType: 'application/pdf' })).toEqual(['docling', 'llamaparse']);
    expect(buildParserChain(general, { parser: 'llamaparse' }, { filename: 'a.md', mimeType: 'text/markdown' })).toEqual(['llamaparse', 'docling', 'text']);
    expect(buildParserChain(general, { parser: 'llamaparse' }, { filename: 'a.csv', mimeType: '' })).toEqual(['llamaparse', 'docling', 'text']);
    expect(buildParserChain(general, { parser: 'llamaparse' }, { filename: 'a.docx', mimeType: '' })).toEqual(['llamaparse', 'docling']);
  });

  test('an invoice profile tries Docling first whatever RAG_PARSER says', () => {
    const invoice = getProcessingProfile('invoice_receipt');
    expect(buildParserChain(invoice, { parser: 'llamaparse' }, { filename: 'i.pdf', mimeType: 'application/pdf' })).toEqual(['docling', 'llamaparse']);
    expect(buildParserChain(invoice, { parser: 'docling' }, { filename: 'i.pdf', mimeType: 'application/pdf' })).toEqual(['docling', 'llamaparse']);
  });
});

describe('parseWithFallback', () => {
  test('LlamaParse without a key is skipped and Docling parses; the log names missing_key', async () => {
    const llama = fakeParser('llamaparse', { unavailable: 'missing_key' });
    const docling = fakeParser('docling');
    setLlamaParseParserForTests(llama);
    setSidecarParserForTests(docling);
    const outcome = await parseWithFallback(['llamaparse', 'docling'], request());
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.parser).toBe('docling');
    expect(outcome.fallbacks).toEqual([{ parser: 'llamaparse', reason: 'missing_key' }]);
    expect(llama.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[Ingest] parser fallback', { parser: 'llamaparse', reason: 'missing_key' });
  });

  test.each([
    ['an HTTP 500', 'http_500'],
    ['a FAILED job', 'job_failed'],
    ['a timeout', 'timeout'],
  ])('LlamaParse failing with %s falls back to Docling with that reason', async (_label, reason) => {
    setLlamaParseParserForTests(failing('llamaparse', reason));
    const docling = fakeParser('docling');
    setSidecarParserForTests(docling);
    const outcome = await parseWithFallback(['llamaparse', 'docling'], request());
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.parser).toBe('docling');
    expect(outcome.fallbacks).toEqual([{ parser: 'llamaparse', reason }]);
    expect(warn).toHaveBeenCalledWith('[Ingest] parser fallback', { parser: 'llamaparse', reason });
  });

  test('RAG_PARSER=docling with the sidecar answering 503 falls back to LlamaParse', async () => {
    setSidecarParserForTests(failing('docling', 'docling_unavailable'));
    const llama = fakeParser('llamaparse');
    setLlamaParseParserForTests(llama);
    const outcome = await parseWithFallback(['docling', 'llamaparse'], request());
    expect(outcome.kind === 'done' && outcome.parser).toBe('llamaparse');
    expect(llama.calls).toHaveLength(1);
  });

  test('with both parsers unavailable a .md file is parsed as plain text', async () => {
    setLlamaParseParserForTests(fakeParser('llamaparse', { unavailable: 'missing_key' }));
    setSidecarParserForTests(fakeParser('docling', { unavailable: 'not_configured' }));
    const outcome = await parseWithFallback(['llamaparse', 'docling', 'text'], textRequest('guide.md', TEXT_BODY, 'text/markdown'));
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.parser).toBe('text');
    expect(outcome.result.markdown).toBe(TEXT_BODY);
    expect(outcome.result.parser_version).toBe('native');
  });

  test('a .csv file becomes a Markdown table with a header and separator row', () => {
    const result = parsePlainText({ filename: 'items.csv', mimeType: 'text/csv', bytes: encoder.encode('name,qty\n"Bolt, M6",10\nNut,25\n') });
    expect(result.markdown).toBe('| name | qty |\n| --- | --- |\n| Bolt, M6 | 10 |\n| Nut | 25 |');
  });

  test('a .txt file with a byte order mark is decoded without it', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('plain words')]);
    expect(parsePlainText({ filename: 'a.txt', mimeType: 'text/plain', bytes }).markdown).toBe('plain words');
  });

  test('with both parsers unavailable a PDF ends failed with no_parser_available', async () => {
    setLlamaParseParserForTests(fakeParser('llamaparse', { unavailable: 'missing_key' }));
    setSidecarParserForTests(fakeParser('docling', { unavailable: 'not_configured' }));
    const outcome = await parseWithFallback(['llamaparse', 'docling'], request());
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'no_parser_available',
      fallbacks: [
        { parser: 'llamaparse', reason: 'missing_key' },
        { parser: 'docling', reason: 'not_configured' },
      ],
    });
  });

  test('LlamaParse is skipped without a minted scope, so there is no anonymous path to its spend', async () => {
    const llama = fakeParser('llamaparse');
    setLlamaParseParserForTests(llama);
    setSidecarParserForTests(fakeParser('docling'));
    const outcome = await parseWithFallback(['llamaparse', 'docling'], request({ scope: { kind: 'single', userId: null, organizationId: null } as unknown as ParseRequest['scope'] }));
    expect(llama.calls).toHaveLength(0);
    expect(outcome.kind === 'done' && outcome.fallbacks).toEqual([{ parser: 'llamaparse', reason: 'scope_unverified' }]);
  });

  test('a pending job is returned, and a resume only reaches the parser that owns the saved job', async () => {
    const job = { parser: 'docling' as const, jobId: 'job-1', submittedAt: '2026-01-01T00:00:00.000Z', attempt: 1 };
    const llama = fakeParser('llamaparse');
    const docling = fakeParser('docling', { script: (req) => (req.resume ? { kind: 'done', result: resultOf('docling'), artifacts: [], warnings: [] } : { kind: 'pending', job }) });
    setLlamaParseParserForTests(llama);
    setSidecarParserForTests(docling);
    const first = await parseWithFallback(['docling', 'llamaparse'], request());
    expect(first).toEqual({ kind: 'pending', job, fallbacks: [] });
    const resumed = await parseWithFallback(['llamaparse', 'docling'], request({ resume: job }));
    expect(resumed.kind === 'done' && resumed.parser).toBe('docling');
    expect(docling.calls[1]?.resume).toEqual(job);
    expect(llama.calls).toHaveLength(0);
  });

  test('an abort is not a fallback', async () => {
    const controller = new AbortController();
    setLlamaParseParserForTests(
      fakeParser('llamaparse', {
        script: () => {
          controller.abort();
          throw new ParserError('llamaparse', 'network');
        },
      }),
    );
    const docling = fakeParser('docling');
    setSidecarParserForTests(docling);
    await expect(parseWithFallback(['llamaparse', 'docling'], request({ signal: controller.signal }))).rejects.toBeDefined();
    expect(docling.calls).toHaveLength(0);
  });
});

describe('the parse stage', () => {
  const PDF_NAME = 'report.pdf';

  function upload(overrides: Record<string, unknown> = {}) {
    return ingest({
      scope,
      source: 'config_upload',
      sourceKey: `root/${PDF_NAME}`,
      file: PDF,
      filename: PDF_NAME,
      mimeType: 'application/pdf',
      signal: new AbortController().signal,
      ...overrides,
    } as Parameters<typeof ingest>[0]);
  }

  function install(parser: 'llamaparse' | 'docling' = 'llamaparse', now?: () => number) {
    const fake = fakeIngestDb();
    const store = installIngestDeps({ db: fake.db, env: { RAG_PARSER: parser, RAG_INGEST_PIPELINE: 'unified' }, ...(now ? { now } : {}) });
    return { ...fake, store };
  }

  const picture: ParseArtifact = { name: 'picture-1.png', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
  const doclingJson: ParseArtifact = { name: 'docling.json', bytes: encoder.encode('{"docling":true}'), contentType: 'application/json' };

  test('a PDF falls back from an unconfigured LlamaParse to Docling and records what ran, with parse.md and docling.json stored', async () => {
    const { calls, store } = install();
    setLlamaParseParserForTests(fakeParser('llamaparse', { unavailable: 'missing_key' }));
    setSidecarParserForTests(fakeParser('docling', { script: () => ({ kind: 'done', result: resultOf('docling'), artifacts: [doclingJson, picture], warnings: [] }) }));

    const result = await upload();
    expect(result.status).toBe('ready');
    expect(result.parserUsed).toBe('docling');
    expect(result.warnings).toContain('parser_fallback:llamaparse:missing_key');
    const fields = callsOf(calls, 'rag_set_document_fields').map((call) => call.args.p_fields as Record<string, unknown>);
    expect(fields).toContainEqual({ parser_used: 'docling', parser_version: 'docling-test' });
    const keys = store.keys();
    expect(keys.some((key) => key.endsWith('/parse.md'))).toBe(true);
    expect(keys.some((key) => key.endsWith('/docling.json'))).toBe(true);
    expect(keys.some((key) => key.endsWith('/picture-1.png'))).toBe(true);
  });

  test('Docling chunks reach the chunk stage through ParseResult.chunks', async () => {
    const { calls } = install('docling');
    const chunks = [{ text: 'Pallets are scanned at the dock.', contextualized_text: 'Receiving\nPallets are scanned at the dock.', headings: ['Receiving'], pages: [2], is_table: false, table_header: null }];
    setSidecarParserForTests(fakeParser('docling', { script: () => ({ kind: 'done', result: resultOf('docling', { chunks }), artifacts: [], warnings: [] }) }));
    const result = await upload();
    expect(result.status).toBe('ready');
    const written = callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, unknown>>);
    expect(written).toHaveLength(1);
    expect(written[0]?.content).toBe('Pallets are scanned at the dock.');
  });

  test('both parsers unavailable ends a PDF failed with no_parser_available', async () => {
    install();
    const result = await upload();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('no_parser_available');
  });

  test('text passed to ingest never reaches a parser and parses as today', async () => {
    install();
    const llama = fakeParser('llamaparse');
    setLlamaParseParserForTests(llama);
    const result = await upload({ file: undefined, text: TEXT_BODY, filename: 'guide.md', mimeType: 'text/markdown' });
    expect(result.status).toBe('ready');
    expect(result.parserUsed).toBe('text');
    expect(llama.calls).toHaveLength(0);
  });

  test('a refinement that switches general to scanned_image re-parses once with the new profile, and never again', async () => {
    install('docling');
    const docling = fakeParser('docling', {
      script: (req) => ({ kind: 'done', result: resultOf('docling', { text_layer_page_share: 0 }), artifacts: [], warnings: [] }),
    });
    setSidecarParserForTests(docling);
    const result = await upload({ docType: 'auto' });
    expect(result.status).toBe('ready');
    expect(docling.calls).toHaveLength(2);
    expect(docling.calls[0]?.profile.doc_type).toBe('general');
    expect(docling.calls[1]?.profile.doc_type).toBe('scanned_image');
    expect(docling.calls[1]?.profile.parser.docling.force_full_page_ocr).toBe(true);
  });

  test('a refinement that does not change parser options does not re-parse', async () => {
    install('docling');
    const docling = fakeParser('docling');
    setSidecarParserForTests(docling);
    const result = await upload({ docType: 'auto' });
    expect(result.status).toBe('ready');
    expect(docling.calls).toHaveLength(1);
  });

  test('a picked type is never refined and never re-parsed', async () => {
    install('docling');
    const docling = fakeParser('docling', { script: () => ({ kind: 'done', result: resultOf('docling', { text_layer_page_share: 0 }), artifacts: [], warnings: [] }) });
    setSidecarParserForTests(docling);
    await upload({ docType: 'general' });
    expect(docling.calls).toHaveLength(1);
  });

  test('a job that is still running yields processing with the job id saved, and a resume polls the same job and reaches ready', async () => {
    const first = install('docling');
    const job = { parser: 'docling' as const, jobId: 'job-42', submittedAt: '2026-01-01T00:00:00.000Z', attempt: 1 };
    const sidecar = fakeParser('docling', {
      script: async (req) => {
        if (req.resume) return { kind: 'done', result: resultOf('docling'), artifacts: [], warnings: [] };
        await req.onSubmitted(job);
        return { kind: 'pending', job };
      },
    });
    setSidecarParserForTests(sidecar);

    const yielded = await upload();
    expect(yielded.status).toBe('processing');
    expect(yielded.reason).toBe('parse_pending');
    const states = callsOf(first.calls, 'rag_save_ingest_state').map((call) => call.args.p_state as Record<string, unknown>);
    expect(states.some((state) => (state.parseJob as { jobId?: string } | null)?.jobId === 'job-42')).toBe(true);
    const saved = states[states.length - 1] as Record<string, unknown>;
    expect(saved.lastCompleted).toBe('store_original');
    expect(first.store.keys().some((key) => key.endsWith('/original.pdf'))).toBe(true);

    const originalKey = first.store.keys().find((key) => key.endsWith('/original.pdf')) as string;
    const second = fakeIngestDb({
      document: { status: 'processing', version: 1, processing_status: 'processing', processing_state: saved, filename: PDF_NAME, doc_type: 'general', parser_used: null, created_at: '2026-01-01T00:00:00Z' },
      origin: { lineage_id: FAKE_LINEAGE_ID, original_path: originalKey, source: 'config_upload', source_key: `root/${PDF_NAME}` },
    });
    setIngestDepsForTests({ db: () => second.db });

    const resumed = await resumeIngest(scope, '11111111-1111-4111-8111-111111111111', { signal: new AbortController().signal });
    expect(resumed.status).toBe('ready');
    expect(sidecar.calls).toHaveLength(2);
    expect(sidecar.calls[1]?.resume).toEqual(job);
    const indexes = callsOf(second.calls, 'rag_write_chunks').flatMap((call) => (call.args.p_chunks as Array<{ chunk_index: number }>).map((chunk) => chunk.chunk_index));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  test('a stage that has no time left to wait yields instead of waiting past the request deadline', async () => {
    let clock = 0;
    install('docling', () => clock);
    const sidecar = fakeParser('docling', { script: (req) => ({ kind: 'pending', job: { parser: 'docling', jobId: 'late', submittedAt: 'x', attempt: 1 } as never }) });
    setSidecarParserForTests(sidecar);
    const result = await upload({ deadlineMs: 20_000 });
    expect(result.status).toBe('processing');
    expect(sidecar.calls[0]?.pollUntil).toBeLessThanOrEqual(20_000);
    clock = 0;
  });
});
