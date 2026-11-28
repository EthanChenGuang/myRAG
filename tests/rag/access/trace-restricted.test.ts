import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectedTrace } from '@/lib/rag/trace/langfuse';

const exported = vi.hoisted(() => [] as CollectedTrace[]);
vi.mock('@/lib/rag/trace/langfuse', () => ({
  exportTrace: async (trace: CollectedTrace) => {
    exported.push(trace);
  },
}));

import { accessSetsFor, createTraceCollector, finishTrace, UNKNOWN_ACCESS_SET } from '@/lib/rag';
import { buildTraceLogPayload } from '@/lib/rag/trace/log';
import { stripRestrictedContent } from '@/lib/rag/trace/mask';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { KeptChunk, RetrievalResult } from '@/lib/rag/types';
import { createDocumentReferenceTool, NEUTRAL_REFERENCE_RESULT } from '@/lib/chat/document-reference-tool';

const GROUP = 'g:00000000-0000-4000-8000-0000000000f1';
const SET_HASH = 'abcdef0123456789'.repeat(4);
const OPEN_TEXT = 'Synthetic open sentence about the sample topic.';
const HIDDEN_TEXT = 'Synthetic restricted sentence marker 7731.';

function kept(id: string, documentId: string, content: string, rank: number): KeptChunk {
  return { chunk_id: id, document_id: documentId, document_name: `${documentId}.txt`, content, similarity: 0.9 - rank / 10, rank, kept_by: 'rank' as KeptChunk['kept_by'] };
}

function result(labels?: Map<string, readonly string[]>): RetrievalResult {
  const value = {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [kept('chunk-open', 'doc-open', OPEN_TEXT, 1), kept('chunk-hidden', 'doc-hidden', HIDDEN_TEXT, 2)],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId: 'unused',
    queryContext: null,
  } as unknown as RetrievalResult;
  if (labels) Object.defineProperty(value, 'accessLabels', { value: labels, enumerable: false });
  return value;
}

const LABELS = new Map<string, readonly string[]>([
  ['doc-open', ['all']],
  ['doc-hidden', [GROUP]],
]);

function config(overrides: Partial<LangfuseConfig>): LangfuseConfig {
  return {
    enabled: true,
    publicKey: 'pk-placeholder',
    secretKey: 'sk-placeholder',
    baseUrl: 'http://langfuse.invalid',
    sampleRate: 1,
    reviewSampleRate: 0,
    captureContent: true,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  exported.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[RAG Trace] log line access fields (D-25)', () => {
  it('carries the mode, an 8-character set-hash prefix and the violation count, never keys or group ids', () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    collector.setAccess({ mode: 'keys', setHash: SET_HASH });
    collector.addAccessViolations(2);
    const payload = buildTraceLogPayload(collector, result(LABELS));
    expect(payload).toMatchObject({ access_mode: 'keys', access_set: SET_HASH.slice(0, 8), access_violations: 2 });
    const line = JSON.stringify(payload);
    expect(line).not.toContain(SET_HASH);
    expect(line).not.toContain(GROUP);
    expect(line).not.toContain('g:');
  });

  it('has no access field while access is off', () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    collector.addAccessViolations(3);
    const payload = buildTraceLogPayload(collector, result());
    expect(Object.keys(payload).filter((key) => key.startsWith('access'))).toEqual([]);
  });
});

describe('Langfuse export of restricted content (D-25)', () => {
  it('exports ids and scores only for a kept chunk of a restricted document', async () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    collector.setAccess({ mode: 'keys', setHash: SET_HASH });
    finishTrace(collector, result(LABELS), { config: config({}), query: 'sample question' });
    await settle();
    expect(exported).toHaveLength(1);
    const chunks = exported[0].content?.chunks ?? [];
    expect(chunks[0]).toEqual({ document_name: 'doc-open.txt', content: OPEN_TEXT, similarity: expect.any(Number), rank: 1 });
    expect(chunks[1]).toEqual({ chunk_id: 'chunk-hidden', similarity: expect.any(Number), rank: 2 });
    expect(JSON.stringify(exported[0])).not.toContain(HIDDEN_TEXT);
    expect(JSON.stringify(exported[0])).not.toContain('doc-hidden.txt');
  });

  it('treats a document without a known label set as restricted while access is on', async () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    collector.setAccess({ mode: 'keys', setHash: SET_HASH });
    finishTrace(collector, result(new Map([['doc-open', ['all']]])), { config: config({}) });
    await settle();
    expect(JSON.stringify(exported[0])).not.toContain(HIDDEN_TEXT);
  });

  it('drops query, context and answer from a review export when a restricted chunk was kept', async () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    collector.setAccess({ mode: 'keys', setHash: SET_HASH });
    collector.setReviewContent({ answer: `answer ${HIDDEN_TEXT}`, context: HIDDEN_TEXT, model: 'test/model' });
    finishTrace(collector, result(LABELS), { config: config({ sampleRate: 0, reviewSampleRate: 1 }), query: 'sample question' });
    await settle();
    expect(exported[0].review).toEqual({ model: 'test/model' });
  });

  it('exports everything as today while access is off', async () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    finishTrace(collector, result(), { config: config({}), query: 'sample question' });
    await settle();
    expect(exported[0].content).toEqual({
      query: 'sample question',
      chunks: [
        { document_name: 'doc-open.txt', content: OPEN_TEXT, similarity: expect.any(Number), rank: 1 },
        { document_name: 'doc-hidden.txt', content: HIDDEN_TEXT, similarity: expect.any(Number), rank: 2 },
      ],
    });
  });

  it('stripRestrictedContent with labels null returns the trace unchanged in content', () => {
    const trace = { review: { query: 'q', answer: 'a', context: 'c' } };
    expect(stripRestrictedContent(trace, null, result().kept)).toEqual(trace);
  });
});

describe('document reference tool built per request (D-15)', () => {
  const options = { toolCallId: 'call-1', messages: [] };

  it('answers the neutral result for a document id outside this request', async () => {
    const tool = createDocumentReferenceTool([{ id: 'doc-a', name: 'note-a.txt' }]);
    const out = await tool.execute!({ documentId: 'doc-hidden', documentName: 'hidden.txt', relevance: 80, reason: 'r' }, options);
    expect(out).toEqual(NEUTRAL_REFERENCE_RESULT);
    const known = await tool.execute!({ documentId: 'doc-a', documentName: 'x', relevance: 80, reason: 'r' }, options);
    expect(known).toMatchObject({ success: true, documentName: 'note-a.txt' });
  });

  it('two tools for two requests each accept only their own documents', async () => {
    const first = createDocumentReferenceTool([{ id: 'doc-a', name: 'note-a.txt' }]);
    const second = createDocumentReferenceTool([{ id: 'doc-b', name: 'note-b.txt' }]);
    const call = (documentId: string, documentName: string) => ({ documentId, documentName, relevance: 50, reason: 'r' });
    expect(await first.execute!(call('doc-b', 'note-b.txt'), options)).toEqual(NEUTRAL_REFERENCE_RESULT);
    expect(await second.execute!(call('doc-a', 'note-a.txt'), options)).toEqual(NEUTRAL_REFERENCE_RESULT);
    expect(await second.execute!(call('unknown', 'note-b.txt'), options)).toMatchObject({ success: true, documentName: 'note-b.txt' });
  });
});

describe('label sets for the derived stores (D-25, A-06)', () => {
  it('lists one sorted key set per document, fails closed for an unknown document and is null while off', () => {
    expect(accessSetsFor(LABELS, ['doc-hidden', 'doc-open', 'doc-open'])).toEqual([[GROUP], ['all']]);
    expect(accessSetsFor(LABELS, ['doc-missing'])).toEqual([[...UNKNOWN_ACCESS_SET]]);
    expect(accessSetsFor(undefined, ['doc-open'])).toBeNull();
  });
});
