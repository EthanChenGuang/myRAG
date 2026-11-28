import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetrievalLogEntrySchema } from '@/lib/rag-eval/contracts.generated';
import { buildRetrievalLogRow, type BuildRetrievalLogRowInput } from '@/lib/rag/feedback-loop/retrieval-log';
import { calibratedQueryLanguageConfidence, loadLanguageConfidenceCalibration } from '@/lib/rag/lang/confidence';
import { detectLanguageWithConfidence } from '@/lib/rag/lang/detect';
import type { RetrievalResult } from '@/lib/rag/types';

const TRACE = 'b'.repeat(32);
const EN_DETECTED = 'this is the first item and the second item of the list';
const UNSURE = 'the gatto il cane';
const ZH = '这是一个关于第二份报告的合成问题';

function result(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
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
    tenantKey: 's:default',
    stageLatency: {},
    latencyMs: 10,
    logContext: { channel: 'chat', ragMode: 'strict' },
    mode: 'ids',
    query: EN_DETECTED,
    ...overrides,
  };
}

const CASES: Array<{ query: string; queryLanguage?: string }> = [
  { query: EN_DETECTED },
  { query: UNSURE },
  { query: ZH, queryLanguage: 'zh' },
  { query: '12345 678' },
  { query: EN_DETECTED, queryLanguage: 'it' },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('query-language confidence in the FBK-01 row (RAG_LANG_CONFIDENCE)', () => {
  it('mapped (the default) stores exactly the 1, 0.5, null mapping', () => {
    const stored = CASES.map(({ query, queryLanguage }) =>
      buildRetrievalLogRow(input({ query, result: result({ queryLanguage }) })).query_language_confidence,
    );
    expect(stored).toEqual([1, 0.5, 1, null, null]);
    const explicit = CASES.map(({ query, queryLanguage }) =>
      buildRetrievalLogRow(input({ query, result: result({ queryLanguage }), languageConfidence: 'mapped' })).query_language_confidence,
    );
    expect(explicit).toEqual(stored);
  });

  it('calibrated stores the bin value of the committed calibration, null where the mapped rule gives null', () => {
    const calibration = loadLanguageConfidenceCalibration();
    expect(calibration).not.toBeNull();
    for (const { query, queryLanguage } of CASES) {
      const row = buildRetrievalLogRow(input({ query, result: result({ queryLanguage }), languageConfidence: 'calibrated' }));
      const detection = detectLanguageWithConfidence(query);
      const expected = calibratedQueryLanguageConfidence({ text: query, detection, storedLanguage: row.query_language }, calibration!);
      expect(row.query_language_confidence).toBe(expected);
      if (row.query_language_confidence !== null) {
        expect(row.query_language_confidence).toBeGreaterThanOrEqual(0);
        expect(row.query_language_confidence).toBeLessThanOrEqual(1);
      }
      expect(RetrievalLogEntrySchema.safeParse(row).success).toBe(true);
    }
    const en = buildRetrievalLogRow(input({ languageConfidence: 'calibrated' }));
    expect(en.query_language_confidence).toBe(0.9867);
    expect(buildRetrievalLogRow(input({ query: '12345 678', languageConfidence: 'calibrated' })).query_language_confidence).toBeNull();
    expect(
      buildRetrievalLogRow(input({ result: result({ queryLanguage: 'it' }), languageConfidence: 'calibrated' })).query_language_confidence,
    ).toBeNull();
  });

  it('reads RAG_LANG_CONFIDENCE from the RAG config when the caller passes no mode', () => {
    vi.stubEnv('RAG_LANG_CONFIDENCE', 'calibrated');
    expect(buildRetrievalLogRow(input()).query_language_confidence).toBe(0.9867);
    vi.stubEnv('RAG_LANG_CONFIDENCE', 'mapped');
    expect(buildRetrievalLogRow(input()).query_language_confidence).toBe(1);
  });

  it('a missing or invalid calibration file under calibrated logs one [Retrieval Log] warning and stores the mapped value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = `/nonexistent/calibration-${Date.now()}.json`;
    const first = buildRetrievalLogRow(input({ languageConfidence: 'calibrated', calibrationFile: file }));
    const second = buildRetrievalLogRow(input({ query: UNSURE, languageConfidence: 'calibrated', calibrationFile: file }));
    expect([first.query_language_confidence, second.query_language_confidence]).toEqual([1, 0.5]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[Retrieval Log\]/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(EN_DETECTED);
  });
});
