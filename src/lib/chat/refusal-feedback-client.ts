import type { RefusalFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import type { RefusalFeedbackValue, RefusalReason, RefusalVote } from '@/lib/chat/answer-metadata';

export type RefusalFeedbackResult = { ok: true; feedback: RefusalFeedbackValue } | { ok: false; retry: true } | { ok: false; hidden: true };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface RefusalFeedbackDeps { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }
export type RefusalControlAction = { type: 'vote'; vote: RefusalVote } | { type: 'reason'; reason: RefusalReason };

export const REFUSAL_REASONS: readonly RefusalReason[] = ['answer_exists', 'wrong_language', 'other'];
export const REFUSAL_NOT_FOUND_RETRY_MS = 2000;
export const REFUSAL_TIMEOUT_MS = 10000;

export function isTraceId(_value: unknown): _value is string { return false; }
export function isRefusalControlHidden(_traceId: string): boolean { return false; }
export function shouldShowRefusalControl(_input: { role: string; finished: boolean; metadata: unknown; isGhostMode: boolean; chatId: string | null | undefined }): boolean { return false; }
export function refusalRequestFor(_current: RefusalFeedbackValue | null, _action: RefusalControlAction): RefusalFeedbackRequest | null { return null; }
export async function postRefusalFeedback(_traceId: string, _body: RefusalFeedbackRequest, _deps: RefusalFeedbackDeps = {}): Promise<RefusalFeedbackResult> { return { ok: false, retry: true }; }
export function registerMessageTrace(_messageId: string, _traceId: string | undefined): void {}
export function traceForMessage(_messageId: string): string | undefined { return undefined; }
export function setSourcesMessage(_messageId: string | null): void {}
export function sourcesMessage(): string | null { return null; }
export function sourceKeyOf(_source: { documentId?: string; url?: string; citation?: { n: number } }): string | null { return null; }
export function postSourceOpened(_traceId: string, _sourceKey: string, _deps: { fetch?: FetchLike } = {}): boolean { return false; }
export function signalSourceOpened(_input: { messageId: string | null | undefined; sourceKey: string | null; incognito: boolean }, _deps: { fetch?: FetchLike } = {}): boolean { return false; }
export function resetRefusalFeedbackSession(): void {}
