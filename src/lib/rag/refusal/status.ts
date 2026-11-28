import rawThresholds from '../../../../eval/config/refusal-thresholds.json';
import type { RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import { effectiveLexicalVersion, loadRagConfig, type RagConfig, type RerankerKind, type RerankTier } from '../config';
import { getRagDeps } from '../deps';
import { describeReranker } from '../rerank/select';
import { RERANK_TEXT_VERSION, type RerankScoreSemantics } from '../rerank/types';
import type { CellMode, QueryLanguage } from './gate';
import { parseThresholds } from './thresholds';

type ThresholdCellEntry = NonNullable<RefusalThresholds['cells']>[number];
type SplitMetrics = ThresholdCellEntry['dev'];
type Tier = 'chat' | 'voice';

const LANGUAGES: readonly QueryLanguage[] = ['zh', 'en', 'it'];
const TIERS: readonly Tier[] = ['chat', 'voice'];

const SCORE_SEMANTICS: Record<RerankerKind, RerankScoreSemantics | null> = {
  none: null,
  cohere: 'calibrated',
  voyage: 'calibrated',
  local_bm25: 'relative',
};

export interface RefusalSplitStatus {
  answerable_count: number;
  no_answer_count: number;
  false_refusal_point_estimate: number;
  false_refusal_upper_bound_95: number;
  correct_refusal_point_estimate: number;
}

export interface RefusalCellStatus {
  key: string;
  /** D-24: present only on a per-mode cell. */
  mode?: CellMode;
  provider: string;
  model: string;
  query_language: QueryLanguage;
  pairing: 'same' | 'cross';
  status: ThresholdCellEntry['status'];
  source: ThresholdCellEntry['source'];
  threshold: number | null;
  /** Calibrated with another tokenizer or rerank text version than the running code: the gate does not use it. */
  stale: boolean;
  tokenizer_version: number;
  rerank_text_version: number;
  recorded_at: string;
  holdout_evaluations: number;
  dev: RefusalSplitStatus;
  holdout: RefusalSplitStatus;
}

export interface MissingRefusalCell {
  tier: Tier;
  model: string;
  query_language: QueryLanguage;
}

export type RefusalStatusWarning =
  | { code: 'refusal_on_without_calibrated_cell'; languages: QueryLanguage[]; missing: MissingRefusalCell[]; message: string }
  | { code: 'fixture_cells_only'; message: string }
  | { code: 'stale_cells'; keys: string[]; message: string }
  | { code: 'relative_reranker'; provider: RerankerKind; message: string }
  | { code: 'thresholds_invalid'; message: string };

export interface RefusalCalibrationStatus {
  pipeline: RagConfig['pipeline'];
  refusal_threshold: boolean;
  reranker: {
    provider: RerankerKind;
    score_semantics: RerankScoreSemantics | null;
    tiers: Record<Tier, { tier: RerankTier; models: Record<QueryLanguage, string> }>;
  };
  versions: { tokenizer: number; rerank_text: number };
  config_hash: string | null;
  labels: { false_refusal_point_estimate: 'point estimate'; false_refusal_upper_bound_95: '95% upper bound' };
  cells: RefusalCellStatus[];
  warnings: RefusalStatusWarning[];
}

function split(metrics: SplitMetrics): RefusalSplitStatus {
  return {
    answerable_count: metrics.answerable_count,
    no_answer_count: metrics.no_answer_count,
    false_refusal_point_estimate: metrics.false_refusal_rate,
    false_refusal_upper_bound_95: metrics.false_refusal_rate_upper_bound,
    correct_refusal_point_estimate: metrics.correct_refusal_rate,
  };
}

function cellStatus(cell: ThresholdCellEntry, lexicalVersion: number): RefusalCellStatus {
  return {
    key: cell.key,
    ...(cell.mode ? { mode: cell.mode } : {}),
    provider: cell.provider,
    model: cell.model,
    query_language: cell.query_language,
    pairing: cell.pairing,
    status: cell.status,
    source: cell.source,
    threshold: cell.threshold ?? null,
    stale: cell.tokenizer_version !== lexicalVersion || cell.rerank_text_version !== RERANK_TEXT_VERSION,
    tokenizer_version: cell.tokenizer_version,
    rerank_text_version: cell.rerank_text_version,
    recorded_at: cell.recorded_at,
    holdout_evaluations: cell.holdout_evaluations,
    dev: split(cell.dev),
    holdout: split(cell.holdout),
  };
}

/** A cell the live gate would apply: calibrated, from a live run, current versions and a finite threshold (fixture cells apply in eval only). */
function usable(cell: RefusalCellStatus): boolean {
  return cell.status === 'calibrated' && cell.source === 'live' && !cell.stale && cell.threshold !== null && Number.isFinite(cell.threshold);
}

/**
 * What the refusal gate can do with the committed threshold cells under the running config, for the Config UI (D-17). Each cell carries
 * its false-refusal point estimate and the 95% upper bound next to it (F-19); nothing here states a rate at or under the target, and no
 * cell can be changed through it (thresholds change only through the calibration tool and a pull request).
 */
export function refusalCalibrationStatus(thresholds: RefusalThresholds | null, config: RagConfig): RefusalCalibrationStatus {
  const provider = describeReranker(config, 'chat', '').id;
  const semantics = SCORE_SEMANTICS[provider];
  const tiers = {} as RefusalCalibrationStatus['reranker']['tiers'];
  const providerByTier = {} as Record<Tier, RerankerKind>;
  for (const tier of TIERS) {
    const models = {} as Record<QueryLanguage, string>;
    providerByTier[tier] = describeReranker(config, tier, '').id;
    for (const language of LANGUAGES) models[language] = describeReranker(config, tier, language).model;
    tiers[tier] = { tier: tier === 'voice' ? config.v2.rerankTier.voice : config.v2.rerankTier.chat, models };
  }

  const lexicalVersion = effectiveLexicalVersion(config);
  const cells = (thresholds?.cells ?? []).map((cell) => cellStatus(cell, lexicalVersion));
  const warnings: RefusalStatusWarning[] = [];

  if (thresholds === null) {
    warnings.push({ code: 'thresholds_invalid', message: 'The committed refusal-thresholds.json does not validate; threshold refusal uses no cell.' });
  }

  if (config.v2.refusalThreshold && semantics !== 'relative') {
    const missing: MissingRefusalCell[] = [];
    const languages = new Set<QueryLanguage>();
    if (semantics === null) {
      for (const language of LANGUAGES) languages.add(language);
    } else {
      for (const tier of TIERS) {
        for (const language of LANGUAGES) {
          const model = tiers[tier].models[language];
          const key = `${providerByTier[tier]}|${model}|${language}|same`;
          if (cells.some((entry) => entry.key === key && usable(entry))) continue;
          if (missing.some((entry) => entry.model === model && entry.query_language === language)) continue;
          missing.push({ tier, model, query_language: language });
          languages.add(language);
        }
      }
    }
    if (languages.size > 0) {
      const named = LANGUAGES.filter((language) => languages.has(language));
      warnings.push({
        code: 'refusal_on_without_calibrated_cell',
        languages: named,
        missing,
        message: `Threshold refusal is on but no calibrated live cell exists for ${named.join(', ')} with the configured reranker; the similarity floor decides there.`,
      });
    }
  }

  if (cells.length > 0 && cells.every((entry) => entry.source === 'fixture')) {
    warnings.push({ code: 'fixture_cells_only', message: 'Only fixture cells exist: they prove the calibration tooling and apply in eval only.' });
  }

  const stale = cells.filter((entry) => entry.stale).map((entry) => entry.key);
  if (stale.length > 0) {
    warnings.push({
      code: 'stale_cells',
      keys: stale,
      message: 'These cells were calibrated with another tokenizer or rerank text version and are not used until recalibrated.',
    });
  }

  if (semantics === 'relative') {
    warnings.push({
      code: 'relative_reranker',
      provider,
      message: `${provider} scores are relative to the candidate pool, so threshold refusal does not apply to them; the similarity floor decides.`,
    });
  }

  return {
    pipeline: config.pipeline,
    refusal_threshold: config.v2.refusalThreshold,
    reranker: { provider, score_semantics: semantics, tiers },
    versions: { tokenizer: lexicalVersion, rerank_text: RERANK_TEXT_VERSION },
    config_hash: thresholds?.config_hash ?? null,
    labels: { false_refusal_point_estimate: 'point estimate', false_refusal_upper_bound_95: '95% upper bound' },
    cells,
    warnings,
  };
}

/** The status of the committed thresholds file (read by static import) under the running config. */
export function currentRefusalCalibrationStatus(): RefusalCalibrationStatus {
  return refusalCalibrationStatus(parseThresholds(rawThresholds), loadRagConfig(getRagDeps().ragEnv()));
}
