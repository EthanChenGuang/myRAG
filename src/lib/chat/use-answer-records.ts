'use client';

import { useEffect, useRef } from 'react';
import { z } from 'zod/v3';
import { AnswerRecordSchema, type AnswerRecord } from '@/lib/rag-eval/contracts.generated';
import { mergeAnswerRecord } from '@/lib/chat/answer-metadata';
import { useAnswerRecordsStore } from '@/lib/stores/answer-records-store';
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

const UuidSchema = z.string().uuid();
const ChatRecordsSchema = z.object({ records: z.array(z.unknown()) });

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function isUuid(value: unknown): value is string {
  return UuidSchema.safeParse(value).success;
}

/** A chat whose records live on the server: a saved chat id, never a ghost- id. */
export function isPersistedChatId(chatId: string | null | undefined): chatId is string {
  return typeof chatId === 'string' && !chatId.startsWith('ghost-') && isUuid(chatId);
}

function waitBefore(attempt: number): number {
  return attempt < POLL_SCHEDULE_MS.length ? POLL_SCHEDULE_MS[attempt] : POLL_REPEAT_MS;
}

/** Polls GET /api/rag/answers/{answerId} until groundedness leaves pending; 404 means not written yet. */
export async function pollAnswerRecord(answerId: string, options: PollOptions = {}): Promise<PollOutcome> {
  if (!isUuid(answerId)) return { status: 'stopped', httpStatus: null };
  const doFetch = options.fetch ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const { signal } = options;
  let waited = 0;
  let last: AnswerRecord | null = null;

  for (let attempt = 0; waited < POLL_LIMIT_MS; attempt += 1) {
    const wait = waitBefore(attempt);
    await sleep(wait, signal);
    waited += wait;
    if (signal?.aborted) return { status: 'aborted' };

    let response: Response;
    try {
      response = await doFetch(`/api/rag/answers/${answerId}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal });
    } catch {
      return signal?.aborted ? { status: 'aborted' } : { status: 'stopped', httpStatus: null };
    }
    if (response.status === 404) continue;
    if (!response.ok) return { status: 'stopped', httpStatus: response.status };

    let parsed: ReturnType<typeof AnswerRecordSchema.safeParse>;
    try {
      parsed = AnswerRecordSchema.safeParse(await response.json());
    } catch {
      return { status: 'stopped', httpStatus: response.status };
    }
    if (!parsed.success || parsed.data.answerId !== answerId) return { status: 'stopped', httpStatus: response.status };
    last = parsed.data;
    options.onRecord?.(last);
    if (last.groundedness.status !== 'pending') return { status: 'settled', record: last };
  }
  return { status: 'gave_up', record: last };
}

/** One GET /api/rag/answers?chatId= for a saved chat; ghost or unsaved chats make no request. */
export async function loadChatAnswerRecords(
  chatId: string | null | undefined,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<AnswerRecord[]> {
  if (!isPersistedChatId(chatId)) return [];
  const doFetch = options.fetch ?? defaultFetch;
  try {
    const response = await doFetch(`/api/rag/answers?chatId=${chatId}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: options.signal,
    });
    if (!response.ok) return [];
    const body = ChatRecordsSchema.safeParse(await response.json());
    if (!body.success) return [];
    const records: AnswerRecord[] = [];
    for (const entry of body.data.records) {
      const parsed = AnswerRecordSchema.safeParse(entry);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  } catch {
    return [];
  }
}

/** Merges every record that belongs to this chat, or to no chat yet, into the messages. */
export function reconcileAnswerRecords(
  messages: ExtendedMessage[],
  records: Record<string, AnswerRecord>,
  chatId: string | null,
): ExtendedMessage[] {
  let next = messages;
  for (const message of messages) {
    const answerId = message.metadata?.answerId;
    if (typeof answerId !== 'string') continue;
    const record = records[answerId];
    if (!record) continue;
    if (record.chatId !== null && record.chatId !== chatId) continue;
    next = mergeAnswerRecord(next, record);
  }
  return next;
}

const TRANSIENT_MESSAGE_IDS = new Set(['streaming', 'thinking']);

/** False while a stream placeholder is in the list; the page saves once the stream finishes. */
export function canSaveMessages(messages: ExtendedMessage[]): boolean {
  return !messages.some((message) => TRANSIENT_MESSAGE_IDS.has(message.id));
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

function needsRecord(message: ExtendedMessage): string | null {
  if (message.role !== 'assistant' || message.id === 'streaming') return null;
  const answerId = message.metadata?.answerId;
  if (!isUuid(answerId)) return null;
  const groundedness = message.metadata?.groundedness as { status?: unknown } | undefined;
  if (groundedness && groundedness.status !== 'pending') return null;
  return answerId;
}

/** Loads each saved chat's records once and starts one poll per finished answer that has no settled record. */
export function createAnswerRecordsController(deps: AnswerRecordsControllerDeps): AnswerRecordsController {
  const aborter = new AbortController();
  const loadedChats = new Set<string>();
  const handled = new Set<string>();
  let loadingChat: string | null = null;
  let latest: { chatId: string | null; messages: ExtendedMessage[]; enabled: boolean } | null = null;

  const startPolls = () => {
    if (!latest || !latest.enabled || aborter.signal.aborted) return;
    if (loadingChat !== null && loadingChat === latest.chatId) return;
    for (const message of latest.messages) {
      const answerId = needsRecord(message);
      if (!answerId || handled.has(answerId)) continue;
      handled.add(answerId);
      void pollAnswerRecord(answerId, { fetch: deps.fetch, sleep: deps.sleep, signal: aborter.signal, onRecord: deps.upsert });
    }
  };

  return {
    update(input) {
      if (aborter.signal.aborted) return;
      if (typeof input.chatId === 'string' && input.chatId.startsWith('ghost-')) return;
      latest = input;
      if (!input.enabled) return;
      const { chatId } = input;
      if (isPersistedChatId(chatId) && !loadedChats.has(chatId)) {
        loadedChats.add(chatId);
        loadingChat = chatId;
        void loadChatAnswerRecords(chatId, { fetch: deps.fetch, signal: aborter.signal }).then((records) => {
          if (aborter.signal.aborted) return;
          for (const record of records) {
            if (record.groundedness.status !== 'pending') handled.add(record.answerId);
          }
          if (records.length > 0) deps.upsertMany(records);
          if (loadingChat === chatId) loadingChat = null;
          startPolls();
        });
        return;
      }
      startPolls();
    },
    dispose() {
      aborter.abort();
    },
  };
}

export interface UseAnswerRecordsInput {
  chatId: string | null;
  messages: ExtendedMessage[];
  setMessages: (update: (previous: ExtendedMessage[]) => ExtendedMessage[]) => void;
  /** The page's debounced save; omitted for ghost chats, which then never poll, load or save. */
  save?: (chatId: string, messages: ExtendedMessage[]) => void;
}

/** Collects answer records after the stream and on chat load, merges them into the messages and saves them. */
export function useAnswerRecords({ chatId, messages, setMessages, save }: UseAnswerRecordsInput): void {
  const records = useAnswerRecordsStore((state) => state.records);
  const controllerRef = useRef<AnswerRecordsController | null>(null);
  const enabled = typeof save === 'function' && !(typeof chatId === 'string' && chatId.startsWith('ghost-'));

  useEffect(() => {
    const { upsert, upsertMany } = useAnswerRecordsStore.getState();
    const controller = createAnswerRecordsController({ upsert, upsertMany });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.update({ chatId, messages, enabled });
  }, [chatId, messages, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const next = reconcileAnswerRecords(messages, records, chatId);
    if (next === messages) return;
    setMessages((previous) => reconcileAnswerRecords(previous, records, chatId));
    if (save && isPersistedChatId(chatId) && canSaveMessages(next)) save(chatId, next);
  }, [records, messages, chatId, enabled, save, setMessages]);
}
