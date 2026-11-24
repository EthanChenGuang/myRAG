import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getIngestDeps } from '@/lib/rag/ingest/deps';
import { contentHash } from '@/lib/rag/ingest/hash';
import { INGEST_STAGES, runIngestStages } from '@/lib/rag/ingest/runner';
import { identifyStage } from '@/lib/rag/ingest/stages/identify';
import {
  emptyIngestState,
  type ChunkDraft,
  type IngestResult,
  type StageContext,
  type StageName,
  type StageSpec,
} from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { lexicalText } from '@/lib/rag/lexical/tokenize';
import { mintScope } from '@/lib/rag/tenant/scope';
import {
  FAKE_DOCUMENT_ID,
  callsOf,
  fakeIngestDb,
  installIngestDeps,
  savedStages,
  uninstallIngestDeps,
  type RecordedRpc,
} from '../../helpers/ingest-fakes';

const scope = mintScope('single', null, null);

const URL_TEXT = 'https://docs.example.com/guide';
const MARKDOWN = [
  '# Handbook',
  '',
  `Visit ${URL_TEXT} for the guide and the rules that apply to all of the staff on the floor.`,
  '',
  '## Receiving',
  '',
  'The night crew scans every pallet at the dock and stages it beside bay four for the morning team.',
  '',
].join('\n');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

function upload(overrides: Partial<Parameters<typeof ingest>[0]> = {}) {
  return ingest({
    scope,
    source: 'config_upload',
    sourceKey: 'root/handbook.md',
    text: MARKDOWN,
    filename: 'handbook.md',
    mimeType: 'text/markdown',
    signal: new AbortController().signal,
    ...overrides,
  } as Parameters<typeof ingest>[0]);
}

interface CtxOptions {
  signal?: AbortSignal;
  now?: () => number;
  deadlineAt?: number;
}

function makeCtx(options: CtxOptions = {}): StageContext {
  const deps = getIngestDeps();
  const signal = options.signal ?? new AbortController().signal;
  const db = deps.db();
  if (!db) throw new Error('fake db missing');
  return {
    input: {
      scope,
      source: 'config_upload',
      sourceKey: 'root/handbook.md',
      text: MARKDOWN,
      filename: 'handbook.md',
      mimeType: 'text/markdown',
      signal,
    },
    deps,
    writer: createIngestWriter({ db, scope, signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal,
    deadline: options.deadlineAt ?? deps.now() + 50000,
    state: emptyIngestState(),
    warnings: [],
    identity: null,
    document: null,
    parserUsed: null,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  };
}

function recordingStage(
  name: StageName,
  order: string[],
  options: { minMsNeeded?: number; run?: (ctx: StageContext) => Promise<void> | void } = {},
): StageSpec {
  return {
    name,
    minMsNeeded: options.minMsNeeded ?? 0,
    async run(ctx) {
      order.push(name);
      await options.run?.(ctx);
      return { kind: 'next' };
    },
  };
}

function allRecordingStages(order: string[], overrides: Partial<Record<StageName, Parameters<typeof recordingStage>[2]>> = {}): StageSpec[] {
  const stages = INGEST_STAGES.map((name) => {
    if (name === 'file_hash_dedup') {
      return recordingStage(name, order, {
        ...overrides[name],
        run: async (ctx) => {
          ctx.document = { id: FAKE_DOCUMENT_ID, version: 1, resumed: false };
          await overrides[name]?.run?.(ctx);
        },
      });
    }
    if (name === 'publish') {
      return {
        name,
        minMsNeeded: overrides[name]?.minMsNeeded ?? 0,
        async run(): Promise<{ kind: 'done'; result: IngestResult }> {
          order.push(name);
          return { kind: 'done', result: { status: 'ready', documentId: FAKE_DOCUMENT_ID, version: 1, parserUsed: null, chunkCount: 0, warnings: [] } };
        },
      } satisfies StageSpec;
    }
    return recordingStage(name, order, overrides[name]);
  });
  return stages;
}

function writtenChunks(calls: RecordedRpc[]): Array<Record<string, unknown>> {
  return callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, unknown>>);
}

describe('runner: ordered stages, deadline, state and resume', () => {
  test('ingest persists the stage state after every stage once the document row exists, in D-02 order', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload();

    expect(result.status).toBe('ready');
    expect(savedStages(calls)).toEqual(INGEST_STAGES.slice(1));
    const saves = callsOf(calls, 'rag_save_ingest_state');
    expect(saves.slice(0, -1).every((call) => call.args.p_processing_status === 'processing')).toBe(true);
    expect(saves.at(-1)?.args.p_processing_status).toBe('ready');
  });

  test('a fake stage list runs in order and each stage checks the deadline first', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });
    const order: string[] = [];

    const result = await runIngestStages(makeCtx(), allRecordingStages(order));

    expect(result.status).toBe('ready');
    expect(order).toEqual([...INGEST_STAGES]);
  });

  test('a stage that needs more time than remains yields processing with the document id and does not run', async () => {
    const { db, calls } = fakeIngestDb();
    let clock = 1_000_000;
    installIngestDeps({ db, now: () => clock });
    const order: string[] = [];
    const ctx = makeCtx({ deadlineAt: clock + 5000 });

    const result = await runIngestStages(
      ctx,
      allRecordingStages(order, {
        file_hash_dedup: {},
        scan_injection: { run: () => void (clock += 1000) },
        chunk: { minMsNeeded: 10_000 },
      }),
    );

    expect(result.status).toBe('processing');
    expect(result.documentId).toBe(FAKE_DOCUMENT_ID);
    expect(result.reason).toBe('deadline');
    expect(order).not.toContain('chunk');
    expect(order.at(-1)).toBe('scan_injection');
    expect(ctx.state.lastCompleted).toBe('scan_injection');
    expect(savedStages(calls).at(-1)).toBe('scan_injection');
    expect(callsOf(calls, 'rag_mark_document_failed')).toHaveLength(0);
  });

  test('a deadline that is gone before the document row exists ends failed, not processing', async () => {
    const { db, calls } = fakeIngestDb();
    const clock = 2_000_000;
    installIngestDeps({ db, now: () => clock });
    const order: string[] = [];

    const result = await runIngestStages(makeCtx({ deadlineAt: clock - 1 }), allRecordingStages(order, { identify: { minMsNeeded: 5 } }));

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('deadline_exceeded');
    expect(result.documentId).toBeNull();
    expect(order).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a stage that yields keeps its slice of the state and the last completed stage', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });
    const stages = allRecordingStages([]);
    const parseIndex = stages.findIndex((stage) => stage.name === 'parse');
    stages[parseIndex] = {
      name: 'parse',
      minMsNeeded: 0,
      async run(ctx) {
        ctx.state.parseJob = { parser: 'fake', jobId: 'job-1', submittedAt: '2026-01-01T00:00:00.000Z', attempt: 1 };
        return { kind: 'yield', reason: 'parse_pending' };
      },
    };

    const result = await runIngestStages(makeCtx(), stages);

    expect(result.status).toBe('processing');
    expect(result.reason).toBe('parse_pending');
    const last = callsOf(calls, 'rag_save_ingest_state').at(-1);
    const state = (last?.args.p_state ?? {}) as Record<string, unknown>;
    expect(state.lastCompleted).toBe('store_original');
    expect(state.parseJob).toMatchObject({ jobId: 'job-1' });
    expect(last?.args.p_processing_status).toBe('processing');
  });

  test('resuming after chunk runs enrich through publish only', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });
    const order: string[] = [];
    const ctx = makeCtx();
    ctx.document = { id: FAKE_DOCUMENT_ID, version: 1, resumed: true };
    ctx.state.lastCompleted = 'chunk';

    const result = await runIngestStages(ctx, allRecordingStages(order));

    expect(result.status).toBe('ready');
    expect(order).toEqual(['enrich', 'extract', 'images', 'embed', 'write', 'publish']);
  });

  test('resuming the same state twice writes the same chunk ids and rows', async () => {
    const drafts: ChunkDraft[] = ['alpha section text', 'beta section text'].map((content, index) => ({
      content,
      section_path: [`Part ${index + 1}`],
      chunk_kind: 'text',
      page_start: null,
      page_end: null,
      metadata: { chunk_index: index },
    }));

    const runResume = async (): Promise<RecordedRpc[]> => {
      const { db, calls } = fakeIngestDb();
      installIngestDeps({ db });
      const ctx = makeCtx();
      await identifyStage.run(ctx);
      ctx.document = { id: FAKE_DOCUMENT_ID, version: 1, resumed: true };
      ctx.parserUsed = 'text';
      ctx.work.parseText = MARKDOWN;
      ctx.work.chunks = drafts.map((draft) => ({ ...draft, metadata: { ...draft.metadata } }));
      ctx.state.lastCompleted = 'images';
      const result = await runIngestStages(ctx);
      expect(result.status).toBe('ready');
      expect(result.chunkCount).toBe(2);
      return calls;
    };

    const first = await runResume();
    const second = await runResume();

    for (const calls of [first, second]) {
      expect(callsOf(calls, 'rag_begin_document_version')).toHaveLength(0);
      expect(callsOf(calls, 'rag_set_document_fields')).toHaveLength(0);
    }
    const writes = (calls: RecordedRpc[]) =>
      callsOf(calls, 'rag_write_chunks').map((call) => ({
        document: call.args.p_document_id,
        indexes: (call.args.p_chunks as Array<{ chunk_index: number }>).map((chunk) => chunk.chunk_index),
        final: call.args.p_final,
        total: call.args.p_total,
      }));
    expect(writes(first)).toEqual([{ document: FAKE_DOCUMENT_ID, indexes: [0, 1], final: true, total: 2 }]);
    expect(writes(second)).toEqual(writes(first));
  });

  test('an aborted signal stops before the next stage and the version is marked failed with reason aborted', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });
    const controller = new AbortController();
    const order: string[] = [];

    const result = await runIngestStages(
      makeCtx({ signal: controller.signal }),
      allRecordingStages(order, { file_hash_dedup: { run: () => controller.abort() } }),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('aborted');
    expect(order).toEqual(['identify', 'file_hash_dedup']);
    expect(callsOf(calls, 'rag_mark_document_failed').map((call) => call.args.p_reason)).toEqual(['aborted']);
  });

  test('a stage that throws marks the version failed with <stage>_failed and keeps its message out of the result', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });
    const order: string[] = [];

    const result = await runIngestStages(
      makeCtx(),
      allRecordingStages(order, {
        chunk: {
          run: () => {
            throw new Error('private document phrase heliotrope');
          },
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('chunk_failed');
    expect(JSON.stringify(result)).not.toContain('heliotrope');
    expect(callsOf(calls, 'rag_mark_document_failed').map((call) => call.args.p_reason)).toEqual(['chunk_failed']);
  });
});

describe('registered stages and their switched-off behaviour', () => {
  test('enrich gives every chunk lexical_text, a chunk content hash and the URL metadata keys; the document gets its language', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload();

    expect(result.status).toBe('ready');
    const chunks = writtenChunks(calls);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      const content = chunk.content as string;
      const path = chunk.section_path as string[];
      expect(chunk.lexical_text).toBe(lexicalText(path, content));
      expect(chunk.content_hash).toBe(contentHash(content));
      expect(chunk.metadata).toEqual(
        expect.objectContaining({ urls: expect.any(Array), has_urls: expect.any(Boolean), url_count: expect.any(Number), url_categories: expect.any(Array) }),
      );
    }
    const withUrl = chunks.find((chunk) => (chunk.content as string).includes(URL_TEXT));
    expect(withUrl?.metadata).toMatchObject({ has_urls: true, url_count: 1, url_categories: ['documentation'] });
    const without = chunks.find((chunk) => !(chunk.content as string).includes(URL_TEXT));
    expect(without?.metadata).toMatchObject({ has_urls: false, url_count: 0, urls: [] });
    const languageWrites = callsOf(calls, 'rag_set_document_fields')
      .map((call) => call.args.p_fields as Record<string, unknown>)
      .filter((fields) => 'language' in fields);
    expect(languageWrites.map((fields) => fields.language)).toEqual(['en']);
  });

  test('extract records extractor_unavailable only for profile extractors without an implementation and leaves urls to enrich', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    const general = await upload();
    const financial = await upload({ docType: 'financial_report', sourceKey: 'root/report.md' });
    const invoice = await upload({ docType: 'invoice_receipt', sourceKey: 'root/invoice.md' });

    expect(general.warnings.filter((warning) => warning.startsWith('extractor_unavailable'))).toEqual([]);
    expect(financial.warnings.filter((warning) => warning.startsWith('extractor_unavailable'))).toEqual([]);
    expect(invoice.warnings).toContain('extractor_unavailable:invoice');
  });

  test('store_original records no_object_store and writes nothing to a store', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload();

    expect(result.warnings).toContain('no_object_store');
  });

  test('scan_injection passes when RAG_INJECTION_SCAN is off', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_INJECTION_SCAN: 'off' } });

    const result = await upload();

    expect(result.status).toBe('ready');
  });

  test('scan_injection fails the run closed with injection_scan_unavailable when RAG_INJECTION_SCAN is quarantine', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_INJECTION_SCAN: 'quarantine' } });

    const result = await upload();

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('injection_scan_unavailable');
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(0);
    expect(callsOf(calls, 'rag_publish_document_version')).toHaveLength(0);
    expect(callsOf(calls, 'rag_mark_document_failed').map((call) => call.args.p_reason)).toEqual(['injection_scan_unavailable']);
  });

  test('images passes with RAG_PDF_IMAGE_CHUNKS false and warns without failing when it is true but no captioner exists yet', async () => {
    const off = fakeIngestDb();
    installIngestDeps({ db: off.db, env: { RAG_PDF_IMAGE_CHUNKS: 'false' } });
    const disabled = await upload();

    const on = fakeIngestDb();
    installIngestDeps({ db: on.db, env: { RAG_PDF_IMAGE_CHUNKS: 'true' } });
    const enabled = await upload();

    expect(disabled.status).toBe('ready');
    expect(disabled.warnings).not.toContain('image_chunks_unavailable');
    expect(enabled.status).toBe('ready');
    expect(enabled.warnings).toContain('image_chunks_unavailable');
  });
});
