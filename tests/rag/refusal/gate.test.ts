import { describe, expect, it, vi, afterEach } from 'vitest';
import { cellKey, decideRefusal, type GateInput, type ThresholdCell } from '@/lib/rag/refusal/gate';
import fs from 'node:fs';
import path from 'node:path';
import { loadThresholdsFromData, parseThresholds } from '@/lib/rag/refusal/thresholds';

function calibratedCell(overrides: Partial<ThresholdCell> = {}): ThresholdCell {
  return {
    key: 'cohere|rerank-v5.0-pro|zh|same',
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

function cellsMap(...cells: ThresholdCell[]) {
  return new Map(cells.map((c) => [c.key, c]));
}

function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    enabled: true,
    profile: 'chat',
    reranker: { id: 'cohere', model: 'rerank-v5.0-pro', scoreSemantics: 'calibrated' },
    rerankStatus: 'ok',
    reranked: [{ score: 0.5, language: 'zh' }],
    queryLanguage: 'zh',
    cells: cellsMap(calibratedCell()),
    versions: { lexical: 2, rerankText: 1 },
    ...overrides,
  };
}

describe('decideRefusal', () => {
  it('returns switch_off when disabled', () => {
    const r = decideRefusal(baseInput({ enabled: false }));
    expect(r).toMatchObject({ decision: 'not_applied', reason: 'switch_off', basis: 'none' });
  });

  it('returns reranker_disabled without a reranker', () => {
    const r = decideRefusal(baseInput({ reranker: null }));
    expect(r.reason).toBe('reranker_disabled');
  });

  it('returns reranker_unavailable when rerank stage did not complete ok', () => {
    const r = decideRefusal(baseInput({ rerankStatus: 'skipped' }));
    expect(r.reason).toBe('reranker_unavailable');
  });

  it('returns relative_scores for non-calibrated score semantics', () => {
    const r = decideRefusal(
      baseInput({
        reranker: { id: 'local_bm25', model: 'bm25', scoreSemantics: 'relative' },
      }),
    );
    expect(r.reason).toBe('relative_scores');
  });

  it('returns no_candidates for an empty reranked list', () => {
    const r = decideRefusal(baseInput({ reranked: [] }));
    expect(r.reason).toBe('no_candidates');
  });

  it('returns invalid_score for a non-finite top score and never refuses on null', () => {
    expect(decideRefusal(baseInput({ reranked: [{ score: null, language: 'zh' }] }))).toMatchObject({
      decision: 'not_applied',
      reason: 'invalid_score',
    });
    expect(decideRefusal(baseInput({ reranked: [{ score: Number.NaN, language: 'zh' }] })).decision).toBe(
      'not_applied',
    );
  });

  it('returns unknown_language when query language is null', () => {
    const r = decideRefusal(baseInput({ queryLanguage: null }));
    expect(r.reason).toBe('unknown_language');
  });

  it('refuses below threshold and answers at threshold with cellKey', () => {
    const refuse = decideRefusal(baseInput({ reranked: [{ score: 0.29, language: 'zh' }] }));
    expect(refuse).toMatchObject({
      decision: 'refuse',
      basis: 'rerank_threshold',
      topScore: 0.29,
      threshold: 0.3,
      cellKey: 'cohere|rerank-v5.0-pro|zh|same',
    });
    const answer = decideRefusal(baseInput({ reranked: [{ score: 0.3, language: 'zh' }] }));
    expect(answer).toMatchObject({ decision: 'answer', basis: 'none', cellKey: 'cohere|rerank-v5.0-pro|zh|same' });
  });

  it('selects cross pairing when top language differs from query language', () => {
    const crossKey = cellKey('cohere', 'rerank-v5.0-pro', 'zh', 'cross');
    const cells = cellsMap(
      calibratedCell({ key: crossKey, pairing: 'cross', threshold: 0.25 }),
      calibratedCell(),
    );
    const r = decideRefusal(
      baseInput({
        cells,
        reranked: [{ score: 0.2, language: 'en' }],
      }),
    );
    expect(r.decision).toBe('refuse');
    expect(r.cellKey).toBe(crossKey);
  });

  it('selects same pairing when top candidate language is null', () => {
    const r = decideRefusal(baseInput({ reranked: [{ score: 0.5, language: null }] }));
    expect(r.cellKey).toBe('cohere|rerank-v5.0-pro|zh|same');
  });

  it('returns cell_stale when tokenizer or rerank text version differs', () => {
    const staleTok = decideRefusal(
      baseInput({
        cells: cellsMap(calibratedCell({ tokenizer_version: 1 })),
      }),
    );
    expect(staleTok.reason).toBe('cell_stale');
    const staleText = decideRefusal(
      baseInput({
        cells: cellsMap(calibratedCell({ rerank_text_version: 0 })),
      }),
    );
    expect(staleText.reason).toBe('cell_stale');
  });

  it('returns cell_uncalibrated when no matching cell exists', () => {
    const r = decideRefusal(baseInput({ cells: new Map() }));
    expect(r.reason).toBe('cell_uncalibrated');
  });

  it('allows fixture cells on eval profile and cell_fixture_only on chat', () => {
    const fixture = calibratedCell({ source: 'fixture' });
    const cells = cellsMap(fixture);
    expect(
      decideRefusal(baseInput({ profile: 'eval', cells, reranked: [{ score: 0.1, language: 'zh' }] })).decision,
    ).toBe('refuse');
    expect(
      decideRefusal(baseInput({ profile: 'chat', cells, reranked: [{ score: 0.1, language: 'zh' }] })),
    ).toMatchObject({ decision: 'not_applied', reason: 'cell_fixture_only' });
  });
});

describe('loadThresholdsFromData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once and returns empty cells for invalid file data', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = loadThresholdsFromData({ schema_version: 2 });
    const b = loadThresholdsFromData({ schema_version: 2 });
    expect(a.cells.size).toBe(0);
    expect(b.cells.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[RAG Config]');
  });

  it('applies the contract rule that schema_version is 2 exactly when a cell carries a mode', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'eval/config/refusal-thresholds.json'), 'utf8'));
    expect(parseThresholds(fixture)).not.toBeNull();
    expect(parseThresholds({ schema_version: 2 })).toBeNull();
    const cells = (fixture.cells ?? []) as Record<string, unknown>[];
    if (cells.length > 0) {
      const withMode = { ...fixture, cells: [{ ...cells[0], mode: 'strict', key: `${cells[0].key}|strict` }, ...cells.slice(1)] };
      expect(parseThresholds(withMode)).toBeNull();
      expect(parseThresholds({ ...withMode, schema_version: 2 })).not.toBeNull();
    }
  });
});