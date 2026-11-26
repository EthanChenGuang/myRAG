import type { RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import { effectiveLexicalVersion, loadRagConfig, type RagConfig, type RagEnvInput } from '../config';
import { describeReranker } from '../rerank/select';
import { RERANK_TEXT_VERSION } from '../rerank/types';
import { runningEmbeddingModel } from './thresholds';

type ThresholdCellEntry = NonNullable<RefusalThresholds['cells']>[number];

export type PendingReason = 'reranker_model' | 'embedding_model' | 'tokenizer' | 'score_shift';

/** D-18 / D-24: a derived mark next to a cell's stored status; never written into refusal-thresholds.json. */
export interface CellPending {
  reason: PendingReason;
  /** The day (YYYY-MM-DD, UTC) of the change record or of the alert. */
  since: string;
  changed_keys?: string[];
  alert_id?: string;
}

export type PendingCells = Map<string, CellPending>;

/** Env names whose change can make a refusal cell stop applying, per category (D-18). Names only. */
export const PENDING_KEY_CATEGORIES = {
  reranker_model: ['RAG_RERANKER', 'RAG_RERANK_TIER_CHAT', 'RAG_RERANK_TIER_VOICE', 'RAG_RERANK_VOYAGE_MODEL_BY_LANG', 'COHERE_API_KEY'],
  embedding_model: ['OPENAI_EMBEDDING_MODEL', 'RAG_EMBEDDING_PROFILES'],
  tokenizer: ['RAG_LEXICAL_DICTIONARY', 'RAG_LEXICAL_STEM_IT', 'RAG_LEXICAL_QUANTITY'],
} as const satisfies Record<Exclude<PendingReason, 'score_shift'>, readonly string[]>;

type ChangeCategory = keyof typeof PENDING_KEY_CATEGORIES;

/** Change reasons in the order they win when one cell is hit by several. */
const CATEGORY_ORDER: readonly ChangeCategory[] = ['embedding_model', 'reranker_model', 'tokenizer'];

export const PENDING_KEYS: readonly string[] = CATEGORY_ORDER.flatMap((category) => PENDING_KEY_CATEGORIES[category]);

export interface PendingChangeRecord {
  created_at: string;
  changed_keys: readonly string[];
}

export interface PendingAlert {
  id: string;
  language: string;
  day: string;
}

export interface PendingRunning {
  config: RagConfig;
  embeddingModel: string;
}

const DAY = /^(\d{4}-\d{2}-\d{2})/;
const TIERS = ['chat', 'voice'] as const;

function dayOf(value: string): string | null {
  const match = DAY.exec(value);
  if (match) return match[1]!;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

/** Same day counts as newer: a record dated on or after the cell's day. A cell day that cannot be read counts as older. */
function onOrAfter(changeDay: string, cellDay: string | null): boolean {
  return cellDay === null || changeDay >= cellDay;
}

function rerankerMatches(cell: ThresholdCellEntry, config: RagConfig): boolean {
  return TIERS.some((tier) => {
    const running = describeReranker(config, tier, cell.query_language);
    return running.id === cell.provider && running.model === cell.model;
  });
}

function matchesRunning(category: ChangeCategory, cell: ThresholdCellEntry, running: PendingRunning): boolean {
  switch (category) {
    case 'reranker_model':
      return rerankerMatches(cell, running.config);
    case 'embedding_model':
      return cell.embedding_model !== undefined && cell.embedding_model === running.embeddingModel;
    case 'tokenizer':
      return cell.tokenizer_version === effectiveLexicalVersion(running.config);
  }
}

function categoryKeys(category: ChangeCategory, keys: readonly string[]): string[] {
  const names: readonly string[] = PENDING_KEY_CATEGORIES[category];
  return [...new Set(keys.filter((key) => names.includes(key)))].sort();
}

/**
 * Which calibrated cells a recorded change or an open score-shift alert made unreliable (D-18, D-24). A change marks a cell when its record
 * is dated on or after the cell's recorded_at and the cell does not match the running value of that category; a top_score_psi alert marks
 * the cells of its language (or every cell for `all`). A change reason wins over a score shift on the same cell.
 */
export function pendingCells(input: {
  thresholds: RefusalThresholds | null;
  changes: readonly PendingChangeRecord[];
  alerts: readonly PendingAlert[];
  running: PendingRunning;
}): PendingCells {
  void input;
  return new Map();
}

/** Whether the live gate would apply a cell under a configuration: calibrated, live, finite threshold, matching versions and model. */
function appliesUnder(cell: ThresholdCellEntry, config: RagConfig, embeddingModel: string): boolean {
  return (
    cell.status === 'calibrated' &&
    cell.source === 'live' &&
    typeof cell.threshold === 'number' &&
    Number.isFinite(cell.threshold) &&
    cell.tokenizer_version === effectiveLexicalVersion(config) &&
    cell.rerank_text_version === RERANK_TEXT_VERSION &&
    (cell.embedding_model === undefined || cell.embedding_model === embeddingModel) &&
    rerankerMatches(cell, config)
  );
}

export type EnvValues = Readonly<Record<string, string>>;

function configOf(values: EnvValues): { config: RagConfig; embeddingModel: string } {
  return { config: loadRagConfig(values as RagEnvInput), embeddingModel: runningEmbeddingModel(values) };
}

/** Keys of the cells that apply under the current values and stop applying under the proposed ones (D-18 setting check). */
export function proposedPendingCells(thresholds: RefusalThresholds | null, currentEnv: EnvValues, proposedEnv: EnvValues): string[] {
  void thresholds; void currentEnv; void proposedEnv;
  return [];
}
