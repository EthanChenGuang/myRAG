import type { Profile } from '../types';
import type { RefusalRecord } from './types';
import type { RerankProviderId, RerankScoreSemantics } from '../rerank/types';

export type QueryLanguage = 'zh' | 'en' | 'it';

export interface ThresholdCell {
  key: string;
  provider: string;
  model: string;
  query_language: QueryLanguage;
  pairing: 'same' | 'cross';
  threshold: number | null;
  status: 'calibrated' | 'uncalibrated' | 'insufficient_data' | 'failed_holdout';
  source: 'fixture' | 'live';
  tokenizer_version: number;
  rerank_text_version: number;
}

export type ThresholdCells = Map<string, ThresholdCell>;

export interface GateCandidate {
  score: number | null;
  language: QueryLanguage | null;
}

export interface GateInput {
  enabled: boolean;
  profile: Profile;
  reranker: { id: RerankProviderId; model: string; scoreSemantics: RerankScoreSemantics } | null;
  rerankStatus: string;
  reranked: GateCandidate[];
  queryLanguage: QueryLanguage | null;
  cells: ThresholdCells;
  versions: { lexical: number; rerankText: number };
}

export function cellKey(
  provider: string,
  model: string,
  queryLanguage: QueryLanguage,
  pairing: 'same' | 'cross',
): string {
  return `${provider}|${model}|${queryLanguage}|${pairing}`;
}

function notApplied(
  reason: RefusalRecord['reason'],
  partial: Partial<Pick<RefusalRecord, 'topScore' | 'threshold' | 'cellKey'>> = {},
): RefusalRecord {
  return {
    decision: 'not_applied',
    basis: 'none',
    reason,
    topScore: partial.topScore ?? null,
    threshold: partial.threshold ?? null,
    cellKey: partial.cellKey ?? null,
  };
}

export function decideRefusal(input: GateInput): RefusalRecord {
  if (!input.enabled) return notApplied('switch_off');
  if (!input.reranker) return notApplied('reranker_disabled');
  if (input.rerankStatus !== 'ok') return notApplied('reranker_unavailable');
  if (input.reranker.scoreSemantics !== 'calibrated') return notApplied('relative_scores');
  if (input.reranked.length === 0) return notApplied('no_candidates');

  const top = input.reranked[0]!;
  if (top.score === null || !Number.isFinite(top.score)) {
    return notApplied('invalid_score');
  }

  if (input.queryLanguage === null) return notApplied('unknown_language');

  const pairing: 'same' | 'cross' =
    top.language !== null && top.language !== input.queryLanguage ? 'cross' : 'same';
  const key = cellKey(input.reranker.id, input.reranker.model, input.queryLanguage, pairing);
  const cell = input.cells.get(key);

  if (!cell || cell.status !== 'calibrated') {
    const reason = cell ? (`cell_${cell.status}` as RefusalRecord['reason']) : 'cell_uncalibrated';
    return notApplied(reason, {
      topScore: top.score,
      threshold: cell?.threshold ?? null,
      cellKey: cell?.key ?? null,
    });
  }

  if (
    cell.tokenizer_version !== input.versions.lexical ||
    cell.rerank_text_version !== input.versions.rerankText
  ) {
    return notApplied('cell_stale', {
      topScore: top.score,
      threshold: cell.threshold,
      cellKey: cell.key,
    });
  }

  if (cell.source === 'fixture' && input.profile !== 'eval') {
    return notApplied('cell_fixture_only', {
      topScore: top.score,
      threshold: cell.threshold,
      cellKey: cell.key,
    });
  }

  const threshold = cell.threshold;
  if (threshold === null || !Number.isFinite(threshold)) {
    return notApplied('cell_uncalibrated', {
      topScore: top.score,
      threshold: null,
      cellKey: cell.key,
    });
  }

  if (top.score < threshold) {
    return {
      decision: 'refuse',
      basis: 'rerank_threshold',
      reason: 'below_threshold',
      topScore: top.score,
      threshold,
      cellKey: cell.key,
    };
  }

  return {
    decision: 'answer',
    basis: 'none',
    reason: 'above_threshold',
    topScore: top.score,
    threshold,
    cellKey: cell.key,
  };
}