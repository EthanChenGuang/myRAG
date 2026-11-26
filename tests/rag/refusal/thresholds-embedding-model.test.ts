import { afterEach, describe, expect, it, vi } from 'vitest';
import rawThresholds from '../../../eval/config/refusal-thresholds.json';
import type { RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { decideRefusal } from '@/lib/rag/refusal/gate';
import { loadThresholdsFromData, runningEmbeddingModel } from '@/lib/rag/refusal/thresholds';

type Cell = NonNullable<RefusalThresholds['cells']>[number];
type Language = 'zh' | 'en' | 'it';

const HASH = 'c'.repeat(64);

function cell(language: Language, over: Partial<Cell> = {}): Cell {
  return {
    config_hash: HASH,
    dev: { answerable_count: 27, correct_refusal_rate: 0.4, false_refusal_rate: 0, false_refusal_rate_upper_bound: 0.1, no_answer_count: 7 },
    holdout: { answerable_count: 7, correct_refusal_rate: 0.5, false_refusal_rate: 0.1, false_refusal_rate_upper_bound: 0.5, no_answer_count: 2 },
    holdout_evaluations: 1,
    key: `cohere|rerank-v5.0-pro|${language}|same`,
    model: 'rerank-v5.0-pro',
    pairing: 'same',
    provider: 'cohere',
    query_language: language,
    recorded_at: '2026-11-20',
    rerank_text_version: RERANK_TEXT_VERSION,
    source: 'live',
    status: 'calibrated',
    threshold: 0.3,
    tokenizer_version: LEXICAL_VERSION,
    ...over,
  };
}

const file = (cells: Cell[]): RefusalThresholds => ({ cells, config_hash: HASH, schema_version: 1 });

afterEach(() => vi.unstubAllEnvs());

describe('refusal thresholds loader and the embedding model (D-18)', () => {
  const same = cell('en', { embedding_model: 'embed-model-a' });
  const other = cell('zh', { embedding_model: 'embed-model-b' });
  const unset = cell('it');

  it('loads a cell recorded with the running embedding model and a cell without the field', () => {
    const { cells } = loadThresholdsFromData(file([same, other, unset]), 'embed-model-a');
    expect(cells.has(same.key)).toBe(true);
    expect(cells.has(unset.key)).toBe(true);
  });

  it('does not load a cell recorded with another embedding model, so the gate takes its no-cell path', () => {
    const { cells } = loadThresholdsFromData(file([same, other, unset]), 'embed-model-a');
    expect(cells.has(other.key)).toBe(false);
    const record = decideRefusal({
      enabled: true,
      profile: 'chat',
      reranker: { id: 'cohere', model: 'rerank-v5.0-pro', scoreSemantics: 'calibrated' },
      rerankStatus: 'ok',
      reranked: [{ score: 0.01, language: 'zh' }],
      queryLanguage: 'zh',
      cells,
      versions: { lexical: LEXICAL_VERSION, rerankText: RERANK_TEXT_VERSION },
    });
    expect(record).toMatchObject({ decision: 'not_applied', reason: 'cell_uncalibrated', cellKey: null });
  });

  it('defaults to the running embedding model from OPENAI_EMBEDDING_MODEL', () => {
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'embed-model-b');
    expect(runningEmbeddingModel()).toBe('embed-model-b');
    const { cells } = loadThresholdsFromData(file([same, other]));
    expect([...cells.keys()]).toEqual([other.key]);
  });

  it('loads exactly the same cells from the committed thresholds file under any embedding model', () => {
    const committed = (rawThresholds as RefusalThresholds).cells ?? [];
    for (const model of ['text-embedding-3-small', 'embed-model-b']) {
      const { cells } = loadThresholdsFromData(rawThresholds, model);
      expect([...cells.keys()].sort()).toEqual(committed.map((entry) => entry.key).sort());
    }
  });
});
