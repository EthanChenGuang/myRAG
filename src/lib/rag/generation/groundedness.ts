import rawThresholds from '../../../../eval/config/groundedness-thresholds.json';
import { stripCitationMarkers } from '@/lib/citations/marker-grammar';
import {
  GroundednessThresholdsSchema,
  type AnswerRecord,
  type GroundednessRequest,
  type GroundednessResult,
} from '@/lib/rag-eval/contracts.generated';
import { countTokens as cl100kCountTokens } from '../ingest/text/tokens';
import { detectLanguage } from '../lang/detect';
import { chineseScript } from '../lang/script';
import type { RetrievalStatus } from '../types';
import type { AliasedBlock } from './citations/blocks';
import type { GenerationConfig } from './config';
import { requestGroundedness, type GroundednessClientOptions } from './groundedness-client';

export interface GroundednessEligibilityInput {
  /** RAG_GROUNDEDNESS. */
  enabled: boolean;
  /** The request came from the web chat with the citations capability (D-05). */
  webChatWithCitations: boolean;
  ragMode: string;
  retrievalStatus: RetrievalStatus;
  /** Knowledge-base blocks actually sent to the model. */
  blockCount: number;
  /** The strict refusal or the knowledge-base-unavailable message. */
  isRefusal: boolean;
  ghostChat: boolean;
  /** An MCP tool result was used in the answer. */
  toolOutputUsed: boolean;
}

export type GroundednessEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'not_eligible' | 'tool_output' };

const SCORED_MODES = new Set(['strict', 'balanced']);

/** D-14: every condition must hold; an MCP tool result on an otherwise eligible answer is tool_output. */
export function groundednessEligibility(input: GroundednessEligibilityInput): GroundednessEligibility {
  const hasContext =
    (input.retrievalStatus === 'ok' || input.retrievalStatus === 'degraded') && input.blockCount > 0;
  const eligible =
    input.enabled &&
    input.webChatWithCitations &&
    SCORED_MODES.has(input.ragMode) &&
    hasContext &&
    !input.isRefusal &&
    !input.ghostChat;
  if (!eligible) return { eligible: false, reason: 'not_eligible' };
  if (input.toolOutputUsed) return { eligible: false, reason: 'tool_output' };
  return { eligible: true };
}

export interface PremiseInput {
  /** The alias blocks in the order they were sent. */
  blocks: ReadonlyArray<Pick<AliasedBlock, 'alias' | 'text'>>;
  citedAliases: Iterable<string>;
  /** webSearch result texts, only when that tool ran. */
  webSearchTexts: readonly string[];
  /** RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS. */
  maxTokens: number;
  countTokens?: (text: string) => number;
}

export type Premise =
  | { status: 'ok'; premiseTexts: string[]; truncated: boolean }
  | { status: 'too_long' }
  | { status: 'empty_premise' };

interface PremisePiece {
  order: number;
  text: string;
  tokens: number;
}

/**
 * D-14: the evidence actually sent. Under the cap everything is kept in order. Above it the cited blocks go first,
 * then the other blocks in alias order, then the webSearch texts; whatever fits is returned in the original order.
 */
export function buildPremise(input: PremiseInput): Premise {
  const count = input.countTokens ?? cl100kCountTokens;
  const cited = new Set(input.citedAliases);
  const citedPieces: PremisePiece[] = [];
  const otherPieces: PremisePiece[] = [];
  let order = 0;
  for (const block of input.blocks) {
    const index = order++;
    if (!block.text.trim()) continue;
    const piece = { order: index, text: block.text, tokens: count(block.text) };
    (cited.has(block.alias) ? citedPieces : otherPieces).push(piece);
  }
  for (const text of input.webSearchTexts) {
    const index = order++;
    if (!text.trim()) continue;
    otherPieces.push({ order: index, text, tokens: count(text) });
  }

  const all = [...citedPieces, ...otherPieces];
  if (all.length === 0) return { status: 'empty_premise' };

  const citedTokens = citedPieces.reduce((sum, piece) => sum + piece.tokens, 0);
  if (citedTokens > input.maxTokens) return { status: 'too_long' };

  const kept: PremisePiece[] = [...citedPieces];
  let used = citedTokens;
  let truncated = false;
  for (const piece of otherPieces) {
    if (used + piece.tokens <= input.maxTokens) {
      kept.push(piece);
      used += piece.tokens;
    } else {
      truncated = true;
    }
  }
  if (kept.length === 0) return { status: 'too_long' };
  kept.sort((a, b) => a.order - b.order);
  return { status: 'ok', premiseTexts: kept.map((piece) => piece.text), truncated };
}

export type Hypothesis = { status: 'ok'; hypothesis: string } | { status: 'not_checked'; reason: 'empty_answer' };

/** D-14: the final answer with every citation marker stripped. */
export function buildHypothesis(answer: string): Hypothesis {
  const hypothesis = stripCitationMarkers(answer).trim();
  if (!hypothesis) return { status: 'not_checked', reason: 'empty_answer' };
  return { status: 'ok', hypothesis };
}

/** zh is Chinese with no script decision; only en and zh-Hans can be scored (D-11). */
export type GroundednessLanguage = 'en' | 'it' | 'zh-Hans' | 'zh-Hant' | 'zh' | 'unknown';

/** D-14: the pipeline's zh/en/it detector on the answer; Chinese is split by script (research Open Question 3). */
export function answerGroundednessLanguage(answer: string): GroundednessLanguage {
  const text = stripCitationMarkers(answer);
  const language = detectLanguage(text);
  if (language === null) return 'unknown';
  if (language === 'en' || language === 'it') return language;
  if (language !== 'zh') return 'unknown';
  const script = chineseScript(text);
  if (script === 'hans') return 'zh-Hans';
  if (script === 'hant') return 'zh-Hant';
  return 'zh';
}

/** D-21: Vectara only on opt-in; multi-tenant also needs the recorded retention acknowledgement. Fails closed. */
export function allowVectaraFor(
  config: Pick<GenerationConfig, 'vectaraOptIn' | 'vectaraMultiTenantAck'>,
  multiTenant: boolean,
): boolean {
  if (config.vectaraOptIn !== true) return false;
  if (multiTenant) return config.vectaraMultiTenantAck === true;
  return true;
}

export type ThresholdSource = 'default' | 'calibrated';
export type GroundednessThresholdCells = ReadonlyMap<string, { threshold: number; source: ThresholdSource }>;

const DEFAULT_THRESHOLD = 0.5;
let warnedInvalidThresholds = false;

function cellKey(scorer: string, language: string): string {
  return `${scorer}:${language}`;
}

export function loadGroundednessThresholdsFromData(data: unknown): { cells: GroundednessThresholdCells } {
  const parsed = GroundednessThresholdsSchema.safeParse(data);
  if (!parsed.success) {
    if (!warnedInvalidThresholds) {
      warnedInvalidThresholds = true;
      console.warn('[Groundedness] Invalid groundedness-thresholds.json, default thresholds used', {
        issues: parsed.error.issues.length,
      });
    }
    return { cells: new Map() };
  }
  const cells = new Map<string, { threshold: number; source: ThresholdSource }>();
  for (const cell of parsed.data.cells ?? []) {
    cells.set(cellKey(cell.scorer, cell.language), { threshold: cell.threshold, source: cell.source });
  }
  return { cells };
}

let cachedThresholds: { cells: GroundednessThresholdCells } | null = null;

/** The committed thresholds, validated once (the 04-13 pattern). */
export function loadGroundednessThresholds(): { cells: GroundednessThresholdCells } {
  cachedThresholds ??= loadGroundednessThresholdsFromData(rawThresholds);
  return cachedThresholds;
}

export type GroundednessLabel = 'verified' | 'possibly_unreliable' | 'not_checked';

export interface LabelledGroundedness {
  status: GroundednessResult['status'];
  label: GroundednessLabel;
  scorer: GroundednessResult['scorer'];
  score: number | null;
  threshold: number | null;
  thresholdSource: ThresholdSource | null;
  reason: string | null;
  truncated: boolean;
  latencyMs: number;
}

/** D-13: score at or above the (scorer, language) threshold is verified, below is possibly_unreliable; no score is not_checked. */
export function labelGroundedness(
  result: GroundednessResult,
  language: string,
  cells: GroundednessThresholdCells = loadGroundednessThresholds().cells,
): LabelledGroundedness {
  const base = {
    scorer: result.scorer,
    reason: result.reason ?? null,
    truncated: result.truncated ?? false,
    latencyMs: result.latency_ms,
  };
  const score = result.score ?? null;
  if (result.status !== 'scored' || score === null || result.scorer === 'none') {
    return {
      ...base,
      status: 'not_checked',
      label: 'not_checked',
      score: null,
      threshold: null,
      thresholdSource: null,
    };
  }
  const cell = cells.get(cellKey(result.scorer, language)) ?? { threshold: DEFAULT_THRESHOLD, source: 'default' as const };
  return {
    ...base,
    status: 'scored',
    label: score >= cell.threshold ? 'verified' : 'possibly_unreliable',
    score,
    threshold: cell.threshold,
    thresholdSource: cell.source,
  };
}

/** The stored groundedness of one answer (the AnswerRecord contract shape). */
export type AnswerGroundedness = AnswerRecord['groundedness'];

export interface ScoreAnswerGroundednessInput {
  /** Sent as the sidecar request_id. */
  answerId: string;
  /** The streamed answer, markers included. */
  answerText: string;
  blocks: ReadonlyArray<Pick<AliasedBlock, 'alias' | 'text'>>;
  citedAliases: Iterable<string>;
  webSearchTexts: readonly string[];
  eligibility: GroundednessEligibility;
  multiTenant: boolean;
  config: Pick<GenerationConfig, 'vectaraOptIn' | 'vectaraMultiTenantAck' | 'maxPremiseTokens' | 'groundednessTimeoutMs'>;
}

export interface ScoreAnswerGroundednessDeps {
  request?: (request: GroundednessRequest, options?: GroundednessClientOptions) => Promise<GroundednessResult>;
  countTokens?: (text: string) => number;
  cells?: GroundednessThresholdCells;
  now?: () => Date;
}

/** Only these answer languages have a scorer (D-11); anything else is not_checked without a request. */
const SCORABLE_LANGUAGES: ReadonlySet<GroundednessLanguage> = new Set(['en', 'zh-Hans']);

function skipped(reason: string, checkedAt: string): AnswerGroundedness {
  return {
    status: 'not_checked',
    label: 'not_checked',
    scorer: 'none',
    score: null,
    threshold: null,
    thresholdSource: null,
    reason,
    truncated: false,
    latencyMs: 0,
    checkedAt,
  };
}

/**
 * D-13, D-14, D-21: turns one answer and the evidence it was given into a labelled groundedness result.
 * Skipped cases send nothing to the sidecar; every failure is a not_checked result, never a throw.
 */
export async function scoreAnswerGroundedness(
  input: ScoreAnswerGroundednessInput,
  deps: ScoreAnswerGroundednessDeps = {},
): Promise<AnswerGroundedness> {
  const now = deps.now ?? (() => new Date());
  if (!input.eligibility.eligible) return skipped(input.eligibility.reason, now().toISOString());

  const hypothesis = buildHypothesis(input.answerText);
  if (hypothesis.status !== 'ok') return skipped(hypothesis.reason, now().toISOString());

  const language = answerGroundednessLanguage(input.answerText);
  if (!SCORABLE_LANGUAGES.has(language)) return skipped('unsupported_language', now().toISOString());

  const premise = buildPremise({
    blocks: input.blocks,
    citedAliases: input.citedAliases,
    webSearchTexts: input.webSearchTexts,
    maxTokens: input.config.maxPremiseTokens,
    ...(deps.countTokens ? { countTokens: deps.countTokens } : {}),
  });
  if (premise.status !== 'ok') return skipped(premise.status, now().toISOString());

  let result: GroundednessResult;
  try {
    result = await (deps.request ?? requestGroundedness)(
      {
        request_id: input.answerId,
        premise_texts: premise.premiseTexts,
        hypothesis: hypothesis.hypothesis,
        language,
        allow_vectara: allowVectaraFor(input.config, input.multiTenant),
      },
      { timeoutMs: input.config.groundednessTimeoutMs },
    );
  } catch (error) {
    console.warn('[Groundedness] Scoring request failed', { error: error instanceof Error ? error.name : typeof error });
    return skipped('error', now().toISOString());
  }

  const labelled = labelGroundedness(result, language, deps.cells);
  return {
    status: labelled.status,
    label: labelled.label,
    scorer: labelled.scorer,
    score: labelled.score,
    threshold: labelled.threshold,
    thresholdSource: labelled.thresholdSource,
    reason: labelled.reason,
    truncated: premise.truncated || labelled.truncated,
    latencyMs: labelled.latencyMs,
    checkedAt: now().toISOString(),
  };
}
