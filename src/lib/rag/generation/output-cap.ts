import rawCaps from '../../../../eval/config/output-caps.json';
import { OutputCapsSchema, type OutputCaps } from '@/lib/rag-eval/contracts.generated';
import { countTokens } from '../ingest/text/tokens';
import { getLanguageRegistry, packText, TEXT_KEYS } from '../lang/registry';
import { MIN_OUTPUT_TOKENS_FLOOR, type AnswerConfig } from './answer-config';

export type OutputCapMode = 'strict' | 'balanced';
export type OutputCapReason =
  | 'applied'
  | 'off'
  | 'mode'
  | 'no_context'
  | 'approval_continuation'
  | 'voice'
  | 'reasoning'
  | 'no_cap'
  | 'below_floor'
  | 'user_max_tokens';

export interface OutputCapDecision {
  /** The cap lowers the model limit of this turn. */
  readonly applied: boolean;
  /** The cap in force when applied, else null. */
  readonly cap: number | null;
  /** D-32: the concise instruction is composed; true when applied, and on WhatsApp turns that keep their own limit. */
  readonly concise: boolean;
  readonly reason: OutputCapReason;
}

export interface OutputCapContext {
  config: AnswerConfig;
  mode: string;
  /** The turn carries knowledge-base context in its prompt. */
  knowledgeContext: boolean;
  /** The request carries its own output limit (a user setting or a channel limit). */
  userMaxTokens: boolean;
  /** Reasoning is on for the turn: reasoning tokens share the output budget. */
  reasoning: boolean;
  approvalContinuation: boolean;
  channel: string;
  /** Overrides the committed caps file (tests and the eval); validated like it. */
  caps?: unknown;
}

const CAP_MODES: readonly OutputCapMode[] = ['strict', 'balanced'];
const NOT_APPLIED = (reason: OutputCapReason, concise = false): OutputCapDecision =>
  Object.freeze({ applied: false, cap: null, concise, reason });

let committedCaps: OutputCaps | null = null;
let floor: number | null = null;
let warnedBelowFloor = false;

function parseCaps(raw: unknown): OutputCaps {
  const parsed = OutputCapsSchema.parse(raw);
  const modes = parsed.cells.map((cell) => cell.mode).sort();
  if (modes.join(',') !== [...CAP_MODES].sort().join(',')) throw new Error('[Answer Rules] output caps need one cell per mode');
  return parsed;
}

/** D-34: the tool-written file, validated with the generated OutputCaps schema once per process. */
function loadCommittedCaps(): OutputCaps {
  committedCaps ??= parseCaps(rawCaps);
  return committedCaps;
}

function isCapMode(mode: string): mode is OutputCapMode {
  return (CAP_MODES as readonly string[]).includes(mode);
}

/** D-29: off gives null; auto reads the per-mode cell; an integer applies to strict and balanced. Never applies the floor. */
export function resolveOutputCap(input: { config: AnswerConfig; mode: string; caps?: unknown }): number | null {
  const setting = input.config.maxOutputTokens;
  if (setting.kind === 'off' || !isCapMode(input.mode)) return null;
  if (setting.kind === 'fixed') return setting.value;
  const caps = input.caps === undefined ? loadCommittedCaps() : parseCaps(input.caps);
  return caps.cells.find((cell) => cell.mode === input.mode)?.limit ?? null;
}

/** D-31: max(256, twice the token count of the longest notices.* text in any registry language); computed once. */
export function outputCapFloor(): number {
  if (floor !== null) return floor;
  let longest = 0;
  for (const pack of getLanguageRegistry().packs) {
    for (const key of TEXT_KEYS) {
      if (!key.startsWith('notices.')) continue;
      const text = packText(pack, key);
      if (text) longest = Math.max(longest, countTokens(text));
    }
  }
  floor = Math.max(MIN_OUTPUT_TOKENS_FLOOR, 2 * longest);
  return floor;
}

function warnBelowFloorOnce(): void {
  if (warnedBelowFloor) return;
  warnedBelowFloor = true;
  console.warn('[Answer Rules] Invalid answer-rule settings fall back to off', { codes: ['max_output_tokens_below_floor'] });
}

/** D-30 to D-32: whether the cap lowers this turn's limit and whether the concise instruction is composed. */
export function decideOutputCap(input: OutputCapContext): OutputCapDecision {
  if (input.config.maxOutputTokens.kind === 'off') return NOT_APPLIED('off');
  if (input.channel === 'voice') return NOT_APPLIED('voice');
  if (!isCapMode(input.mode)) return NOT_APPLIED('mode');
  if (!input.knowledgeContext) return NOT_APPLIED('no_context');
  if (input.approvalContinuation) return NOT_APPLIED('approval_continuation');
  if (input.reasoning) return NOT_APPLIED('reasoning');
  const cap = resolveOutputCap({ config: input.config, mode: input.mode, ...(input.caps !== undefined ? { caps: input.caps } : {}) });
  if (cap === null) return NOT_APPLIED('no_cap');
  if (cap < outputCapFloor()) {
    warnBelowFloorOnce();
    return NOT_APPLIED('below_floor');
  }
  // D-30: the WhatsApp handler always sends its own limit, which counts as set; it keeps it and gets only the instruction.
  if (input.userMaxTokens || input.channel === 'whatsapp') return NOT_APPLIED('user_max_tokens', input.channel === 'whatsapp');
  return Object.freeze({ applied: true, cap, concise: true, reason: 'applied' });
}

/** D-29: min(limit, cap); a cap never raises a limit. */
export function effectiveMaxOutputTokens(limit: number, cap: number | null): number {
  return cap === null ? limit : Math.min(limit, cap);
}

/** D-31, D-80: the answer reserve Phase 5.2.1's prompt budget subtracts. */
export function answerReserveTokens(input: { decision: OutputCapDecision; modelLimit: number }): number {
  return input.decision.applied ? effectiveMaxOutputTokens(input.modelLimit, input.decision.cap) : input.modelLimit;
}

export function resetOutputCapWarningsForTests(): void {
  warnedBelowFloor = false;
}
