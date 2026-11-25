import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RetrievalLogEntrySchema } from '@/lib/rag-eval/contracts.generated';
import { buildRetrievalLogRow, writeRetrievalLog, type BuildRetrievalLogRowInput } from '@/lib/rag/feedback-loop/retrieval-log';
import { detectLanguageWithConfidence } from '@/lib/rag/lang/detect';
import type { Candidate, KeptChunk, RetrievalResult } from '@/lib/rag/types';
import { recordingAdmin } from '../helpers/recording-admin';

const TRACE = 'a'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const CHAT = '44444444-4444-4444-8444-444444444444';
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const CHUNK_TEXT = 'synthetic chunk body that must never be logged';
const EN_QUERY = 'what is the status of the blue widget in the second report';
const EN_DETECTED = 'this is the first item and the second item of the list';

function docId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function candidate(index: number, extra: Partial<Candidate> = {}): Candidate {
  return {
    chunk_id: `chunk-${index}`,
    document_id: docId(index),
    content: CHUNK_TEXT,
    similarity: 0.9 - index / 1000,
    metadata: { document_name: 'synthetic.pdf' },
    temporal_score: 0,
    financial_score: 0,
    final_score: 0.5,
    match_reason: 'vector',
    ...extra,
  };
}

function kept(index: number, rank: number): KeptChunk {
  return {
    chunk_id: `chunk-${index}`,
    document_id: docId(index),
    document_name: 'synthetic.pdf',
    content: CHUNK_TEXT,
    similarity: 0.8,
    rank,
    kept_by: 'similarity' as KeptChunk['kept_by'],
  };
}

function result(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [candidate(1), candidate(2), candidate(3)],
    context: CHUNK_TEXT,
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [kept(1, 1)],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId: TRACE,
    queryContext: null,
    logOutcome: { value: 'unknown', answerLanguage: null },
    ...overrides,
  };
}

function input(overrides: Partial<BuildRetrievalLogRowInput> = {}): BuildRetrievalLogRowInput {
  return {
    result: result(),
    tenantKey: `o:${ORG_A}`,
    stageLatency: { embed: 12, search: 30 },
    latencyMs: 55,
    logContext: { userId: USER, organizationId: ORG_A, chatId: CHAT, channel: 'chat', ragMode: 'strict' },
    mode: 'ids',
    query: EN_QUERY,
    ...overrides,
  };
}

function expectValid(row: unknown): void {
  const parsed = RetrievalLogEntrySchema.safeParse(row);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
}

function expectNoText(row: Record<string, unknown>, ...texts: string[]): void {
  const { query_masked: _masked, ...rest } = row;
  const serialised = JSON.stringify(rest);
  for (const text of [CHUNK_TEXT, 'synthetic.pdf', ...texts]) expect(serialised).not.toContain(text);
}

describe('buildRetrievalLogRow (D-03, D-04)', () => {
  it('keeps at most 50 candidates with ids, ranks and scores and no content', () => {
    const candidates = Array.from({ length: 80 }, (_, index) => candidate(index + 1, index === 0 ? { rerank_score: 0.77, fused_score: 0.4 } : {}));
    const row = buildRetrievalLogRow(input({ result: result({ candidates, kept: [kept(1, 1), kept(7, 2)] }) }));
    expect(row.candidates).toHaveLength(50);
    expect(row.candidates!.map((entry) => entry.rank)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(row.candidates!.filter((entry) => entry.kept).map((entry) => entry.chunk_id)).toEqual(['chunk-1', 'chunk-7']);
    expect(row.candidates![0]).toMatchObject({ chunk_id: 'chunk-1', document_id: docId(1), rerank_score: 0.77, fused_score: 0.4 });
    for (const entry of row.candidates!) {
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('document_name');
    }
    expect(row.candidate_count).toBe(80);
    expect(row.top_score).toBeCloseTo(0.77);
    expectValid(row);
    expectNoText(row as Record<string, unknown>, EN_QUERY);
  });

  it('uses the first candidate similarity as top score without a rerank score, and null without candidates', () => {
    expect(buildRetrievalLogRow(input()).top_score).toBeCloseTo(0.899);
    expect(buildRetrievalLogRow(input({ result: result({ candidates: [], kept: [] }) })).top_score).toBeNull();
  });

  it('copies the request facts, the outcome and the trace fields', () => {
    const row = buildRetrievalLogRow(
      input({
        result: result({
          status: 'empty',
          reason: 'refused',
          retrievalConfigHash: 'h'.repeat(64),
          refusal: { decision: 'refuse', basis: 'similarity_floor', reason: null, topScore: 0.2, threshold: 0.65 } as RetrievalResult['refusal'],
          logOutcome: { value: 'refused_no_context', answerLanguage: null, pipeline: 'v2' },
        }),
      }),
    );
    expect(row).toMatchObject({
      trace_id: TRACE,
      user_id: USER,
      organization_id: ORG_A,
      chat_id: CHAT,
      channel: 'chat',
      rag_mode: 'strict',
      pipeline: 'v2',
      retrieval_config_hash: 'h'.repeat(64),
      status: 'empty',
      refusal_decision: 'refuse',
      outcome: 'refused_no_context',
      latency_ms: 55,
      stage_latency: { embed: 12, search: 30 },
    });
    expectValid(row);
  });

  it('stores a chat id that is not a UUID as null, and an unknown pipeline as legacy', () => {
    const row = buildRetrievalLogRow(input({ logContext: { userId: USER, chatId: 'chat-123', channel: 'embed' } }));
    expect(row.chat_id).toBeNull();
    expect(row.pipeline).toBe('legacy');
    expect(row.outcome).toBe('unknown');
    expectValid(row);
  });

  it('leaves the query out in ids mode', () => {
    const row = buildRetrievalLogRow(input({ query: 'mail me at someone@example.com please' }));
    expect(row.query_masked).toBeNull();
    expect(row.query_fingerprint).toBeNull();
    expectNoText(row as Record<string, unknown>, 'someone@example.com', 'mail me');
  });

  it('masks and caps the query in masked_query mode and fingerprints the normalised masked text', () => {
    const row = buildRetrievalLogRow(input({ mode: 'masked_query', query: 'Mail me at someone@example.com   please' }));
    expect(row.query_masked).toBe('Mail me at [EMAIL]   please');
    const normalised = 'mail me at [email] please';
    expect(row.query_fingerprint).toBe(createHash('sha256').update(normalised).digest('hex'));
    expectValid(row);

    const long = buildRetrievalLogRow(input({ mode: 'masked_query', query: 'x'.repeat(3000) }));
    expect(long.query_masked).toHaveLength(2000);
    expectValid(long);
  });
});

describe('buildRetrievalLogRow language fields (D-03a)', () => {
  it('takes the pipeline query language and confidence 1 when the detector agrees confidently', () => {
    const row = buildRetrievalLogRow(input({ query: '这是一个关于第二份报告的合成问题', result: result({ queryLanguage: 'zh' }) }));
    expect(row.query_language).toBe('zh');
    expect(row.query_language_confidence).toBe(1);
    expectValid(row);
  });

  it('falls back to the detector when the pipeline set no language', () => {
    expect(detectLanguageWithConfidence(EN_DETECTED)).toMatchObject({ language: 'en', confident: true });
    const row = buildRetrievalLogRow(input({ query: EN_DETECTED }));
    expect(row.query_language).toBe('en');
    expect(row.query_language_confidence).toBe(1);
  });

  it('gives 0.5 when the detector found a language without being confident', () => {
    const query = 'the gatto il cane';
    const detection = detectLanguageWithConfidence(query);
    expect(detection.language).not.toBeNull();
    expect(detection.confident).toBe(false);
    const row = buildRetrievalLogRow(input({ query }));
    expect(row.query_language).toBe(detection.language);
    expect(row.query_language_confidence).toBe(0.5);
  });

  it('gives null and null for a query of digits only', () => {
    const row = buildRetrievalLogRow(input({ query: '12345 678' }));
    expect(row.query_language).toBeNull();
    expect(row.query_language_confidence).toBeNull();
    expectValid(row);
  });

  it('keeps the pipeline language with a null confidence when the detector disagrees', () => {
    const row = buildRetrievalLogRow(input({ query: EN_DETECTED, result: result({ queryLanguage: 'it' }) }));
    expect(row.query_language).toBe('it');
    expect(row.query_language_confidence).toBeNull();
  });

  it('fills both language fields in ids mode while the query stays out', () => {
    const row = buildRetrievalLogRow(input({ mode: 'ids', query: EN_DETECTED }));
    expect(row.query_masked).toBeNull();
    expect(row.query_language).toBe('en');
    expect(row.query_language_confidence).toBe(1);
  });

  it('ignores a pipeline query language that is not a code', () => {
    const row = buildRetrievalLogRow(input({ query: '12345', result: result({ queryLanguage: 'English text' }) }));
    expect(row.query_language).toBeNull();
  });

  it('lists the distinct kept chunk languages in rank order with und for a kept chunk without one', () => {
    const candidates = [
      candidate(1, { language: 'en' }),
      candidate(2, { language: 'fr' }),
      candidate(3, { language: 'zh' }),
      candidate(4, { language: 'en' }),
      candidate(5, { language: null }),
      candidate(6, { language: 'not a code' }),
    ];
    const keptChunks = [kept(1, 1), kept(3, 2), kept(4, 3), kept(5, 4), kept(6, 5)];
    const row = buildRetrievalLogRow(input({ result: result({ candidates, kept: keptChunks }) }));
    expect(row.chunk_languages).toEqual(['en', 'zh', 'und']);
    expect(row.candidates![0]!.language).toBe('en');
    expect(row.candidates![1]!.language).toBe('fr');
    expect(row.candidates![4]).not.toHaveProperty('language');
    expect(row.candidates![5]).not.toHaveProperty('language');
    expectValid(row);
  });

  it('gives an empty chunk language list when nothing was kept', () => {
    const row = buildRetrievalLogRow(input({ result: result({ candidates: [candidate(1, { language: 'en' })], kept: [] }) }));
    expect(row.chunk_languages).toEqual([]);
  });

  it('reads the answer language from the holder and drops a value that is not a code', () => {
    const answered = buildRetrievalLogRow(input({ result: result({ logOutcome: { value: 'answered', answerLanguage: 'it' } }) }));
    expect(answered.answer_language).toBe('it');
    expect(answered.outcome).toBe('answered');

    expect(buildRetrievalLogRow(input()).answer_language).toBeNull();
    expect(buildRetrievalLogRow(input({ result: result({ logOutcome: undefined }) })).answer_language).toBeNull();

    for (const bad of ['This answer is a sentence.', '<b>en</b>', 'a'.repeat(40)]) {
      const row = buildRetrievalLogRow(input({ result: result({ logOutcome: { value: 'answered', answerLanguage: bad } }) }));
      expect(row.answer_language).toBeNull();
      expect(JSON.stringify(row)).not.toContain(bad);
      expectValid(row);
    }
  });

  it('stores only codes or null in every language field on every built row', () => {
    const rows = [
      buildRetrievalLogRow(input()),
      buildRetrievalLogRow(input({ mode: 'masked_query', query: EN_DETECTED })),
      buildRetrievalLogRow(input({ query: '这是一个合成问题', result: result({ queryLanguage: 'zh-Hans' }) })),
    ];
    for (const row of rows) {
      for (const value of [row.query_language, row.answer_language]) if (value !== null) expect(value).toMatch(CODE);
      for (const value of row.chunk_languages ?? []) expect(value).toMatch(CODE);
      expectValid(row);
    }
  });
});

describe('writeRetrievalLog (D-03, D-27)', () => {
  const row = () => buildRetrievalLogRow(input({ mode: 'masked_query', query: 'private question about the second report' }));

  it('inserts the row and asks for the tenant key back', async () => {
    const lines: string[] = [];
    const { admin, calls } = recordingAdmin(() => ({ data: { id: 'row-1', tenant_key: `o:${ORG_A}` }, error: null }));
    await writeRetrievalLog(row(), { expectedTenantKey: `o:${ORG_A}`, client: admin, log: (line) => lines.push(line) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe('rag_retrieval_log');
    expect(calls[0]!.ops.map((op) => op.op)).toEqual(expect.arrayContaining(['insert', 'select']));
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(lines).toEqual([]);
  });

  it('resolves after about 2 s and logs one timeout line when the database hangs', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const hanging = {
        from: () => {
          const builder: Record<string, unknown> = {};
          for (const method of ['insert', 'select', 'single', 'maybeSingle', 'abortSignal']) builder[method] = () => builder;
          builder.then = () => new Promise(() => undefined);
          return builder;
        },
      } as unknown as SupabaseClient;
      let settled = false;
      const pending = writeRetrievalLog(row(), { expectedTenantKey: `o:${ORG_A}`, client: hanging, log: (line) => lines.push(line) }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(settled).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[Retrieval Log\] /);
      expect(lines[0]).toContain('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a row filed under another tenant and logs tenant_mismatch', async () => {
    const lines: string[] = [];
    const { admin, calls } = recordingAdmin((call) =>
      call.ops.some((op) => op.op === 'insert') ? { data: { id: 'row-9', tenant_key: `o:${ORG_B}` }, error: null } : { data: null, error: null },
    );
    await writeRetrievalLog(row(), { expectedTenantKey: `o:${ORG_A}`, client: admin, log: (line) => lines.push(line) });
    expect(calls).toHaveLength(2);
    const remove = calls[1]!;
    expect(remove.table).toBe('rag_retrieval_log');
    expect(remove.ops.map((op) => op.op)).toContain('delete');
    expect(remove.ops).toEqual(expect.arrayContaining([{ op: 'eq', args: ['trace_id', TRACE] }]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tenant_mismatch');
  });

  it('logs one line with codes and counts only on an insert error and never throws', async () => {
    const lines: string[] = [];
    const { admin } = recordingAdmin(() => ({ data: null, error: { message: 'duplicate key private question about the second report', code: '23505' } }));
    await expect(
      writeRetrievalLog(row(), { expectedTenantKey: `o:${ORG_A}`, client: admin, log: (line) => lines.push(line) }),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatch(/^\[Retrieval Log\] /);
    expect(line).toContain('23505');
    expect(line).toContain(createHash('sha256').update(TRACE).digest('hex').slice(0, 12));
    expect(line).not.toContain(TRACE);
    expect(line).not.toContain('private question');
    expect(line).not.toContain('chunk-1');
    expect(line).toContain('"candidates":3');
  });

  it('never throws when the client throws or is missing', async () => {
    const lines: string[] = [];
    const throwing = { from: () => { throw new TypeError('boom private question'); } } as unknown as SupabaseClient;
    await writeRetrievalLog(row(), { expectedTenantKey: `o:${ORG_A}`, client: throwing, log: (line) => lines.push(line) });
    await writeRetrievalLog(row(), { expectedTenantKey: `o:${ORG_A}`, client: null, log: (line) => lines.push(line) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('TypeError');
    expect(lines.join('\n')).not.toContain('private question');
  });
});
