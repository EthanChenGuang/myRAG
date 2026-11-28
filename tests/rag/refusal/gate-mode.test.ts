import { afterEach, describe, expect, it, vi } from 'vitest';
import { cellKey, decideRefusal, type GateInput, type ThresholdCell } from '@/lib/rag/refusal/gate';
import { loadThresholdsFromData } from '@/lib/rag/refusal/thresholds';

const BASE = 'cohere|rerank-v5.0-pro|zh|same';

function cell(overrides: Partial<ThresholdCell> = {}): ThresholdCell {
  return {
    key: BASE,
    provider: 'cohere',
    model: 'rerank-v5.0-pro',
    query_language: 'zh',
    pairing: 'same',
    threshold: 0.3,
    status: 'calibrated',
    source: 'live',
    tokenizer_version: 2,
    rerank_text_version: 1,
    ...overrides,
  };
}

function modeCell(mode: 'strict' | 'balanced' | 'flexible', threshold: number, overrides: Partial<ThresholdCell> = {}): ThresholdCell {
  return cell({ key: `${BASE}|${mode}`, mode, threshold, ...overrides });
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    enabled: true,
    profile: 'chat',
    reranker: { id: 'cohere', model: 'rerank-v5.0-pro', scoreSemantics: 'calibrated' },
    rerankStatus: 'ok',
    reranked: [{ score: 0.5, language: 'zh' }],
    queryLanguage: 'zh',
    cells: new Map([cell(), modeCell('strict', 0.7)].map((c) => [c.key, c])),
    versions: { lexical: 2, rerankText: 1 },
    ...overrides,
  };
}

describe('decideRefusal per RAG mode (D-24)', () => {
  it('cellKey keeps the base key without a mode', () => {
    expect(cellKey('cohere', 'rerank-v5.0-pro', 'zh', 'same')).toBe(BASE);
  });

  it('strict with base and base|strict cells: the strict cell decides and is recorded', () => {
    const record = decideRefusal(input({ ragMode: 'strict' }));
    expect(record).toMatchObject({ decision: 'refuse', reason: 'below_threshold', threshold: 0.7, cellKey: `${BASE}|strict` });
  });

  it('balanced with only the base cell falls back to it', () => {
    const record = decideRefusal(input({ ragMode: 'balanced' }));
    expect(record).toMatchObject({ decision: 'answer', threshold: 0.3, cellKey: BASE });
  });

  it.each([undefined, 'bypass'] as const)('ragMode %s (voice or bypass) uses the base cell even with a strict cell', (ragMode) => {
    const record = decideRefusal(input({ ragMode }));
    expect(record).toMatchObject({ decision: 'answer', threshold: 0.3, cellKey: BASE });
  });

  it('a request without per-mode cells decides as before for every mode', () => {
    const cells = new Map([[BASE, cell()]]);
    const before = decideRefusal(input({ cells }));
    for (const ragMode of ['strict', 'balanced', 'flexible', 'bypass', undefined] as const) {
      expect(decideRefusal(input({ cells, ragMode }))).toEqual(before);
    }
  });

  it('a fixture mode cell outside the eval profile is cell_fixture_only, as a base cell is', () => {
    const cells = new Map([cell(), modeCell('strict', 0.7, { source: 'fixture' })].map((c) => [c.key, c]));
    expect(decideRefusal(input({ cells, ragMode: 'strict' }))).toMatchObject({
      decision: 'not_applied',
      reason: 'cell_fixture_only',
      cellKey: `${BASE}|strict`,
    });
    expect(decideRefusal(input({ cells, ragMode: 'strict', profile: 'eval' }))).toMatchObject({ decision: 'refuse', cellKey: `${BASE}|strict` });
  });

  it('an uncalibrated mode cell is reported, not skipped for the base cell', () => {
    const cells = new Map([cell(), modeCell('strict', 0.7, { status: 'uncalibrated', threshold: null })].map((c) => [c.key, c]));
    expect(decideRefusal(input({ cells, ragMode: 'strict' }))).toMatchObject({ decision: 'not_applied', reason: 'cell_uncalibrated', cellKey: `${BASE}|strict` });
  });

  it('judges staleness by the effective lexical version (D-42)', () => {
    const cells = new Map([cell({ tokenizer_version: 2 }), modeCell('strict', 0.7, { tokenizer_version: 2 })].map((c) => [c.key, c]));
    expect(decideRefusal(input({ cells, ragMode: 'strict', versions: { lexical: 2, rerankText: 1 } })).decision).toBe('refuse');
    expect(decideRefusal(input({ cells, ragMode: 'strict', versions: { lexical: 3, rerankText: 1 } }))).toMatchObject({
      decision: 'not_applied',
      reason: 'cell_stale',
      cellKey: `${BASE}|strict`,
    });
    expect(decideRefusal(input({ cells, versions: { lexical: 5, rerankText: 1 } })).reason).toBe('cell_stale');
  });
});

describe('loadThresholdsFromData with mode cells', () => {
  afterEach(() => vi.restoreAllMocks());

  const metrics = { answerable_count: 20, no_answer_count: 10, false_refusal_rate: 0, false_refusal_rate_upper_bound: 0.14, correct_refusal_rate: 0.5 };

  function fileCell(mode?: 'strict') {
    return {
      key: mode ? `${BASE}|${mode}` : BASE,
      ...(mode ? { mode } : {}),
      provider: 'cohere',
      model: 'rerank-v5.0-pro',
      query_language: 'zh',
      pairing: 'same',
      threshold: mode ? 0.7 : 0.3,
      status: 'calibrated',
      tokenizer_version: 2,
      rerank_text_version: 1,
      config_hash: 'a'.repeat(64),
      source: 'live',
      recorded_at: '2026-11-26',
      holdout_evaluations: 1,
      dev: metrics,
      holdout: metrics,
    };
  }

  it('loads a schema_version 2 file and keeps each cell mode', () => {
    const { cells } = loadThresholdsFromData({ schema_version: 2, cells: [fileCell(), fileCell('strict')] });
    expect([...cells.keys()].sort()).toEqual([BASE, `${BASE}|strict`]);
    expect(cells.get(`${BASE}|strict`)?.mode).toBe('strict');
    expect(cells.get(BASE)?.mode).toBeUndefined();
  });

  it('loads a schema_version 1 file as today', () => {
    const { cells } = loadThresholdsFromData({ schema_version: 1, cells: [fileCell()] });
    expect(cells.get(BASE)).toEqual(cell());
  });

  it('an invalid file means no cells and one [RAG Config] warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { cells } = loadThresholdsFromData({ schema_version: 2, cells: [{ key: 'bad' }] });
    expect(cells.size).toBe(0);
    loadThresholdsFromData({ schema_version: 2, cells: [{ key: 'bad' }] });
    expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[RAG Config]')).length).toBeLessThanOrEqual(1);
  });
});
