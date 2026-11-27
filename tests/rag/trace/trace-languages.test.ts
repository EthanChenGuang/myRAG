import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ tasks: [] as Array<() => Promise<void>> }));

vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));

import { buildRetrievalLogRow } from '@/lib/rag/feedback-loop/retrieval-log';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import { finishTrace } from '@/lib/rag/trace/finish';
import { resetLangfuseForTests } from '@/lib/rag/trace/langfuse';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import type { Candidate, KeptChunk, RetrievalResult } from '@/lib/rag/types';
import { startFakeLangfuse, type FakeLangfuse } from '../../helpers/fake-langfuse.mts';

const TENANT = 'u:00000000-0000-4000-8000-000000000001';
const QUERY_ZH = '这是一个用于测试的中文问题吗';
const CHUNK_ZH = '中文片段标记文本';
const CHUNK_EN = 'english chunk marker kestrel-9042';
const CHUNK_NONE = 'chunk without language marker osprey-5517';
const CHUNK_IT = 'frammento italiano scartato';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const ATTR = 'langfuse.observation.metadata.';
const LANGFUSE_OFF: LangfuseConfig = { enabled: false, publicKey: '', secretKey: '', baseUrl: '', sampleRate: 0, reviewSampleRate: 0, captureContent: false };
const TraceLanguagesSchema = RagTraceSchema.shape.languages;

let fake: FakeLangfuse;

beforeAll(async () => {
  fake = await startFakeLangfuse();
});

afterAll(async () => {
  await fake?.close();
});

beforeEach(async () => {
  h.tasks.length = 0;
  fake.reset();
  await resetLangfuseForTests();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  fake.release();
  await resetLangfuseForTests();
});

function candidate(id: string, content: string, language?: string): Candidate {
  return { chunk_id: id, document_id: DOC, content, similarity: 0.8, ...(language !== undefined ? { language } : {}) } as Candidate;
}

function kept(id: string, content: string, rank: number): KeptChunk {
  return { chunk_id: id, document_id: DOC, document_name: 'notes.md', content, similarity: 0.8, rank, kept_by: 'similarity' } as KeptChunk;
}

/** A zh query whose kept chunks are zh, en and one without a language; an it candidate is retrieved but not kept. */
function zhResult(traceId: string, answerLanguage: string | null = 'zh'): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [candidate('c-zh', CHUNK_ZH, 'zh'), candidate('c-it', CHUNK_IT, 'it'), candidate('c-en', CHUNK_EN, 'en'), candidate('c-none', CHUNK_NONE)],
    context: `${CHUNK_ZH}\n${CHUNK_EN}\n${CHUNK_NONE}`,
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [kept('c-zh', CHUNK_ZH, 1), kept('c-en', CHUNK_EN, 2), kept('c-none', CHUNK_NONE, 3)],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId,
    queryContext: null,
    queryLanguage: 'zh',
    logOutcome: { value: 'answered', pipeline: 'v2', answerLanguage },
  } as RetrievalResult;
}

function traced() {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: TENANT });
  collector.record({ name: 'search', status: 'ok', startedAt: collector.startedAt, endedAt: collector.startedAt + 4, candidatesOut: 4 });
  return { collector, result: zhResult(collector.traceId) };
}

function logPayload(lines: string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{'))) as Record<string, unknown>;
}

async function drain(): Promise<void> {
  while (h.tasks.length > 0) await h.tasks.shift()!();
}

const EXPECTED = { query_language: 'zh', query_language_confidence: 1, chunk_languages: ['zh', 'en', 'und'], answer_language: 'zh' };

describe('trace languages block (LANG-10)', () => {
  test('the [RAG Trace] line carries the kept chunks languages in rank order, und for a chunk without one', () => {
    const { collector, result } = traced();
    const lines: string[] = [];
    finishTrace(collector, result, { config: LANGFUSE_OFF, sink: (line) => lines.push(line), query: QUERY_ZH });
    const payload = logPayload(lines);
    expect(payload.languages).toEqual(EXPECTED);
    expect(TraceLanguagesSchema.safeParse(payload.languages).success).toBe(true);
  });

  test('the block is the same as the retrieval log stores for the same request', () => {
    const { collector, result } = traced();
    const lines: string[] = [];
    finishTrace(collector, result, { config: LANGFUSE_OFF, sink: (line) => lines.push(line), logQuery: QUERY_ZH });
    const row = buildRetrievalLogRow({
      result,
      tenantKey: TENANT,
      stageLatency: collector.toStageLatency(),
      latencyMs: 4,
      logContext: { channel: 'chat' },
      mode: 'ids',
      query: QUERY_ZH,
    });
    const payload = logPayload(lines);
    expect(payload.languages).toEqual({
      query_language: row.query_language,
      query_language_confidence: row.query_language_confidence,
      chunk_languages: row.chunk_languages,
      answer_language: row.answer_language,
    });
    expect((payload.languages as { chunk_languages: string[] }).chunk_languages).not.toContain('it');
  });

  test('a value that is not a code is left out: null for the query and answer, und for a chunk', () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: TENANT });
    const result = zhResult(collector.traceId, 'an answer sentence, not a code');
    result.queryLanguage = 'Not A Code';
    result.candidates[0] = candidate('c-zh', CHUNK_ZH, 'Chinese text here');
    const lines: string[] = [];
    finishTrace(collector, result, { config: LANGFUSE_OFF, sink: (line) => lines.push(line) });
    expect(logPayload(lines).languages).toEqual({ query_language: null, query_language_confidence: null, chunk_languages: ['und', 'en'], answer_language: null });
  });

  test('nothing in the block is text: no query, chunk or answer content reaches the log line', () => {
    const { collector, result } = traced();
    const lines: string[] = [];
    finishTrace(collector, result, { config: LANGFUSE_OFF, sink: (line) => lines.push(line), query: QUERY_ZH });
    for (const marker of [QUERY_ZH, CHUNK_ZH, CHUNK_EN, CHUNK_NONE, CHUNK_IT]) expect(lines[0]).not.toContain(marker);
  });

  test('the Langfuse root observation carries the block as metadata, with an answer language set after finishTrace', async () => {
    const { collector, result } = traced();
    result.logOutcome!.answerLanguage = null;
    const config: LangfuseConfig = { enabled: true, publicKey: 'pk-lf-placeholder-0000', secretKey: 'sk-lf-placeholder-0000', baseUrl: fake.url, sampleRate: 1, reviewSampleRate: 0, captureContent: false };
    finishTrace(collector, result, { config, query: QUERY_ZH, flushTimeoutMs: 3000 });
    result.logOutcome!.answerLanguage = 'zh';
    await drain();
    const root = fake.spans.find((span) => span.name === 'rag-request');
    expect(root).toBeDefined();
    const attributes = root!.attributes;
    const read = (key: string): unknown => {
      const value = attributes[`${ATTR}${key}`];
      return typeof value === 'string' ? JSON.parse(value) : value;
    };
    expect(read('query_language')).toBe('zh');
    expect(read('query_language_confidence')).toBe(1);
    expect(read('chunk_languages')).toEqual(['zh', 'en', 'und']);
    expect(read('answer_language')).toBe('zh');
    const exported = JSON.stringify(fake.spans);
    for (const marker of [QUERY_ZH, CHUNK_ZH, CHUNK_EN, CHUNK_NONE, CHUNK_IT]) expect(exported).not.toContain(marker);
  });
});
