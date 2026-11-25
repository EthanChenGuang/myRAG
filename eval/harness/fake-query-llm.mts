import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryTranslation } from '../../src/lib/rag-eval/contracts.generated';
import { QueryLlmError, type QueryLlm, type QueryLlmRequest, type QueryLlmTransform } from '../../src/lib/rag/query/llm';

type Lang = QueryTranslation['target_language'];

export interface FakeQueryLlmEntry {
  transform: QueryLlmTransform;
  query: string;
  /** Golden item the entry was scripted for; informational. */
  item_id?: string;
  /** translate entries without an output may name the target language here. */
  target_language?: Lang;
  output?: unknown;
  delay_ms?: number;
  fail?: 'invalid' | 'error';
}

export interface FakeQueryLlmTable {
  version: 1;
  description?: string;
  defaults?: Record<string, string>;
  entries: FakeQueryLlmEntry[];
}

export interface FakeQueryLlm extends QueryLlm {
  /** What the scripted "model" returns before the client-side schema check; undefined means the default applies. */
  rawOutput(transform: QueryLlmTransform, input: string, targetLanguage?: Lang): unknown;
  readonly calls: Array<{ transform: QueryLlmTransform; input: string }>;
}

export const DEFAULT_FAKE_QUERY_LLM_TABLE = join(process.cwd(), 'eval/fixtures/query-llm/transforms.json');

const TRANSFORMS: readonly QueryLlmTransform[] = ['condense', 'expand', 'hyde', 'decompose', 'translate'];
const INVALID_OUTPUT = Object.freeze({ unexpected_field: true });

export function normalizeFakeQuery(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ');
}

function keyOf(transform: QueryLlmTransform, query: string, target?: Lang): string {
  return target ? `${transform}:${target}|${normalizeFakeQuery(query)}` : `${transform}|${normalizeFakeQuery(query)}`;
}

function entryTarget(entry: FakeQueryLlmEntry): Lang | undefined {
  if (entry.transform !== 'translate') return undefined;
  if (entry.target_language) return entry.target_language;
  const output = entry.output as { target_language?: Lang } | undefined;
  return output?.target_language;
}

export function loadFakeQueryLlmTable(path: string = DEFAULT_FAKE_QUERY_LLM_TABLE): FakeQueryLlmTable {
  const table = JSON.parse(readFileSync(path, 'utf8')) as FakeQueryLlmTable;
  if (table?.version !== 1 || !Array.isArray(table.entries)) throw new Error('[Fake Query LLM] expected version 1 and an entries array');
  return table;
}

/** Documented defaults when no entry matches: pass-through condense, no variants, no sub-questions, the input as the HyDE passage, no translation. */
function defaultOutput(transform: QueryLlmTransform, input: string, target: Lang | undefined): unknown {
  switch (transform) {
    case 'condense':
      return { standalone: input, unchanged: true };
    case 'expand':
      return { queries: [] };
    case 'decompose':
      return { questions: [] };
    case 'hyde':
      return { passage: input };
    case 'translate':
      return { target_language: target ?? 'en', text: '' };
  }
}

function waitFor(ms: number, signal: AbortSignal, transform: QueryLlmTransform): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new QueryLlmError('aborted', transform));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Deterministic stand-in for the query LLM (D-39). Production code never imports this module. */
export function createFakeQueryLlm(options: { table?: FakeQueryLlmTable; model?: string } = {}): FakeQueryLlm {
  const table = options.table ?? loadFakeQueryLlmTable();
  const byKey = new Map<string, FakeQueryLlmEntry>();
  for (const entry of table.entries) {
    if (!TRANSFORMS.includes(entry.transform)) throw new Error(`[Fake Query LLM] unknown transform ${String(entry.transform)}`);
    const key = keyOf(entry.transform, entry.query, entryTarget(entry));
    if (byKey.has(key)) throw new Error(`[Fake Query LLM] duplicate entry ${key}`);
    byKey.set(key, entry);
  }

  function find(transform: QueryLlmTransform, input: string, target?: Lang): FakeQueryLlmEntry | undefined {
    if (transform === 'translate' && target) return byKey.get(keyOf(transform, input, target)) ?? byKey.get(keyOf(transform, input));
    return byKey.get(keyOf(transform, input));
  }

  function outputOf(entry: FakeQueryLlmEntry | undefined, transform: QueryLlmTransform, input: string, target?: Lang): unknown {
    if (entry?.fail === 'invalid') return entry.output ?? INVALID_OUTPUT;
    if (entry?.output !== undefined) {
      if (transform === 'translate' && target && entryTarget(entry) !== target) return defaultOutput(transform, input, target);
      return entry.output;
    }
    return defaultOutput(transform, input, target);
  }

  const calls: Array<{ transform: QueryLlmTransform; input: string }> = [];

  return {
    model: options.model ?? 'fake-query-llm',
    calls,
    rawOutput(transform, input, targetLanguage) {
      return outputOf(find(transform, input, targetLanguage), transform, input, targetLanguage);
    },
    async generate<T>(request: QueryLlmRequest<T>): Promise<T> {
      const { transform, input, signal, targetLanguage } = request;
      calls.push({ transform, input });
      if (signal.aborted) throw new QueryLlmError('aborted', transform);
      const entry = find(transform, input, targetLanguage);
      if (entry?.delay_ms && entry.delay_ms > 0) await waitFor(entry.delay_ms, signal, transform);
      if (entry?.fail === 'error') throw new QueryLlmError('error', transform);
      const parsed = request.schema.safeParse(outputOf(entry, transform, input, targetLanguage));
      if (!parsed.success) throw new QueryLlmError('invalid_output', transform);
      return parsed.data;
    },
  };
}
