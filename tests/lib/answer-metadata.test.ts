import { beforeEach, describe, expect, it } from 'vitest';
import { extractStreamAnswerMetadata, mergeAnswerRecord } from '@/lib/chat/answer-metadata';
import { useAnswerRecordsStore } from '@/lib/stores/answer-records-store';
import { AnswerRecordSchema, type AnswerRecord } from '@/lib/rag-eval/contracts.generated';
import type { ExtendedMessage } from '@/types/chat';

const ANSWER_ID = '7d3f0a52-4c1e-4b7a-9d55-2f1c8e6b9a01';
const OTHER_ID = '0b9e2c4a-1f3d-4e5b-8a6c-7d8e9f0a1b2c';
const TRACE = 'f'.repeat(32);

const CITATION = {
  alias: 'S1',
  chunkIds: ['chunk-1'],
  documentId: 'doc-1',
  documentName: 'handbook.md',
  documentVersion: 1,
  n: 1,
  page: null,
  quote: 'Refunds are accepted within 30 days.',
  quoteHash: 'b'.repeat(64),
  sectionPath: null,
  strategy: 'chunk-alias',
};

function record(overrides: Partial<Record<string, unknown>> = {}): AnswerRecord {
  return AnswerRecordSchema.parse({
    answerId: ANSWER_ID,
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:00:05.000Z',
    modelId: 'openai/gpt-4o-mini',
    ragMode: 'strict',
    traceId: TRACE,
    groundedness: { status: 'scored', label: 'verified', score: 0.93, scorer: 'hhem_2_1_open' },
    feedback: { vote: 'helpful', updatedAt: '2026-11-25T10:01:00.000Z' },
    ...overrides,
  });
}

function assistant(id: string, metadata?: Record<string, unknown>): ExtendedMessage {
  return { id, role: 'assistant', content: 'answer', ...(metadata ? { metadata } : {}) };
}

describe('extractStreamAnswerMetadata', () => {
  it('returns the validated subset of the stream metadata', () => {
    expect(
      extractStreamAnswerMetadata({
        ragTraceId: TRACE,
        answerId: ANSWER_ID,
        citations: [CITATION, { alias: 'bad' }],
        citationStrategy: 'chunk-alias',
        invalidCitations: 2,
        multiStep: { steps: 2 },
        groundedness: { status: 'scored' },
      }),
    ).toEqual({ ragTraceId: TRACE, answerId: ANSWER_ID, citations: [CITATION], citationStrategy: 'chunk-alias', invalidCitations: 2 });
  });

  it('combines a start part with only answerId and a finish part with citations', () => {
    const start = extractStreamAnswerMetadata({ ragTraceId: TRACE, answerId: ANSWER_ID });
    const combined = extractStreamAnswerMetadata({ citations: [CITATION], citationStrategy: 'chunk-alias', invalidCitations: 0 }, start);
    expect(combined).toEqual({ ragTraceId: TRACE, answerId: ANSWER_ID, citations: [CITATION], citationStrategy: 'chunk-alias', invalidCitations: 0 });
  });

  it('ignores non-object metadata and malformed ids', () => {
    expect(extractStreamAnswerMetadata(undefined)).toEqual({});
    expect(extractStreamAnswerMetadata('x')).toEqual({});
    expect(extractStreamAnswerMetadata({ answerId: 'nope', ragTraceId: '' })).toEqual({});
  });
});

describe('mergeAnswerRecord', () => {
  it('sets groundedness and feedback on the message whose answerId matches', () => {
    const messages = [assistant('a-0', { answerId: OTHER_ID }), assistant('a-1', { ragTraceId: TRACE, answerId: ANSWER_ID })];
    const rec = record();
    const merged = mergeAnswerRecord(messages, rec);
    expect(merged).not.toBe(messages);
    expect(merged[0]).toBe(messages[0]);
    expect(merged[1].metadata).toEqual({ ragTraceId: TRACE, answerId: ANSWER_ID, groundedness: rec.groundedness, feedback: rec.feedback });
  });

  it('returns the same array instance when nothing changes', () => {
    const rec = record();
    const messages = [assistant('a-1', { answerId: ANSWER_ID, groundedness: rec.groundedness, feedback: rec.feedback })];
    expect(mergeAnswerRecord(messages, rec)).toBe(messages);
    const unrelated = [assistant('a-2', { answerId: OTHER_ID }), { id: 'u-1', role: 'user', content: 'q' } as ExtendedMessage];
    expect(mergeAnswerRecord(unrelated, rec)).toBe(unrelated);
  });

  it('removes stored feedback when the record has none', () => {
    const rec = record({ feedback: null });
    const messages = [assistant('a-1', { answerId: ANSWER_ID, feedback: { vote: 'helpful', updatedAt: 'x' } })];
    const merged = mergeAnswerRecord(messages, rec);
    expect(merged[0].metadata).toEqual({ answerId: ANSWER_ID, groundedness: rec.groundedness });
  });
});

describe('useAnswerRecordsStore', () => {
  beforeEach(() => useAnswerRecordsStore.setState({ records: {} }));

  it('keeps the latest updatedAt per answerId', () => {
    const { upsert, upsertMany } = useAnswerRecordsStore.getState();
    const newer = record({ updatedAt: '2026-11-25T10:00:09.000Z' });
    const older = record({ updatedAt: '2026-11-25T10:00:01.000Z', groundedness: { status: 'pending' } });
    upsert(newer);
    upsert(older);
    expect(useAnswerRecordsStore.getState().records[ANSWER_ID]).toEqual(newer);
    const other = record({ answerId: OTHER_ID });
    upsertMany([other, record({ updatedAt: '2026-11-25T10:00:10.000Z' })]);
    const records = useAnswerRecordsStore.getState().records;
    expect(Object.keys(records).sort()).toEqual([OTHER_ID, ANSWER_ID].sort());
    expect(records[ANSWER_ID].updatedAt).toBe('2026-11-25T10:00:10.000Z');
  });

  it('keeps the state object when an upsert changes nothing', () => {
    const rec = record();
    useAnswerRecordsStore.getState().upsert(rec);
    const before = useAnswerRecordsStore.getState().records;
    useAnswerRecordsStore.getState().upsert(record({ updatedAt: '2026-11-25T10:00:00.000Z' }));
    expect(useAnswerRecordsStore.getState().records).toBe(before);
  });
});
