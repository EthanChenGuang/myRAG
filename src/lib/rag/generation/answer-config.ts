import { readGenerationConfig } from './config';

export type MaxOutputTokens =
  | { readonly kind: 'off' }
  | { readonly kind: 'auto' }
  | { readonly kind: 'fixed'; readonly value: number };
export type OutputGuardMode = 'off' | 'flag' | 'enforce';
export type UploaderHoldMode = 'off' | 'manual' | 'auto';

export type AnswerConfigWarningCode =
  | 'max_output_tokens_invalid'
  | 'max_output_tokens_below_floor'
  | 'invalid_output_guard'
  | 'invalid_uploader_hold'
  | 'invalid_uploader_alert_threshold'
  | 'invalid_uploader_alert_window_hours'
  | 'per_sentence_needs_citations'
  | 'judge_needs_model'
  | 'claim_check_needs_groundedness';

/** The message names the variable only; a configured value is never repeated in it. */
export interface AnswerConfigWarning {
  readonly code: AnswerConfigWarningCode;
  readonly message: string;
}

export interface AnswerConfig {
  readonly registryTexts: boolean;
  readonly partialAnswerRule: boolean;
  readonly contextRelevanceRule: boolean;
  readonly citationPerSentence: boolean;
  readonly claimCheck: boolean;
  readonly llmJudge: boolean;
  readonly judgeModel: string;
  readonly maxOutputTokens: MaxOutputTokens;
  readonly outputGuard: OutputGuardMode;
  readonly versionLabels: boolean;
  readonly securityEvents: boolean;
  readonly uploaderAlertThreshold: number;
  readonly uploaderAlertWindowHours: number;
  readonly uploaderHold: UploaderHoldMode;
  /** True when any resolved switch differs from its default; the judge model and the window alone change no behaviour. */
  readonly anyNonDefault: boolean;
  readonly warnings: readonly AnswerConfigWarning[];
}

export type AnswerEnvSource = Record<string, string | undefined>;

/** The static part of the D-31 floor; the registry-dependent part is checked where the registry is loaded. */
export const MIN_OUTPUT_TOKENS_FLOOR = 256;

const DEFAULT_ALERT_WINDOW_HOURS = 24;
const MIN_ALERT_WINDOW_HOURS = 1;
const MAX_ALERT_WINDOW_HOURS = 720;
const OUTPUT_GUARD_MODES: readonly OutputGuardMode[] = ['off', 'flag', 'enforce'];
const UPLOADER_HOLD_MODES: readonly UploaderHoldMode[] = ['off', 'manual', 'auto'];
const INTEGER_PATTERN = /^\d+$/;

const OFF: MaxOutputTokens = Object.freeze({ kind: 'off' });
const AUTO: MaxOutputTokens = Object.freeze({ kind: 'auto' });

function isOn(raw: string | undefined): boolean {
  return raw?.trim() === 'true';
}

function parseNonNegativeInteger(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!INTEGER_PATTERN.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function parseMode<T extends string>(
  raw: string | undefined,
  modes: readonly T[],
  warning: AnswerConfigWarning,
  warnings: AnswerConfigWarning[],
): T {
  const text = raw?.trim() ?? '';
  if (text === '') return modes[0];
  const mode = modes.find((candidate) => candidate === text);
  if (mode) return mode;
  warnings.push(warning);
  return modes[0];
}

function parseMaxOutputTokens(raw: string | undefined, warnings: AnswerConfigWarning[]): MaxOutputTokens {
  const text = raw?.trim() ?? '';
  if (text === '' || text === 'off') return OFF;
  if (text === 'auto') return AUTO;
  const value = parseNonNegativeInteger(text);
  if (value === null || value === 0) {
    warnings.push({
      code: 'max_output_tokens_invalid',
      message: 'RAG_MAX_OUTPUT_TOKENS is not off, auto or a positive integer; using off',
    });
    return OFF;
  }
  if (value < MIN_OUTPUT_TOKENS_FLOOR) {
    warnings.push({
      code: 'max_output_tokens_below_floor',
      message: `RAG_MAX_OUTPUT_TOKENS is below the floor of ${MIN_OUTPUT_TOKENS_FLOOR} tokens; using off`,
    });
    return OFF;
  }
  return Object.freeze({ kind: 'fixed', value });
}

function parseAlertThreshold(raw: string | undefined, warnings: AnswerConfigWarning[]): number {
  const text = raw?.trim() ?? '';
  if (text === '') return 0;
  const value = parseNonNegativeInteger(text);
  if (value !== null) return value;
  warnings.push({
    code: 'invalid_uploader_alert_threshold',
    message: 'RAG_UPLOADER_ALERT_THRESHOLD is not a non-negative integer; using 0',
  });
  return 0;
}

function parseAlertWindow(raw: string | undefined, warnings: AnswerConfigWarning[]): number {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_ALERT_WINDOW_HOURS;
  const value = parseNonNegativeInteger(text);
  if (value === null) {
    warnings.push({
      code: 'invalid_uploader_alert_window_hours',
      message: `RAG_UPLOADER_ALERT_WINDOW_HOURS is not an integer; using ${DEFAULT_ALERT_WINDOW_HOURS}`,
    });
    return DEFAULT_ALERT_WINDOW_HOURS;
  }
  return Math.min(MAX_ALERT_WINDOW_HOURS, Math.max(MIN_ALERT_WINDOW_HOURS, value));
}

/** Read at call time, never cached or logged; an invalid value or combination falls back to off with a warning code (D-58). */
export function readAnswerConfig(source: AnswerEnvSource = process.env): AnswerConfig {
  const warnings: AnswerConfigWarning[] = [];
  const generation = readGenerationConfig(source);

  const registryTexts = isOn(source.RAG_REGISTRY_TEXTS);
  const partialAnswerRule = isOn(source.RAG_PARTIAL_ANSWER_RULE);
  const contextRelevanceRule = isOn(source.RAG_CONTEXT_RELEVANCE_RULE);
  const versionLabels = isOn(source.RAG_VERSION_LABELS);
  const securityEvents = isOn(source.RAG_SECURITY_EVENTS);
  const judgeModel = source.RAG_GROUNDEDNESS_JUDGE_MODEL?.trim() ?? '';
  const maxOutputTokens = parseMaxOutputTokens(source.RAG_MAX_OUTPUT_TOKENS, warnings);
  const outputGuard = parseMode(
    source.RAG_OUTPUT_GUARD,
    OUTPUT_GUARD_MODES,
    { code: 'invalid_output_guard', message: 'RAG_OUTPUT_GUARD is not off, flag or enforce; using off' },
    warnings,
  );
  const uploaderAlertThreshold = parseAlertThreshold(source.RAG_UPLOADER_ALERT_THRESHOLD, warnings);
  const uploaderAlertWindowHours = parseAlertWindow(source.RAG_UPLOADER_ALERT_WINDOW_HOURS, warnings);
  const uploaderHold = parseMode(
    source.RAG_UPLOADER_HOLD,
    UPLOADER_HOLD_MODES,
    { code: 'invalid_uploader_hold', message: 'RAG_UPLOADER_HOLD is not off, manual or auto; using off' },
    warnings,
  );

  let citationPerSentence = isOn(source.RAG_CITATION_PER_SENTENCE);
  if (citationPerSentence && !generation.citations && !generation.claudeCitations) {
    citationPerSentence = false;
    warnings.push({
      code: 'per_sentence_needs_citations',
      message: 'RAG_CITATION_PER_SENTENCE needs RAG_CITATIONS or RAG_CLAUDE_CITATIONS; using off',
    });
  }
  let claimCheck = isOn(source.RAG_CLAIM_CHECK);
  if (claimCheck && !generation.groundedness) {
    claimCheck = false;
    warnings.push({
      code: 'claim_check_needs_groundedness',
      message: 'RAG_CLAIM_CHECK needs RAG_GROUNDEDNESS; using off',
    });
  }
  let llmJudge = isOn(source.RAG_GROUNDEDNESS_LLM_JUDGE);
  if (llmJudge && judgeModel === '') {
    llmJudge = false;
    warnings.push({
      code: 'judge_needs_model',
      message: 'RAG_GROUNDEDNESS_LLM_JUDGE needs RAG_GROUNDEDNESS_JUDGE_MODEL; using off',
    });
  }

  const anyNonDefault =
    registryTexts ||
    partialAnswerRule ||
    contextRelevanceRule ||
    citationPerSentence ||
    claimCheck ||
    llmJudge ||
    maxOutputTokens.kind !== 'off' ||
    outputGuard !== 'off' ||
    versionLabels ||
    securityEvents ||
    uploaderAlertThreshold !== 0 ||
    uploaderHold !== 'off';

  return Object.freeze({
    registryTexts,
    partialAnswerRule,
    contextRelevanceRule,
    citationPerSentence,
    claimCheck,
    llmJudge,
    judgeModel,
    maxOutputTokens,
    outputGuard,
    versionLabels,
    securityEvents,
    uploaderAlertThreshold,
    uploaderAlertWindowHours,
    uploaderHold,
    anyNonDefault,
    warnings: Object.freeze(warnings.map((warning) => Object.freeze({ ...warning }))),
  });
}

const warnedCodes = new Set<AnswerConfigWarningCode>();

/** Logs one `[Answer Rules]` line per process for codes not logged before; codes only, never a value. */
export function warnAnswerConfigOnce(config: AnswerConfig = readAnswerConfig()): void {
  const fresh: AnswerConfigWarningCode[] = [];
  for (const warning of config.warnings) {
    if (warnedCodes.has(warning.code)) continue;
    warnedCodes.add(warning.code);
    fresh.push(warning.code);
  }
  if (fresh.length === 0) return;
  console.warn('[Answer Rules] Invalid answer-rule settings fall back to off', { codes: fresh });
}

export function resetAnswerConfigWarningsForTests(): void {
  warnedCodes.clear();
}
