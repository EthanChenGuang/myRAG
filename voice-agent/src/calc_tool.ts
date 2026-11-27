/**
 * Phase 5.2.1 D-76, D-87: pure helpers for the voice agent's calculation turns and its history budget.
 * No I/O and no logging here; the pipeline logs counts and statuses only.
 */

export const CALCULATE_TOOL_NAME = 'calculate';
export const MAX_TOOL_ROUNDS = 2;
export const DEFAULT_HISTORY_SHARE = 0.25;

const CALCULATE_DESCRIPTION =
    'Evaluate a structured calculation exactly: declare each operand with its value, unit and source (the question, or a ' +
    'context block by its alias), then list the steps, each naming its operation and the operands or earlier steps it uses, ' +
    'and name the step that is the result. Take every value and rule from the question or a cited passage. Returns the ' +
    'value of every step and the result, or a rejection reason.';

/** The chat-completions function tool for `calculate`; its parameters are the schema voice-rag returned. */
export function buildCalculateToolSpec(parameters: Record<string, unknown>) {
    return {
        type: 'function' as const,
        function: { name: CALCULATE_TOOL_NAME, description: CALCULATE_DESCRIPTION, parameters },
    };
}

export interface ToolCallDelta {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}

export interface AssembledToolCall {
    index: number;
    id: string;
    name: string;
    argumentsText: string;
    arguments: Record<string, unknown> | null;
    valid: boolean;
}

export interface ToolCallAccumulator {
    add(deltas: readonly ToolCallDelta[] | undefined | null): void;
    calls(): AssembledToolCall[];
    size(): number;
}

interface Partial {
    id: string;
    name: string;
    args: string;
}

function parseObject(text: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** Streamed tool-call deltas assembled per call index (the OpenAI streaming format: id and name once, arguments in pieces). */
export function createToolCallAccumulator(): ToolCallAccumulator {
    const byIndex = new Map<number, Partial>();
    return {
        add(deltas) {
            if (!Array.isArray(deltas)) return;
            for (const delta of deltas) {
                if (!delta || typeof delta !== 'object') continue;
                const index = typeof delta.index === 'number' && Number.isInteger(delta.index) && delta.index >= 0 ? delta.index : 0;
                const entry = byIndex.get(index) ?? { id: '', name: '', args: '' };
                if (typeof delta.id === 'string' && delta.id !== '') entry.id = delta.id;
                if (typeof delta.function?.name === 'string') entry.name += delta.function.name;
                if (typeof delta.function?.arguments === 'string') entry.args += delta.function.arguments;
                byIndex.set(index, entry);
            }
        },
        calls() {
            return [...byIndex.entries()]
                .sort(([a], [b]) => a - b)
                .map(([index, entry]) => {
                    const parsed = parseObject(entry.args);
                    return {
                        index,
                        id: entry.id || `call_${index}`,
                        name: entry.name,
                        argumentsText: entry.args,
                        arguments: parsed,
                        valid: parsed !== null && entry.name !== '',
                    };
                });
        },
        size: () => byIndex.size,
    };
}

export function accumulateToolCalls(batches: Iterable<readonly ToolCallDelta[]>): AssembledToolCall[] {
    const acc = createToolCallAccumulator();
    for (const batch of batches) acc.add(batch);
    return acc.calls();
}

export interface CalcReplacement {
    start: number;
    end: number;
    text: string;
}

/** The text with exactly the returned span replaced; a span outside the text, or malformed, leaves the text as it is. */
export function applyReplacement(text: string, replacement: CalcReplacement | null | undefined): string {
    if (!replacement || typeof replacement.text !== 'string') return text;
    const { start, end } = replacement;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return text;
    return text.slice(0, start) + replacement.text + text.slice(end);
}

const ALIAS = 'S[1-9][0-9]{0,2}';
const ALIAS_MARKER = new RegExp(`[ \\t]*\\[${ALIAS}(?:\\s*,\\s*${ALIAS})*\\]`, 'g');

/** Removes [S1]-style alias markers (and the spaces before them) so they are never spoken. */
export function stripAliasMarkers(text: string): string {
    return text.replace(ALIAS_MARKER, '');
}

/**
 * Conservative token estimate: one token per three characters, rounded up. tiktoken is not an agent dependency, and
 * common tokenizers average about four characters per token in English, so this overestimates on purpose.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3);
}

const MESSAGE_OVERHEAD_TOKENS = 4;

export interface HistoryMessage {
    role: string;
    content?: unknown;
    [key: string]: unknown;
}

function messageTokens(message: HistoryMessage): number {
    const content = typeof message.content === 'string' ? message.content : message.content == null ? '' : JSON.stringify(message.content);
    const toolCalls = message.tool_calls === undefined ? '' : JSON.stringify(message.tool_calls);
    return MESSAGE_OVERHEAD_TOKENS + estimateTokens(content) + estimateTokens(toolCalls);
}

export interface TrimmedHistory<T extends HistoryMessage> {
    messages: T[];
    historyTokens: number;
    dropped: number;
}

export interface TrimHistoryOptions {
    contextLength: number;
    historyShare?: number;
}

/**
 * D-87: keeps system messages and the current question (a trailing user message), and drops the oldest whole turns
 * (a user message with the messages that follow it) until the rest fits `historyShare` of the window.
 */
export function trimHistory<T extends HistoryMessage>(history: readonly T[], options: TrimHistoryOptions): TrimmedHistory<T> {
    const share = typeof options.historyShare === 'number' && options.historyShare > 0 && options.historyShare <= 1 ? options.historyShare : DEFAULT_HISTORY_SHARE;
    const budget = Math.max(0, Math.floor(options.contextLength * share));

    const systems = history.filter((m) => m.role === 'system');
    const rest = history.filter((m) => m.role !== 'system');
    const current = rest.length > 0 && rest[rest.length - 1].role === 'user' ? rest[rest.length - 1] : null;
    const prior = current ? rest.slice(0, -1) : rest;

    const turns: T[][] = [];
    for (const message of prior) {
        if (message.role === 'user' || turns.length === 0) turns.push([message]);
        else turns[turns.length - 1].push(message);
    }
    const sizes = turns.map((t) => t.reduce((sum, m) => sum + messageTokens(m), 0));
    let total = sizes.reduce((a, b) => a + b, 0);
    let first = 0;
    let dropped = 0;
    while (first < turns.length && total > budget) {
        total -= sizes[first];
        dropped += turns[first].length;
        first++;
    }
    const kept = turns.slice(first).flat();
    return { messages: [...systems, ...kept, ...(current ? [current] : [])], historyTokens: total, dropped };
}

/** Sentences as the pipeline splits them (punctuation followed by whitespace); the last fragment is kept. */
export function splitSentences(text: string): string[] {
    const out: string[] = [];
    let rest = text;
    for (;;) {
        const match = rest.match(/^(.*?[.!?])(\s+)(.*)$/s);
        if (!match) break;
        const sentence = match[1].trim();
        if (sentence.length > 0) out.push(sentence);
        rest = match[3];
    }
    if (rest.trim().length > 0) out.push(rest.trim());
    return out;
}

export type CalcCheckStatus = 'verified' | 'corrected' | 'not_verified';

export interface CalcCheckSummary {
    stated: string | null;
    recomputed: string | null;
    status: CalcCheckStatus;
}

export interface CalcCheckOutcome {
    checks: Array<{ status?: unknown; stated?: unknown; recomputed?: unknown; [key: string]: unknown }>;
    notices: unknown[];
    replacement: CalcReplacement | null;
}

function numberOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/** Both values of the turn's primary check for the stored transcript: the corrected check first, else the first check. */
export function summarizeCheck(outcome: CalcCheckOutcome | null | undefined): CalcCheckSummary {
    const checks = outcome && Array.isArray(outcome.checks) ? outcome.checks : [];
    const primary = checks.find((c) => c.status === 'corrected') ?? checks[0];
    if (!primary) return { stated: null, recomputed: null, status: 'not_verified' };
    const status: CalcCheckStatus = primary.status === 'verified' || primary.status === 'corrected' ? primary.status : 'not_verified';
    return { stated: numberOrNull(primary.stated), recomputed: numberOrNull(primary.recomputed), status };
}
