import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';
import type { ExtendedMessage } from '@/types/chat';

export const POLL_SCHEDULE_MS = [1000, 2000, 4000, 8000] as const;
export const POLL_REPEAT_MS = 8000;
export const POLL_LIMIT_MS = 30000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

export type PollOutcome =
  | { status: 'settled'; record: AnswerRecord }
  | { status: 'gave_up'; record: AnswerRecord | null }
  | { status: 'stopped'; httpStatus: number | null }
  | { status: 'aborted' };

export interface PollOptions {
  fetch?: FetchLike;
  sleep?: SleepLike;
  signal?: AbortSignal;
  onRecord?: (record: AnswerRecord) => void;
}

export async function pollAnswerRecord(_answerId: string, _options: PollOptions = {}): Promise<PollOutcome> {
  return { status: 'aborted' };
}

export async function loadChatAnswerRecords(
  _chatId: string | null | undefined,
  _options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<AnswerRecord[]> {
  return [];
}

export function reconcileAnswerRecords(
  messages: ExtendedMessage[],
  _records: Record<string, AnswerRecord>,
  _chatId: string | null,
): ExtendedMessage[] {
  return messages;
}

export interface AnswerRecordsControllerDeps {
  fetch?: FetchLike;
  sleep?: SleepLike;
  upsert: (record: AnswerRecord) => void;
  upsertMany: (records: AnswerRecord[]) => void;
}

export interface AnswerRecordsController {
  update(input: { chatId: string | null; messages: ExtendedMessage[]; enabled: boolean }): void;
  dispose(): void;
}

export function createAnswerRecordsController(_deps: AnswerRecordsControllerDeps): AnswerRecordsController {
  return { update() {}, dispose() {} };
}

export interface UseAnswerRecordsInput {
  chatId: string | null;
  messages: ExtendedMessage[];
  setMessages: (update: (previous: ExtendedMessage[]) => ExtendedMessage[]) => void;
  save?: (chatId: string, messages: ExtendedMessage[]) => void;
}

export function useAnswerRecords(_input: UseAnswerRecordsInput): void {}
