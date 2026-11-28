import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  imported: 0,
  tasks: [] as Array<() => Promise<void>>,
  rows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ row: Record<string, unknown>; expectedTenantKey: string }>,
}));

vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));

vi.mock('@/lib/rag/feedback-loop/retrieval-log', async (importOriginal) => {
  h.imported += 1;
  const actual = await importOriginal<typeof import('@/lib/rag/feedback-loop/retrieval-log')>();
  return {
    ...actual,
    buildRetrievalLogRow: (input: Parameters<typeof actual.buildRetrievalLogRow>[0]) => {
      const row = actual.buildRetrievalLogRow(input);
      h.rows.push(row as Record<string, unknown>);
      return row;
    },
    writeRetrievalLog: async (row: Record<string, unknown>, options: { expectedTenantKey: string }) => {
      h.writes.push({ row, expectedTenantKey: options.expectedTenantKey });
    },
  };
});

import { runRetrieval } from '@/lib/rag';
import { failure } from '@/lib/rag/pipeline';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { finishTrace } from '@/lib/rag/trace/finish';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { LogContext, Profile, RetrievalResult } from '@/lib/rag/types';
import type { RagEnvInput } from '@/lib/rag/config';
import { SEMANTIC_QUERY, adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps } from '../helpers/pipeline-fakes';

const USER = '11111111-1111-4111-8111-111111111111';
const CHAT = '44444444-4444-4444-8444-444444444444';
const LANGFUSE_OFF: LangfuseConfig = { enabled: false, publicKey: '', secretKey: '', baseUrl: '', sampleRate: 0, reviewSampleRate: 0, captureContent: false };
const savedMode = process.env.RAG_RETRIEVAL_LOG;

function context(overrides: Partial<LogContext> = {}): LogContext {
  return { userId: USER, chatId: CHAT, channel: 'chat', ragMode: 'strict', ...overrides };
}

function traced(profile: Profile) {
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const result = failure(collector, 'ok', 'ok', null);
  return { collector, result };
}

async function drain(): Promise<void> {
  while (h.tasks.length > 0) await h.tasks.shift()!();
}

function finish(profile: Profile, logContext: LogContext | undefined, sink: string[] = []): RetrievalResult {
  const { collector, result } = traced(profile);
  finishTrace(collector, result, { config: LANGFUSE_OFF, sink: (line) => sink.push(line), query: SEMANTIC_QUERY, ...(logContext ? { logContext } : {}) });
  return result;
}

beforeEach(() => {
  h.tasks.length = 0;
  h.rows.length = 0;
  h.writes.length = 0;
  h.imported = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
  if (savedMode === undefined) delete process.env.RAG_RETRIEVAL_LOG;
  else process.env.RAG_RETRIEVAL_LOG = savedMode;
});

describe('finishTrace retrieval log hook (D-04, D-05)', () => {
  it('never schedules, imports or calls the writer when the log is off, for every profile', async () => {
    delete process.env.RAG_RETRIEVAL_LOG;
    const lines: string[] = [];
    for (const profile of ['chat', 'embed', 'voice', 'eval', 'media'] as const) finish(profile, context(), lines);
    expect(h.tasks).toHaveLength(0);
    await drain();
    expect(h.imported).toBe(0);
    expect(h.writes).toHaveLength(0);
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.startsWith('[RAG Trace] '))).toBe(true);
  });

  it('writes one row each for chat, embed and voice and none for eval and media', async () => {
    process.env.RAG_RETRIEVAL_LOG = 'ids';
    for (const profile of ['chat', 'embed', 'voice'] as const) finish(profile, context({ channel: profile }));
    for (const profile of ['eval', 'media'] as const) finish(profile, context());
    await drain();
    expect(h.writes.map((write) => write.row.channel)).toEqual(['chat', 'embed', 'voice']);
    expect(h.writes.every((write) => write.expectedTenantKey === 's:default')).toBe(true);
  });

  it('writes nothing for a skipped request, a ghost chat or a context without a channel', async () => {
    process.env.RAG_RETRIEVAL_LOG = 'masked_query';
    finish('chat', context({ skip: true }));
    finish('chat', context({ chatId: 'ghost-123' }));
    finish('chat', { userId: USER, chatId: CHAT });
    finish('chat', undefined);
    await drain();
    expect(h.writes).toHaveLength(0);
  });

  it('records the outcome and answer language the route sets after finishTrace, also through a spread copy', async () => {
    process.env.RAG_RETRIEVAL_LOG = 'ids';
    const first = finish('chat', context());
    first.logOutcome!.value = 'refused_no_context';

    const second = finish('chat', context());
    const copy = { ...second, status: 'degraded' as const };
    copy.logOutcome!.answerLanguage = 'en';
    copy.logOutcome!.value = 'degraded_answer';

    await drain();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]!.row).toMatchObject({ outcome: 'refused_no_context', answer_language: null });
    expect(h.writes[1]!.row).toMatchObject({ outcome: 'degraded_answer', answer_language: 'en' });
  });

  it('keeps the [RAG Trace] line when the log is on', async () => {
    process.env.RAG_RETRIEVAL_LOG = 'ids';
    const lines: string[] = [];
    finish('chat', context(), lines);
    await drain();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[RAG Trace\] /);
    expect(h.writes).toHaveLength(1);
  });
});

describe('runRetrieval logs when it owns the trace (D-07)', () => {
  const scope = mintScope('single', null, null);

  function install(env: RagEnvInput = {}) {
    const rpc = fakeRpcClient({ rows: rows(3) });
    installDeps({
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({ RAG_DISABLED_STAGES: 'voice_keyword_fallback', ...env }),
      adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    });
  }

  it('writes a voice row with the voice channel only when a log context is passed', async () => {
    process.env.RAG_RETRIEVAL_LOG = 'ids';
    install();
    await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'voice', signal: new AbortController().signal });
    await drain();
    expect(h.writes).toHaveLength(0);

    await runRetrieval({
      scope,
      query: SEMANTIC_QUERY,
      profile: 'voice',
      signal: new AbortController().signal,
      logContext: { channel: 'voice', userId: USER },
    });
    await drain();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.row).toMatchObject({ channel: 'voice', user_id: USER, pipeline: 'legacy', outcome: 'unknown' });
  });

  it('gives every returned result an unknown holder on the legacy, voice, media, overview, v2 and failure paths', async () => {
    delete process.env.RAG_RETRIEVAL_LOG;
    install();
    const signal = new AbortController().signal;
    const results = [
      await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'chat', signal }),
      await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'voice', signal }),
      await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'media', signal }),
      await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'chat', signal, options: { generalOverview: true } }),
      await runRetrieval({ scope: null, query: SEMANTIC_QUERY, profile: 'chat', signal }),
    ];
    install({ RAG_PIPELINE: 'v2' });
    results.push(await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'chat', signal }));
    for (const result of results) expect(result.logOutcome).toMatchObject({ value: 'unknown', answerLanguage: null });
    expect(results.slice(0, 5).map((result) => result.logOutcome!.pipeline)).toEqual(['legacy', 'legacy', 'legacy', 'legacy', 'legacy']);
    expect(results[5]!.logOutcome!.pipeline).toBe('v2');
    expect(new Set(results.map((result) => result.logOutcome)).size).toBe(results.length);
    await drain();
    expect(h.imported).toBe(0);
  });
});
