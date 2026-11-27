/**
 * Phase 5.2.1 D-79 to D-82, D-84, D-86 (RESEARCH Pattern D): the one whole-prompt budget planner. Before retrieval it sizes
 * the documents from the model window, the fixed parts, the history, the question and the answer reserve; after the request is
 * built it checks the estimate again. History goes oldest-first in whole turns before any document budget is reduced; the
 * question is never trimmed. Pure: no I/O and no logging of text.
 */
import type { PromptBudgetTrace } from '@/lib/rag-eval/contracts.generated';
import { fixedText } from '../lang/texts';
import { countContextTokens } from './budget';
import {
  factorFor,
  promptBudgetConfig,
  tokenizerCalibration,
  type PromptBudgetConfig,
  type TokenizerCalibration,
} from './prompt-budget-config';

export interface BudgetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}

export type OverflowMode = 'truncate' | 'refine';
type PartName = 'system' | 'rules' | 'tools' | 'question' | 'documents';

export interface PromptBudgetParts {
  /** The admin prompt and mode wrapper, without context, plus the fixed notices. */
  system: string;
  /** The composed answer-rule block (D-05), composed against an empty context. */
  rules: string;
  /** Tool schemas: a string, or objects counted on their JSON serialization. */
  tools: unknown;
  question: string;
}

export interface PromptBudgetInput {
  /** The model's contextLength; null when unknown (the default window applies). */
  window: number | null;
  family: string | null;
  parts: PromptBudgetParts;
  /** The conversation before the question. */
  history: readonly BudgetMessage[];
  /** The effective output cap of the request, in tokens. */
  answerReserve: number;
  /** The document target (RAG_CONTEXT_TOKEN_BUDGET in v2, the configured legacy target otherwise). */
  documentTarget: number;
  /** The condensed standalone query of the query layer, when it produced one. */
  standaloneQuery?: string | null;
  answerLanguage?: string;
  /** Adds the configured MCP schema reserve to the tools part. */
  mcpToolReserve?: boolean;
  /**
   * D-87: token counts a caller holds instead of text (voice: the system reserve and the agent-reported history). They are
   * added to their part as given, never multiplied by the family factor, and reserved history is never trimmed.
   */
  reservedTokens?: { system?: number; history?: number };
  overflowMode?: OverflowMode;
  config?: PromptBudgetConfig;
  calibration?: TokenizerCalibration;
  /** The raw token counter; the cl100k counter unless a test injects one. */
  count?: (text: string) => number;
}

interface Counted {
  tokens: number;
  raw: number;
}

interface CountedTurn extends Counted {
  messages: readonly BudgetMessage[];
}

interface PlanState {
  window: number;
  margin: number;
  nearLimitRatio: number;
  reserve: number;
  factor: number;
  count: (text: string) => number;
  fixed: Record<Exclude<PartName, 'documents'>, Counted>;
  turns: readonly CountedTurn[];
  reservedHistory: number;
  droppedTurns: number;
  note: (Counted & { text: string }) | null;
  noteKept: boolean;
}

export interface PromptBudgetPlan {
  status: 'ok' | 'exceeded';
  documentBudget: number;
  keptHistory: BudgetMessage[];
  standaloneNote: string | null;
  trace: PromptBudgetTrace;
  /** Internal: what finalizePromptBudget needs; callers do not read it. */
  readonly state: PlanState;
}

export interface FinalizeInput {
  /** The parts as built; a part left out keeps its planned estimate (documents: the planned budget). */
  builtParts: Partial<Record<PartName, unknown>>;
  droppedDocuments: number;
}

export interface FinalizeResult {
  status: 'ok' | 'exceeded';
  action: 'confirmed' | 'dropped_history' | 'exceeded';
  keptHistory: BudgetMessage[];
  standaloneNote: string | null;
  trace: PromptBudgetTrace;
}

export class PromptOrderError extends Error {
  constructor(readonly code: 'question_missing' | 'question_not_last') {
    super(`[Prompt Budget] ${code === 'question_missing' ? 'the question is not in the request' : 'the question is not the last user message'}`);
    this.name = 'PromptOrderError';
  }
}

function partText(part: { type?: unknown; text?: unknown }): string {
  if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') return part.text;
  return JSON.stringify(part);
}

function messageText(message: BudgetMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => partText((part ?? {}) as { type?: unknown; text?: unknown })).join('\n');
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function serialized(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

/** The conversation before the question in whole turns: a user message and every reply, tool call and tool result after it. */
export function groupHistoryTurns(messages: readonly BudgetMessage[]): BudgetMessage[][] {
  const turns: BudgetMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  return turns;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function historyCounted(state: PlanState): Counted {
  const kept = state.turns.slice(state.droppedTurns);
  const note = state.note && state.noteKept && state.droppedTurns > 0 ? state.note : null;
  return {
    tokens: state.reservedHistory + sum(kept.map((t) => t.tokens)) + (note?.tokens ?? 0),
    raw: sum(kept.map((t) => t.raw)) + (note?.raw ?? 0),
  };
}

function fixedTokens(state: PlanState, tools: number = state.fixed.tools.tokens): number {
  const { system, rules, question } = state.fixed;
  return system.tokens + rules.tokens + tools + question.tokens;
}

function keptHistoryOf(state: PlanState): BudgetMessage[] {
  return state.turns.slice(state.droppedTurns).flatMap((t) => [...t.messages]);
}

function noteOf(state: PlanState): string | null {
  return state.note && state.noteKept && state.droppedTurns > 0 ? state.note.text : null;
}

function windowFor(window: number | null, config: PromptBudgetConfig) {
  const known = typeof window === 'number' && Number.isInteger(window) && window > 0;
  return known ? { window, source: 'model' as const } : { window: config.default_window, source: 'default' as const };
}

/** Drops history oldest-first in whole turns, then the standalone note, until `fits()` holds or nothing is left; mutates state. */
function trimHistory(state: PlanState, fits: () => boolean): void {
  while (!fits() && state.droppedTurns < state.turns.length) state.droppedTurns += 1;
  if (!fits() && state.note && state.droppedTurns > 0) state.noteKept = false;
}

export function planPromptBudget(input: PromptBudgetInput): PromptBudgetPlan {
  const config = input.config ?? promptBudgetConfig();
  const calibration = input.calibration ?? tokenizerCalibration();
  const count = input.count ?? countContextTokens;
  const { factor, source } = factorFor(input.family, calibration);
  const counted = (text: string): Counted => {
    const raw = text ? count(text) : 0;
    return { raw, tokens: Math.ceil(raw * factor) };
  };
  const { window, source: windowSource } = windowFor(input.window, config);
  const toolsCounted = counted(serialized(input.parts.tools));
  const reserved = (value: number | undefined) => (typeof value === 'number' && value > 0 ? Math.ceil(value) : 0);
  const systemCounted = counted(input.parts.system);
  const fixed = {
    system: { raw: systemCounted.raw, tokens: systemCounted.tokens + reserved(input.reservedTokens?.system) },
    rules: counted(input.parts.rules),
    tools: { raw: toolsCounted.raw, tokens: toolsCounted.tokens + (input.mcpToolReserve ? config.mcp_tool_reserve : 0) },
    question: counted(input.parts.question),
  };
  const standalone = input.standaloneQuery?.trim();
  const noteText = standalone
    ? `${fixedText('labels.condensed_question', input.answerLanguage ?? 'en')}: ${standalone}`
    : null;
  const state: PlanState = {
    window,
    margin: Math.ceil(config.margin_ratio * window) + config.margin_tokens,
    nearLimitRatio: config.near_limit_ratio,
    reserve: Math.max(0, Math.ceil(input.answerReserve)),
    factor,
    count,
    fixed,
    turns: groupHistoryTurns(input.history).map((messages) => {
      const c = sum(messages.map((m) => count(messageText(m))));
      return { messages, raw: c, tokens: Math.ceil(c * factor) };
    }),
    reservedHistory: reserved(input.reservedTokens?.history),
    droppedTurns: 0,
    note: noteText ? { text: noteText, ...counted(noteText) } : null,
    noteKept: true,
  };
  const overflowMode: OverflowMode = input.overflowMode ?? 'truncate';
  const estimator = { encoding: 'cl100k_base' as const, family: input.family, factor, factor_source: source };
  const base = fixedTokens(state) + state.reserve + state.margin;

  if (base > window) {
    state.droppedTurns = 0;
    state.noteKept = false;
    return {
      status: 'exceeded',
      documentBudget: 0,
      keptHistory: [],
      standaloneNote: null,
      state,
      trace: buildTrace(state, { history: { tokens: 0, raw: 0 }, documents: { tokens: 0, raw: 0 }, dropped: 0 }, {
        estimator,
        windowSource,
        overflowMode,
        status: 'exceeded',
        droppedDocuments: 0,
        nearLimit: true,
      }),
    };
  }

  const target = Math.max(0, Math.floor(input.documentTarget));
  const available = () => window - base - historyCounted(state).tokens;
  trimHistory(state, () => available() >= target);
  const documentBudget = Math.max(0, Math.min(target, available()));
  const history = historyCounted(state);
  const total = fixedTokens(state) + history.tokens + documentBudget + state.reserve;
  return {
    status: 'ok',
    documentBudget,
    keptHistory: keptHistoryOf(state),
    standaloneNote: noteOf(state),
    state,
    trace: buildTrace(state, { history, documents: { tokens: documentBudget, raw: 0 }, dropped: state.droppedTurns }, {
      estimator,
      windowSource,
      overflowMode,
      status: 'ok',
      droppedDocuments: 0,
      nearLimit: total >= state.nearLimitRatio * window,
    }),
  };
}

interface TraceMeta {
  estimator: PromptBudgetTrace['estimator'];
  windowSource: PromptBudgetTrace['window_source'];
  overflowMode: OverflowMode;
  status: 'ok' | 'exceeded';
  droppedDocuments: number;
  nearLimit: boolean;
}

function buildTrace(
  state: PlanState,
  dynamic: { history: Counted; documents: Counted; dropped: number; fixed?: PlanState['fixed'] },
  meta: TraceMeta,
): PromptBudgetTrace {
  const fixed = dynamic.fixed ?? state.fixed;
  return {
    parts: {
      system: fixed.system.tokens,
      rules: fixed.rules.tokens,
      tools: fixed.tools.tokens,
      history: dynamic.history.tokens,
      question: fixed.question.tokens,
      documents: dynamic.documents.tokens,
      reserve: state.reserve,
    },
    estimated_raw_total:
      fixed.system.raw + fixed.rules.raw + fixed.tools.raw + fixed.question.raw + dynamic.history.raw + dynamic.documents.raw,
    window: state.window,
    window_source: meta.windowSource,
    context_length_unknown: meta.windowSource === 'default',
    estimator: meta.estimator,
    dropped_documents: Math.max(0, Math.floor(meta.droppedDocuments)),
    dropped_history_turns: dynamic.dropped,
    near_limit: meta.nearLimit,
    overflow_mode: meta.overflowMode,
    status: meta.status,
    standalone_kept: noteOf(state) !== null,
  };
}

/**
 * RESEARCH Pattern D step 4: re-estimates the built request. Within the window it is confirmed; otherwise more history is
 * dropped (the caller rebuilds the messages from `keptHistory` and `standaloneNote`); with nothing left to drop it is exceeded.
 */
export function finalizePromptBudget(plan: PromptBudgetPlan, built: FinalizeInput): FinalizeResult {
  const state: PlanState = { ...plan.state };
  const meta = (status: 'ok' | 'exceeded', nearLimit: boolean): TraceMeta => ({
    estimator: plan.trace.estimator,
    windowSource: plan.trace.window_source,
    overflowMode: plan.trace.overflow_mode,
    status,
    droppedDocuments: built.droppedDocuments,
    nearLimit,
  });
  const recount = (name: PartName): Counted | null => {
    if (!Object.prototype.hasOwnProperty.call(built.builtParts, name)) return null;
    const text = serialized(built.builtParts[name]);
    const raw = text ? state.count(text) : 0;
    return { raw, tokens: Math.ceil(raw * state.factor) };
  };
  const fixed = { ...state.fixed };
  for (const name of ['system', 'rules', 'tools', 'question'] as const) fixed[name] = recount(name) ?? fixed[name];
  const documents = recount('documents') ?? { tokens: plan.documentBudget, raw: 0 };
  const fixedSum = fixed.system.tokens + fixed.rules.tokens + fixed.tools.tokens + fixed.question.tokens;
  const total = () => fixedSum + historyCounted(state).tokens + documents.tokens + state.reserve;

  if (plan.status === 'exceeded') {
    return {
      status: 'exceeded',
      action: 'exceeded',
      keptHistory: [],
      standaloneNote: null,
      trace: buildTrace(state, { history: { tokens: 0, raw: 0 }, documents, dropped: 0, fixed }, meta('exceeded', true)),
    };
  }

  const droppedBefore = state.droppedTurns;
  const noteBefore = noteOf(state);
  trimHistory(state, () => total() + state.margin <= state.window);
  const fits = total() + state.margin <= state.window;
  const changed = state.droppedTurns !== droppedBefore || noteOf(state) !== noteBefore;
  const status = fits ? 'ok' : 'exceeded';
  return {
    status,
    action: !fits ? 'exceeded' : changed ? 'dropped_history' : 'confirmed',
    keptHistory: keptHistoryOf(state),
    standaloneNote: noteOf(state),
    trace: buildTrace(
      state,
      { history: historyCounted(state), documents, dropped: state.droppedTurns, fixed },
      meta(status, total() >= state.nearLimitRatio * state.window),
    ),
  };
}

function isToolStep(message: BudgetMessage): boolean {
  if (message.role === 'tool') return true;
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const types = message.content.map((part) => (part as { type?: unknown } | null)?.type);
  return types.includes('tool-call') && types.every((t) => t === 'tool-call' || t === 'text' || t === 'reasoning');
}

function userText(message: BudgetMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => (part as { type?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * D-82, RESEARCH Pattern D: the question is the last user message, and only this turn's assistant tool calls and tool results
 * follow it. Throws PromptOrderError otherwise; the error names a code, never message text.
 */
export function assertQuestionLast(messages: readonly BudgetMessage[], question: string): void {
  const wanted = question.trim();
  if (!wanted) throw new PromptOrderError('question_missing');
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) throw new PromptOrderError('question_missing');
  if (!userText(messages[lastUser]).includes(wanted)) {
    const earlier = messages.slice(0, lastUser).some((m) => m.role === 'user' && userText(m).includes(wanted));
    throw new PromptOrderError(earlier ? 'question_not_last' : 'question_missing');
  }
  if (!messages.slice(lastUser + 1).every(isToolStep)) throw new PromptOrderError('question_not_last');
}
