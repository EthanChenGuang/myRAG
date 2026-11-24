import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import * as rag from '@/lib/rag';
import { getIngestStatus, ingest, resumeIngest } from '@/lib/rag/ingest';
import { INGEST_STAGES } from '@/lib/rag/ingest/runner';
import { createIngestTrace, finishIngestTrace } from '@/lib/rag/ingest/trace';
import type { ChunkDraft, StageContext } from '@/lib/rag/ingest/types';
import { resetLangfuseForTests } from '@/lib/rag/trace/langfuse';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { startFakeLangfuse, type FakeLangfuse, type FakeSpan } from '../../helpers/fake-langfuse.mts';
import { FAKE_DOCUMENT_ID, callsOf, fakeIngestDb, installIngestDeps, savedStages, uninstallIngestDeps } from '../../helpers/ingest-fakes';

const PHRASE = 'heliotrope marmalade quasar';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const TEXT = [
  '# Handbook',
  '',
  `The ${PHRASE} rule applies to all of the staff on the floor and to the night crew at the dock.`,
  '',
  '## Receiving',
  '',
  'The night crew scans every pallet at the dock and stages it beside bay four for the morning team.',
  '',
].join('\n');

const ATTR = 'langfuse.observation.metadata.';
const PUBLIC_KEY = 'pk-lf-placeholder-0000';
const SECRET_KEY = 'sk-lf-placeholder-0000';

const single = mintScope('single', null, null);
let fake: FakeLangfuse;
let log: MockInstance<(...args: unknown[]) => void>;

beforeAll(async () => {
  fake = await startFakeLangfuse();
});

afterAll(async () => {
  await fake?.close();
});

beforeEach(async () => {
  fake.reset();
  await resetLangfuseForTests();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  fake.release();
  await resetLangfuseForTests();
  uninstallIngestDeps();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function langfuseEnv(overrides: Record<string, string> = {}): void {
  const values: Record<string, string> = {
    LANGFUSE_ENABLED: 'true',
    LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: SECRET_KEY,
    LANGFUSE_BASE_URL: fake.url,
    LANGFUSE_SAMPLE_RATE: '1',
    LANGFUSE_REVIEW_SAMPLE_RATE: '0',
    LANGFUSE_CAPTURE_CONTENT: 'false',
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function upload(overrides: Partial<Parameters<typeof ingest>[0]> = {}) {
  return ingest({
    scope: single,
    source: 'config_upload',
    sourceKey: 'root/handbook.md',
    text: TEXT,
    filename: 'handbook.md',
    mimeType: 'text/markdown',
    signal: new AbortController().signal,
    ...overrides,
  } as Parameters<typeof ingest>[0]);
}

function traceLines(): string[] {
  return log.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => line.includes('[Ingest Trace]'));
}

function parseLine(line: string): { profile: string; tenantKey: string; status: string; stages: Array<Record<string, unknown>> } {
  return JSON.parse(line.slice(line.indexOf('{')));
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tagsOf(span: FakeSpan): string[] {
  const raw = span.attributes['langfuse.trace.tags'];
  return Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
}

describe('ingestion trace', () => {
  test('a run records one span per stage, named as the stage, with the fixed detail fields', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload();

    expect(result.status).toBe('ready');
    const lines = traceLines();
    expect(lines).toHaveLength(1);
    const payload = parseLine(lines[0] as string);
    expect(payload.profile).toBe('ingest');
    expect(payload.tenantKey).toBe('s:default');
    expect(payload.status).toBe('ready');
    expect(payload.stages.map((stage) => stage.name)).toEqual([...INGEST_STAGES]);
    for (const stage of payload.stages) {
      expect(typeof stage.status).toBe('string');
      expect(typeof stage.latency_ms).toBe('number');
    }
    const byName = (name: string) => payload.stages.find((stage) => stage.name === name) as Record<string, unknown>;
    expect(byName('file_hash_dedup')).toMatchObject({ status: 'ok', outcome: 'unique' });
    expect(byName('store_original')).toMatchObject({ status: 'ok' });
    expect(byName('store_original').fallback_reason ?? null).toBeNull();
    expect(byName('parse')).toMatchObject({ parser_used: 'text' });
    expect(byName('chunk')).toMatchObject({ doc_type: 'general', doc_type_origin: 'fallback' });
    expect(byName('chunk').chunk_count).toBeGreaterThanOrEqual(2);
    expect(byName('publish')).toMatchObject({ status: 'ok', outcome: 'ready' });
  });

  test('a stage that fails ends its span as an error with the reason code and nothing else', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_INJECTION_SCAN: 'quarantine' } });

    const result = await upload();

    expect(result.status).toBe('failed');
    expect(traceLines()).toHaveLength(1);
    const payload = parseLine(traceLines()[0] as string);
    const names = payload.stages.map((stage) => stage.name);
    expect(names.at(-1)).toBe('scan_injection');
    expect(payload.stages.at(-1)).toMatchObject({ status: 'error', reason: 'failed', fallback_reason: 'injection_scan_unavailable', outcome: 'failed' });
  });

  test('a sampled run is exported once through the Langfuse path, tagged profile:ingest, with no fallback line', async () => {
    langfuseEnv();
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    await upload();
    expect(await waitFor(() => fake.completedTraceRequests() === 1)).toBe(true);

    expect(fake.errors).toEqual([]);
    expect(traceLines()).toEqual([]);
    const root = fake.spans.find((span) => span.name === 'rag-request');
    expect(root).toBeDefined();
    expect(tagsOf(root as FakeSpan)).toEqual(expect.arrayContaining(['rag-ingest', 'profile:ingest', 'tenant:s:default']));
    const stageSpans = fake.spans.filter((span) => span.name !== 'rag-request');
    expect(stageSpans.map((span) => span.name).sort()).toEqual([...INGEST_STAGES].sort());
    const parse = stageSpans.find((span) => span.name === 'parse') as FakeSpan;
    expect(String(parse.attributes[`${ATTR}rules`])).toContain('parser_used:text');
  });

  test('with review sampling 1 and content capture on, an ingest trace has no review or content block, no review tag, and the collector holds no review content', async () => {
    langfuseEnv({ LANGFUSE_REVIEW_SAMPLE_RATE: '1', LANGFUSE_CAPTURE_CONTENT: 'true' });
    const { db } = fakeIngestDb();
    installIngestDeps({ db });
    const collector = createTraceCollector({ profile: 'ingest', tenantKey: 's:default' });

    const result = await upload({ trace: collector });
    expect(result.status).toBe('ready');
    const trace = createIngestTrace(single, collector);
    expect(trace).not.toBeNull();
    if (!trace) return;
    finishIngestTrace(trace, result);
    expect(await waitFor(() => fake.completedTraceRequests() === 1)).toBe(true);

    const root = fake.spans.find((span) => span.name === 'rag-request') as FakeSpan;
    expect(root.attributes['langfuse.observation.input']).toBeUndefined();
    expect(root.attributes['langfuse.observation.output']).toBeUndefined();
    expect(root.attributes[`${ATTR}context`]).toBeUndefined();
    for (const span of fake.spans) expect(tagsOf(span)).not.toContain('review_candidate');
    expect(collector.reviewContent()).toBeNull();
    expect(JSON.stringify(fake.spans.map((span) => span.attributes))).not.toContain(PHRASE);
  });

  test('a run that is not sampled writes exactly one [Ingest Trace] line and sends nothing, even as a review candidate', async () => {
    langfuseEnv({ LANGFUSE_SAMPLE_RATE: '0', LANGFUSE_REVIEW_SAMPLE_RATE: '1' });
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    await upload();
    await settle();

    expect(traceLines()).toHaveLength(1);
    expect(fake.traceRequestCount()).toBe(0);
  });

  test('when the export fails exactly one [Ingest Trace] line is written, and no document text is in it or in the export', async () => {
    langfuseEnv();
    fake.setTraceMode('error500');
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    await upload();
    expect(await waitFor(() => traceLines().length >= 1)).toBe(true);
    await settle(400);

    expect(traceLines()).toHaveLength(1);
    expect(fake.traceRequestCount()).toBeGreaterThanOrEqual(1);
    const everything = [...traceLines(), JSON.stringify(fake.spans.map((span) => span.attributes))].join('\n');
    expect(everything).not.toContain('heliotrope');
    expect(everything).not.toContain('marmalade');
    expect(everything).not.toContain('handbook.md');
  });

  test('a caller-owned collector receives the spans and the run does not finish it', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });
    const collector = createTraceCollector({ profile: 'ingest', tenantKey: 's:default' });

    await upload({ trace: collector });

    expect(collector.stages().map((stage) => stage.name)).toEqual([...INGEST_STAGES]);
    expect(traceLines()).toEqual([]);
  });
});

describe('status and resume', () => {
  const documentRow = (overrides: Record<string, unknown> = {}) => ({
    status: 'processing',
    version: 2,
    processing_status: 'processing',
    processing_state: { lastCompleted: 'parse', parserUsed: 'text' },
    filename: 'handbook.md',
    doc_type: 'general',
    parser_used: 'text',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  test('ingest, resumeIngest and getIngestStatus are exported from @/lib/rag', () => {
    expect(typeof rag.ingest).toBe('function');
    expect(typeof rag.resumeIngest).toBe('function');
    expect(typeof rag.getIngestStatus).toBe('function');
  });

  test('getIngestStatus returns the status fields of the caller own document', async () => {
    const { db, calls } = fakeIngestDb({ document: documentRow() });
    installIngestDeps({ db });
    const personal = mintScope('personal', USER_A, null);

    const view = await getIngestStatus(personal, FAKE_DOCUMENT_ID);

    expect(view).toEqual({ status: 'processing', version: 2, processingStatus: 'processing', lastCompleted: 'parse', parserUsed: 'text', docType: 'general' });
    expect(callsOf(calls, 'rag_get_ingest_document')[0]?.args).toMatchObject({ p_document_id: FAKE_DOCUMENT_ID, p_tenant_key: `u:${USER_A}` });
  });

  test('getIngestStatus returns null for an id the tenant does not own and for an id that is not a UUID', async () => {
    const { db, calls } = fakeIngestDb({ document: null });
    installIngestDeps({ db });

    expect(await getIngestStatus(single, FAKE_DOCUMENT_ID)).toBeNull();
    expect(await getIngestStatus(single, 'not-a-uuid')).toBeNull();
    expect(callsOf(calls, 'rag_get_ingest_document')).toHaveLength(1);
  });

  test('resumeIngest for a ready document returns its ready result without running a stage', async () => {
    const { db, calls } = fakeIngestDb({
      document: documentRow({ status: 'ready', processing_status: 'ready', processing_state: { lastCompleted: 'publish', chunkCount: 3 } }),
    });
    installIngestDeps({ db });

    const result = await resumeIngest(single, FAKE_DOCUMENT_ID);

    expect(result).toMatchObject({ status: 'ready', documentId: FAKE_DOCUMENT_ID, version: 2, chunkCount: 3, parserUsed: 'text' });
    expect(calls.map((call) => call.fn)).toEqual(['rag_get_ingest_document']);
  });

  test('resumeIngest for a processing document continues after lastCompleted and repeats nothing before it', async () => {
    const { db, calls } = fakeIngestDb({
      document: documentRow({ processing_state: { lastCompleted: 'chunk', docTypeOrigin: 'picked' } }),
    });
    const drafts: ChunkDraft[] = ['alpha section text', 'beta section text'].map((content, index) => ({
      content,
      section_path: [`Part ${index + 1}`],
      chunk_kind: 'text',
      page_start: null,
      page_end: null,
      metadata: {},
    }));
    const rehydrate = vi.fn(async (ctx: StageContext) => {
      ctx.work.parseText = TEXT;
      ctx.work.chunks = drafts.map((draft) => ({ ...draft }));
      return true;
    });
    installIngestDeps({ db });
    const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    setIngestDepsForTests({ rehydrate });

    const result = await resumeIngest(single, FAKE_DOCUMENT_ID);

    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'ready', documentId: FAKE_DOCUMENT_ID, chunkCount: 2 });
    expect(savedStages(calls)).toEqual(['enrich', 'extract', 'images', 'embed', 'write', 'publish']);
    expect(callsOf(calls, 'rag_begin_document_version')).toHaveLength(0);
    expect(callsOf(calls, 'rag_find_content_duplicate')).toHaveLength(0);
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(1);
  });

  test('resumeIngest without a way to rebuild the stage inputs reports processing and changes nothing', async () => {
    const { db, calls } = fakeIngestDb({ document: documentRow({ processing_state: { lastCompleted: 'chunk' } }) });
    installIngestDeps({ db });

    const result = await resumeIngest(single, FAKE_DOCUMENT_ID);

    expect(result).toMatchObject({ status: 'processing', documentId: FAKE_DOCUMENT_ID, reason: 'resume_input_unavailable' });
    expect(calls.map((call) => call.fn)).toEqual(['rag_get_ingest_document', 'rag_get_ingest_origin']);
  });

  test('resumeIngest for an id the tenant does not own fails as not found without any write', async () => {
    const { db, calls } = fakeIngestDb({ document: null });
    installIngestDeps({ db });

    const result = await resumeIngest(single, FAKE_DOCUMENT_ID);

    expect(result).toMatchObject({ status: 'failed', documentId: null, reason: 'document_not_found' });
    expect(calls.map((call) => call.fn)).toEqual(['rag_get_ingest_document']);
  });
});
