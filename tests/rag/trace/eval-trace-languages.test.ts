import { describe, expect, test } from 'vitest';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { buildTraceLogPayload } from '@/lib/rag/trace/log';
import { evalTraceLanguages } from '@/lib/rag-eval/trace';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import type { Candidate, KeptChunk, RetrievalResult } from '@/lib/rag/types';

const DOC = '00000000-0000-4000-8000-0000000000d1';
const TraceLanguagesSchema = RagTraceSchema.shape.languages;

function result(language: string, overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  const candidates = [
    { chunk_id: 'c1', document_id: DOC, content: 'synthetic chunk one', similarity: 0.9, language },
    { chunk_id: 'c2', document_id: DOC, content: 'synthetic chunk two', similarity: 0.8, language: 'en' },
  ] as Candidate[];
  const kept = candidates.map((item, index) => ({ ...item, document_name: 'notes.md', rank: index + 1, kept_by: 'similarity' })) as KeptChunk[];
  return {
    status: 'ok',
    reason: 'ok',
    candidates,
    context: 'synthetic chunk one\nsynthetic chunk two',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept,
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId: 'unused',
    queryContext: null,
    queryLanguage: language,
    logOutcome: { value: 'unknown', pipeline: 'v2', answerLanguage: null },
    ...overrides,
  } as RetrievalResult;
}

describe('eval RagTrace languages (LANG-10)', () => {
  test.each([
    ['zh', '这是一个用于测试的中文问题吗'],
    ['en', 'what does the synthetic sample section describe'],
    ['it', 'che cosa descrive la sezione di esempio sintetica'],
  ])('a %s fixture item carries a languages block validated by TraceLanguages', (language, query) => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const field = evalTraceLanguages({ collector, result: result(language), query, answerLanguage: language });
    expect(field.languages).toMatchObject({ query_language: language, chunk_languages: language === 'en' ? ['en'] : [language, 'en'], answer_language: language });
    expect(TraceLanguagesSchema.safeParse(field.languages).success).toBe(true);
    expect(JSON.stringify(field)).not.toContain(query);
  });

  test('the eval block is the collector block the [RAG Trace] line carries', () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const retrieval = result('it');
    const field = evalTraceLanguages({ collector, result: retrieval, query: 'domanda sintetica', answerLanguage: null });
    expect(buildTraceLogPayload(collector, retrieval).languages).toEqual(field.languages);
    expect(field.languages?.answer_language).toBeNull();
  });
});
