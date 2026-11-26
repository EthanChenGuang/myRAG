import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { RunnableLambda, type Runnable, type RunnableConfig } from '@langchain/core/runnables';
import { FakeChatModel } from '@langchain/core/utils/testing';
import contextualizePrompt from '../prompts/langchain.contextualize.v1.json';
import multiQueryPrompt from '../prompts/langchain.multi-query.v1.json';
import type { LangChainTransform } from './errors';

/** One row of eval/fixtures/query-llm/transforms.json; the same table the native fake reads (D-39). */
export interface FakeLangChainEntry {
  transform: LangChainTransform;
  query: string;
  item_id?: string;
  target_language?: string;
  output?: unknown;
  delay_ms?: number;
  fail?: 'invalid' | 'error';
}

export interface FakeLangChainTable {
  version: 1;
  description?: string;
  defaults?: Record<string, string>;
  entries: FakeLangChainEntry[];
}

export interface FakeLangChainCall {
  transform: LangChainTransform;
  mode: 'text' | 'structured';
  /** The table query that matched, or null when the documented default answered. */
  matched: string | null;
  prompt: string;
  /** Call options and config keys the model received (the signal as a boolean, callbacks as a handler count). */
  config: Record<string, unknown>;
}

const TRANSFORMS: readonly LangChainTransform[] = ['condense', 'expand', 'hyde', 'decompose', 'translate'];
const STRUCTURED_TRANSFORM: Readonly<Record<string, LangChainTransform>> = {
  CondensedQuery: 'condense',
  QueryVariants: 'expand',
  HypotheticalDocument: 'hyde',
  SubQuestions: 'decompose',
  QueryTranslation: 'translate',
};
const INVALID_OUTPUT = Object.freeze({ unexpected_field: true });
/** QueryVariants allows at most 4 queries; five lines make an expand output fail the boundary schema. */
const INVALID_EXPAND_LINES = 5;

function firstLine(template: string): string {
  return template.split('\n')[0].trim();
}

/** Text-mode calls are told apart by the first line of the vendored prompt they render. */
const TEXT_MARKERS: ReadonlyArray<{ transform: LangChainTransform; marker: string }> = [
  { transform: 'condense', marker: firstLine(contextualizePrompt.template) },
  { transform: 'expand', marker: firstLine(multiQueryPrompt.template) },
];

export function normalizeFakeQuery(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

type FakeMessage = { content: unknown };

function messageText(message: FakeMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** Any chat-model input (a string, a prompt value, messages or [role, text] tuples) as plain messages. */
function messagesOf(input: BaseLanguageModelInput): FakeMessage[] {
  if (typeof input === 'string') return [{ content: input }];
  if (Array.isArray(input)) {
    return input.map((item: unknown) => {
      if (typeof item === 'string') return { content: item };
      if (Array.isArray(item)) return { content: item[1] };
      return { content: (item as FakeMessage).content };
    });
  }
  return (input as { toChatMessages(): BaseMessage[] }).toChatMessages();
}

function describeConfig(config: object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (key === 'signal') out[key] = value instanceof AbortSignal;
    else if (key === 'callbacks') out[key] = Array.isArray(value) ? value.length : ((value as { handlers?: unknown[] })?.handlers?.length ?? 0);
    else out[key] = value;
  }
  return out;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('fake chat model aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The translate prompt names its target code as `target_language to "xx"` (shared.translate.v1). */
const TRANSLATE_TARGET = /target_language to "([a-z]{2})"/u;

function entryTarget(entry: FakeLangChainEntry): string | undefined {
  if (entry.transform !== 'translate') return undefined;
  if (entry.target_language) return entry.target_language;
  return (entry.output as { target_language?: string } | undefined)?.target_language;
}

/** Documented defaults when no entry matches: pass-through condense, no variants, the query as the HyDE passage. */
function defaultOutput(transform: LangChainTransform, query: string, target?: string): unknown {
  switch (transform) {
    case 'condense':
      return { standalone: query, unchanged: true };
    case 'expand':
      return { queries: [] };
    case 'decompose':
      return { questions: [] };
    case 'hyde':
      return { passage: query };
    case 'translate':
      return { target_language: target ?? 'en', text: '' };
  }
}

/**
 * Deterministic LangChain chat model for tests and eval (D-39): it answers from the transforms table, keyed by the
 * table query that occurs in the rendered prompt. Text calls (condense, expand) return the text the real model would
 * write; withStructuredOutput returns the table object. delay_ms and fail behave like the native fake.
 */
export class FakeLangChainChatModel extends FakeChatModel {
  readonly calls: FakeLangChainCall[] = [];
  private readonly byTransform = new Map<LangChainTransform, FakeLangChainEntry[]>();

  constructor(table: FakeLangChainTable, params: BaseChatModelParams = {}) {
    super({ ...params, callbacks: [] });
    if (table?.version !== 1 || !Array.isArray(table.entries)) throw new Error('[Fake LangChain] expected version 1 and an entries array');
    for (const entry of table.entries) {
      if (!TRANSFORMS.includes(entry.transform)) throw new Error(`[Fake LangChain] unknown transform ${String(entry.transform)}`);
      const list = this.byTransform.get(entry.transform) ?? [];
      list.push(entry);
      this.byTransform.set(entry.transform, list);
    }
  }

  _llmType(): string {
    return 'fake-langchain';
  }

  /**
   * The entry whose query is the last message, else the longest table query that occurs in the prompt. A translate call
   * prefers the entry for its target, as the native fake does.
   */
  private find(transform: LangChainTransform, messages: FakeMessage[], target?: string): FakeLangChainEntry | undefined {
    const prompt = normalizeFakeQuery(messages.map(messageText).join('\n'));
    const last = messages.length > 0 ? normalizeFakeQuery(messageText(messages[messages.length - 1])) : '';
    const matching = (this.byTransform.get(transform) ?? []).filter((entry) => prompt.includes(normalizeFakeQuery(entry.query)));
    const forTarget = target ? matching.filter((entry) => entryTarget(entry) === target) : [];
    const candidates = forTarget.length > 0 ? forTarget : matching;
    const exact = candidates.find((entry) => normalizeFakeQuery(entry.query) === last);
    if (exact) return exact;
    return candidates.sort((a, b) => normalizeFakeQuery(b.query).length - normalizeFakeQuery(a.query).length)[0];
  }

  private async answer(
    transform: LangChainTransform,
    mode: 'text' | 'structured',
    messages: FakeMessage[],
    config: { signal?: AbortSignal } & object,
  ): Promise<{ entry: FakeLangChainEntry | undefined; output: unknown; query: string }> {
    const prompt = messages.map(messageText).join('\n');
    const target = transform === 'translate' ? TRANSLATE_TARGET.exec(prompt)?.[1] : undefined;
    const entry = this.find(transform, messages, target);
    this.calls.push({ transform, mode, matched: entry?.query ?? null, prompt, config: describeConfig(config) });
    if (config.signal?.aborted) await wait(0, config.signal);
    if (entry?.delay_ms && entry.delay_ms > 0) await wait(entry.delay_ms, config.signal);
    if (entry?.fail === 'error') throw new Error('fake chat model error');
    const query = entry?.query ?? (messages.length > 0 ? messageText(messages[messages.length - 1]) : '');
    if (target && entry?.output !== undefined && entryTarget(entry) !== target) return { entry, output: defaultOutput(transform, query, target), query };
    return { entry, output: entry?.output ?? defaultOutput(transform, query, target), query };
  }

  private textTransform(messages: FakeMessage[]): LangChainTransform {
    const prompt = messages.map(messageText).join('\n');
    const hit = TEXT_MARKERS.find((m) => prompt.includes(m.marker));
    if (!hit) throw new Error('[Fake LangChain] unrecognised text prompt');
    return hit.transform;
  }

  async _generate(messages: BaseMessage[], options?: this['ParsedCallOptions']): Promise<ChatResult> {
    const transform = this.textTransform(messages);
    const { entry, output, query } = await this.answer(transform, 'text', messages, options ?? {});
    let text: string;
    if (transform === 'condense') {
      const condensed = output as { standalone?: string; unchanged?: boolean };
      text = entry?.fail === 'invalid' ? '' : condensed.unchanged ? query : String(condensed.standalone ?? '');
    } else {
      const lines =
        entry?.fail === 'invalid'
          ? Array.from({ length: INVALID_EXPAND_LINES }, (_v, i) => `invalid ${i + 1}`)
          : ((output as { queries?: string[] }).queries ?? []);
      text = ['<questions>', ...lines, '</questions>'].join('\n');
    }
    return { generations: [{ message: new AIMessage(text), text }], llmOutput: {} };
  }

  /** One signature that satisfies every BaseChatModel overload; the fake only reads the contract name. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must be assignable to each base overload's output type
  withStructuredOutput(schema: unknown, config?: unknown): Runnable<BaseLanguageModelInput, any> {
    const json = (schema ?? {}) as Record<string, unknown>;
    const options = (config ?? {}) as { name?: string; method?: string };
    const name = options.name ?? String(json.title ?? '');
    const transform = STRUCTURED_TRANSFORM[name];
    if (!transform) throw new Error(`[Fake LangChain] unknown structured contract ${name}`);
    this.structuredRequests.push({ name, method: options.method ?? null, schema: json });
    return RunnableLambda.from(async (input: BaseLanguageModelInput, runConfig?: RunnableConfig) => {
      const { entry, output } = await this.answer(transform, 'structured', messagesOf(input), runConfig ?? {});
      return entry?.fail === 'invalid' ? (entry.output ?? INVALID_OUTPUT) : output;
    });
  }

  readonly structuredRequests: Array<{ name: string; method: string | null; schema: Record<string, unknown> }> = [];
}

export function createFakeLangChainChatModel(options: { table: FakeLangChainTable }): FakeLangChainChatModel {
  return new FakeLangChainChatModel(options.table);
}
