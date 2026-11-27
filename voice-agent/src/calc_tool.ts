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

export function createToolCallAccumulator(): ToolCallAccumulator {
    return { add() {}, calls: () => [], size: () => 0 };
}

export function accumulateToolCalls(_batches: Iterable<readonly ToolCallDelta[]>): AssembledToolCall[] {
    return [];
}

export interface CalcReplacement {
    start: number;
    end: number;
    text: string;
}

export function applyReplacement(text: string, _replacement: CalcReplacement | null | undefined): string {
    return text;
}

export function stripAliasMarkers(text: string): string {
    return text;
}

export function estimateTokens(_text: string): number {
    return 0;
}

export interface HistoryMessage {
    role: string;
    content?: unknown;
    [key: string]: unknown;
}

export interface TrimmedHistory<T extends HistoryMessage> {
    messages: T[];
    historyTokens: number;
    dropped: number;
}

export function trimHistory<T extends HistoryMessage>(history: readonly T[], _options: { contextLength: number; historyShare?: number }): TrimmedHistory<T> {
    return { messages: [...history], historyTokens: 0, dropped: 0 };
}

export function splitSentences(_text: string): string[] {
    return [];
}

export interface CalcCheckSummary {
    stated: string | null;
    recomputed: string | null;
    status: 'verified' | 'corrected' | 'not_verified';
}

export function summarizeCheck(_outcome: unknown): CalcCheckSummary {
    return { stated: null, recomputed: null, status: 'verified' };
}
