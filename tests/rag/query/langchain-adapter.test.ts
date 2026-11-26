import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createChatModel, OPENROUTER_BASE_URL, structured } from '@/lib/rag/query/langchain/chat-model';
import { LangChainAdapterError } from '@/lib/rag/query/langchain/errors';
import {
  createFakeLangChainChatModel,
  type FakeLangChainChatModel,
  type FakeLangChainEntry,
  type FakeLangChainTable,
} from '@/lib/rag/query/langchain/fake';
import { createLangChainTransformer } from '@/lib/rag/query/langchain';
import { QUERY_TRANSFORM_FINISHERS, type QueryTransformer } from '@/lib/rag/query/transformer';
import { llamaindexCondense } from '@/lib/rag/query/llamaindex/condense';
import { nativeExpand } from '@/lib/rag/query/llamaindex/expand';
import { nativeHyde } from '@/lib/rag/query/llamaindex/hyde';
import { renderPrompt } from '@/lib/rag/query/prompts/render';
import type { Lang } from '@/lib/rag/query/rewrite-gate';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { CondensedQuerySchema, HypotheticalDocumentSchema, QueryVariantsSchema } from '@/lib/rag-eval/contracts.generated';
import type { HistoryTurn } from '@/lib/rag/types';
import { createFakeQueryLlm, type FakeQueryLlmTable } from '../../../eval/harness/fake-query-llm.mts';

const QUERY = 'What is the rated range of sensor QX-210?';
const PASSAGE = 'Sensor QX-210 has a rated range listed in its specification sheet.';

function table(entries: FakeLangChainEntry[]): FakeLangChainTable {
  return { version: 1, entries };
}

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
  resetRagDepsForTests();
});

const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'The sample gateway logs show ERR_TIMEOUT for module QX-210.' },
  { role: 'assistant', content: 'ERR_TIMEOUT means the upstream module did not answer in time.' },
];
const FOLLOW_UP = 'How do I fix it?';
const CONDENSED = 'How do I fix ERR_TIMEOUT for module QX-210?';
const EXPAND_QUERY = 'setup steps for module QX-210';

function langchain(entries: FakeLangChainEntry[] | FakeLangChainTable): { transformer: QueryTransformer; fake: FakeLangChainChatModel } {
  const fake = createFakeLangChainChatModel({ table: Array.isArray(entries) ? table(entries) : entries });
  const transformer = createLangChainTransformer({ chatModelFactory: () => fake, deps: { finish: QUERY_TRANSFORM_FINISHERS } });
  return { transformer, fake };
}

/** The shared suffix alone: a prompt with an empty template renders to exactly the suffix. */
function suffixFor(language: Lang, maxItems: number, protectedTokens: readonly string[]): string {
  return renderPrompt({ id: 't', version: 1, source: 't', license: 'MIT', template: '', placeholders: [] }, {}, { language, maxItems, protectedTokens });
}

const committedTable = (): FakeLangChainTable =>
  JSON.parse(readFileSync(join(process.cwd(), 'eval/fixtures/query-llm/transforms.json'), 'utf8')) as FakeLangChainTable;

describe('chat model', () => {
  test('createChatModel targets OpenRouter with temperature 0, no retries, no callbacks and data collection denied', () => {
    const model = createChatModel({ model: 'example/model-a', apiKey: 'test-placeholder-key' }) as unknown as {
      model: string;
      temperature: number;
      clientConfig: { baseURL?: string; maxRetries?: number };
      caller: { maxRetries: number };
      callbacks: unknown;
      modelKwargs: { provider?: { data_collection?: string } };
    };
    expect(model.model).toBe('example/model-a');
    expect(model.temperature).toBe(0);
    expect(model.clientConfig.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(model.clientConfig.maxRetries).toBe(0);
    expect(model.caller.maxRetries).toBe(0);
    expect(model.callbacks === undefined || (Array.isArray(model.callbacks) && model.callbacks.length === 0)).toBe(true);
    expect(model.modelKwargs.provider?.data_collection).toBe('deny');
  });

  test('createChatModel refuses an empty key instead of falling back to OPENAI_API_KEY', () => {
    vi.stubEnv('OPENAI_API_KEY', 'placeholder-openai-key');
    for (const apiKey of [undefined, '', '   ']) {
      let caught: unknown;
      try {
        createChatModel({ model: 'example/model-a', apiKey }, 'expand');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LangChainAdapterError);
      expect(caught).toMatchObject({ kind: 'unavailable', transform: 'expand' });
    }
    vi.unstubAllEnvs();
  });

  test('structured asks for the generated JSON Schema with method jsonSchema and returns the validated object', async () => {
    const fake = createFakeLangChainChatModel({ table: table([{ transform: 'hyde', query: QUERY, output: { passage: PASSAGE } }]) });
    const out = await structured(fake, 'HypotheticalDocument', [['human', `Question: ${QUERY}`]], signal(), 'hyde');
    expect(out).toEqual({ passage: PASSAGE });
    expect(fake.structuredRequests).toHaveLength(1);
    expect(fake.structuredRequests[0]).toMatchObject({ name: 'HypotheticalDocument', method: 'jsonSchema' });
    const schemaFile = JSON.parse(readFileSync(join(process.cwd(), 'rag-sidecar/schemas/HypotheticalDocument.schema.json'), 'utf8'));
    expect(fake.structuredRequests[0].schema).toEqual(schemaFile);
  });

  test('structured passes the request signal and no callbacks on the invoke', async () => {
    const fake = createFakeLangChainChatModel({ table: table([{ transform: 'hyde', query: QUERY, output: { passage: PASSAGE } }]) });
    await structured(fake, 'HypotheticalDocument', [['human', QUERY]], signal(), 'hyde');
    expect(fake.calls[0].config.signal).toBe(true);
    expect(fake.calls[0].config.callbacks).toBe(0);
  });

  test('an output that fails the zod/v3 contract is invalid_output', async () => {
    const fake = createFakeLangChainChatModel({ table: table([{ transform: 'hyde', query: QUERY, fail: 'invalid' }]) });
    await expect(structured(fake, 'HypotheticalDocument', [['human', QUERY]], signal(), 'hyde')).rejects.toMatchObject({
      name: 'LangChainAdapterError',
      kind: 'invalid_output',
      transform: 'hyde',
    });
  });

  test('a provider failure is error and an abort is aborted; neither message carries prompt text', async () => {
    const failing = createFakeLangChainChatModel({ table: table([{ transform: 'hyde', query: QUERY, fail: 'error' }]) });
    const failed = await structured(failing, 'HypotheticalDocument', [['human', QUERY]], signal(), 'hyde').catch((e: unknown) => e);
    expect(failed).toMatchObject({ kind: 'error' });
    expect(String((failed as Error).message)).not.toContain('QX-210');

    const slow = createFakeLangChainChatModel({ table: table([{ transform: 'hyde', query: QUERY, delay_ms: 5000, output: { passage: PASSAGE } }]) });
    const controller = new AbortController();
    const pending = structured(slow, 'HypotheticalDocument', [['human', QUERY]], controller.signal, 'hyde');
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', transform: 'hyde' });
  });

  test('the fake answers from the table entry whose query occurs in the prompt, else the documented default', async () => {
    const other = 'Which interface does module RT-9 expose?';
    const fake = createFakeLangChainChatModel({
      table: table([
        { transform: 'hyde', query: QUERY, output: { passage: PASSAGE } },
        { transform: 'hyde', query: other, output: { passage: 'Module RT-9 exposes a serial interface.' } },
      ]),
    });
    const prompt = `Please write a passage to answer the question\nQuestion: ${QUERY}\nPassage:`;
    expect(await structured(fake, 'HypotheticalDocument', [['human', prompt]], signal(), 'hyde')).toEqual({ passage: PASSAGE });
    const unknown = 'A sentence that no table entry scripts.';
    expect(await structured(fake, 'HypotheticalDocument', [['human', unknown]], signal(), 'hyde')).toEqual({ passage: unknown });
    expect(fake.calls.map((c) => c.matched)).toEqual([QUERY, null]);
  });

  test('the fake reads the committed transforms table', () => {
    const committed = JSON.parse(readFileSync(join(process.cwd(), 'eval/fixtures/query-llm/transforms.json'), 'utf8')) as FakeLangChainTable;
    expect(() => createFakeLangChainChatModel({ table: committed })).not.toThrow();
  });
});

test('tests and eval never import @langchain directly', () => {
  const source = readFileSync(join(process.cwd(), 'tests/rag/query/langchain-adapter.test.ts'), 'utf8');
  expect(source.match(new RegExp(`from '${'@'}langchain/`, 'g'))).toBeNull();
});

describe('condense', () => {
  test('with history the standalone is the rewrite captured by the retriever', async () => {
    const { transformer, fake } = langchain([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } }]);
    const result = await transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], signal: signal() });
    expect(result).toEqual({ standalone: CONDENSED, passThrough: false, skip: null });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ transform: 'condense', mode: 'text', matched: FOLLOW_UP });
  });

  test('with empty history the query passes straight through and the chat model is not called', async () => {
    const { transformer, fake } = langchain([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } }]);
    const result = await transformer.condense({ query: FOLLOW_UP, history: [], language: 'en', protectedTokens: [], signal: signal() });
    expect(result).toEqual({ standalone: FOLLOW_UP, passThrough: true, skip: null });
    expect(fake.calls).toHaveLength(0);
  });

  test('a rewrite that drops a protected token falls back to the original through the shared post-checks', async () => {
    const { transformer } = langchain([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: 'How do I fix the timeout?', unchanged: false } }]);
    const result = await transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: ['QX-210'], signal: signal() });
    expect(result).toEqual({ standalone: FOLLOW_UP, passThrough: false, skip: { kind: 'condense', reason: 'protected_token_lost' } });
  });

  test('an empty rewrite is invalid_output, a provider failure is error and an abort is aborted', async () => {
    const invalid = langchain([{ transform: 'condense', query: FOLLOW_UP, fail: 'invalid' }]).transformer;
    await expect(invalid.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], signal: signal() })).rejects.toMatchObject({
      kind: 'invalid_output',
      transform: 'condense',
    });
    const failing = langchain([{ transform: 'condense', query: FOLLOW_UP, fail: 'error' }]).transformer;
    await expect(failing.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], signal: signal() })).rejects.toMatchObject({
      kind: 'error',
    });
    const slow = langchain([{ transform: 'condense', query: FOLLOW_UP, delay_ms: 5000, output: { standalone: CONDENSED, unchanged: false } }]);
    const controller = new AbortController();
    const pending = slow.transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', transform: 'condense' });
    expect(slow.fake.calls[0].config.signal).toBe(true);
  });

  test('the prompt is the vendored contextualize text, the history data block and the shared suffix', async () => {
    const { transformer, fake } = langchain([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } }]);
    await transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: ['QX-210'], signal: signal() });
    const prompt = fake.calls[0].prompt;
    expect(prompt.startsWith('Given a chat history and the latest user question')).toBe(true);
    expect(prompt).toContain('<conversation>\nuser: The sample gateway logs show ERR_TIMEOUT for module QX-210.');
    expect(prompt).toContain(`${suffixFor('en', 1, ['QX-210'])}\n${FOLLOW_UP}`);
    expect(prompt.endsWith(FOLLOW_UP)).toBe(true);
  });

  test('braces in history are sent literally, never read as template variables', async () => {
    const { transformer, fake } = langchain([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } }]);
    const history: HistoryTurn[] = [{ role: 'user', content: 'Module QX-210 prints {input} and {chat_history} in its log.' }];
    await transformer.condense({ query: FOLLOW_UP, history, language: 'en', protectedTokens: [], signal: signal() });
    expect(fake.calls[0].prompt).toContain('prints {input} and {chat_history} in its log.');
  });
});

describe('expand', () => {
  test('queryCount 2 returns the captured queries without the original and never more than requested', async () => {
    const { transformer, fake } = langchain([
      { transform: 'expand', query: EXPAND_QUERY, output: { queries: [EXPAND_QUERY, 'how to configure module QX-210', 'module QX-210 setup procedure', 'installing module QX-210'] } },
    ]);
    const result = await transformer.expand({ query: EXPAND_QUERY, language: 'en', protectedTokens: ['QX-210'], maxItems: 2, signal: signal() });
    expect(result.variants.map((v) => v.text)).toEqual(['how to configure module QX-210', 'module QX-210 setup procedure']);
    for (const variant of result.variants) expect(variant).toEqual(expect.objectContaining({ kind: 'expanded', legs: 'both', language: 'en', protectedOk: true }));
    expect(result.skipped).toEqual([{ kind: 'expand', reason: 'cap', count: 1 }]);
    expect(fake.calls[0].prompt).toContain('to generate 2 different versions of the given user');
    expect(fake.calls[0].prompt.endsWith(suffixFor('en', 2, ['QX-210']))).toBe(true);
  });

  test('a zero allowance makes no call', async () => {
    const { transformer, fake } = langchain([]);
    expect(await transformer.expand({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], maxItems: 0, signal: signal() })).toEqual({ variants: [], skipped: [] });
    expect(fake.calls).toHaveLength(0);
  });

  test('a failure or an output over the contract bound is a skip with reason error; an abort propagates', async () => {
    for (const fail of ['error', 'invalid'] as const) {
      const { transformer } = langchain([{ transform: 'expand', query: EXPAND_QUERY, fail }]);
      expect(await transformer.expand({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: signal() })).toEqual({
        variants: [],
        skipped: [{ transform: 'expand', reason: 'error' }],
      });
    }
    const slow = langchain([{ transform: 'expand', query: EXPAND_QUERY, delay_ms: 5000, output: { queries: ['a variant of module QX-210'] } }]);
    const controller = new AbortController();
    const pending = slow.transformer.expand({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', transform: 'expand' });
    expect(slow.fake.calls[0].config.signal).toBe(true);
  });
});

describe('no Hub, no scope', () => {
  test('neither condense nor expand makes a network call (the prompts are vendored, never pulled from the Hub)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { transformer } = langchain(committedTable());
    await transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], signal: signal() });
    await transformer.expand({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: signal() });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('no scope, tenant key or filter reaches any LangChain call, even when a caller attaches one to the input', async () => {
    const SENTINEL = 'tenant-sentinel-7f3a';
    const extra = { scope: { tenantKey: SENTINEL }, tenantKey: SENTINEL, filters: { document_ids: [SENTINEL] }, metadata: { tenant: SENTINEL } };
    const { transformer, fake } = langchain([
      { transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } },
      { transform: 'expand', query: EXPAND_QUERY, output: { queries: ['how to configure module QX-210'] } },
      { transform: 'hyde', query: EXPAND_QUERY, output: { passage: 'Module QX-210 is configured in three steps.' } },
    ]);
    await transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], signal: signal(), ...extra } as never);
    await transformer.expand({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: signal(), ...extra } as never);
    await transformer.hyde({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], signal: signal(), ...extra } as never).catch(() => undefined);
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fake.calls) {
      expect(call.prompt).not.toContain(SENTINEL);
      const config = JSON.stringify(call.config);
      expect(config).not.toContain(SENTINEL);
      expect(Object.keys(call.config).filter((key) => /scope|tenant|filter/iu.test(key))).toEqual([]);
      expect(JSON.stringify(call.config.metadata ?? {})).not.toMatch(/scope|tenant|filter/iu);
    }
  });
});

describe('shapes on the fixture inputs', () => {
  const nativeFake = () => createFakeQueryLlm({ table: committedTable() as unknown as FakeQueryLlmTable });

  test('condense: every scripted follow-up gives the native result and a CondensedQuery-valid rewrite', async () => {
    const entries = committedTable().entries.filter((e) => e.transform === 'condense' && !e.fail);
    expect(entries.length).toBeGreaterThan(0);
    const fake = nativeFake();
    setRagDepsForTests({ queryLlm: () => fake });
    const { transformer } = langchain(committedTable());
    for (const entry of entries) {
      const input = { query: entry.query, history: HISTORY, language: 'en' as const, protectedTokens: [], signal: signal() };
      const lc = await transformer.condense(input);
      const native = await llamaindexCondense(input);
      expect(lc).toEqual(native);
      expect(CondensedQuerySchema.safeParse({ standalone: lc.standalone, unchanged: lc.passThrough }).success).toBe(true);
    }
  });

  test('expand: every scripted query gives the native variants and QueryVariants-valid queries', async () => {
    const entries = committedTable().entries.filter((e) => e.transform === 'expand' && !e.fail);
    expect(entries.length).toBeGreaterThan(0);
    const fake = nativeFake();
    const { transformer } = langchain(committedTable());
    for (const entry of entries) {
      const base = { query: entry.query, language: 'en' as const, protectedTokens: [], maxItems: 2, signal: signal() };
      const lc = await transformer.expand(base);
      const native = await nativeExpand({ ...base, deps: { queryLlm: () => fake } });
      expect(lc).toEqual(native);
      expect(QueryVariantsSchema.safeParse({ queries: lc.variants.map((v) => v.text) }).success).toBe(true);
    }
  });
});

describe('hyde', () => {
  const PASSAGE_EN = 'Module QX-210 is configured in three steps described in its setup guide.';

  test('hyde returns a dense-only hyde variant from the websearch template with the shared suffix', async () => {
    const { transformer, fake } = langchain([{ transform: 'hyde', query: EXPAND_QUERY, output: { passage: PASSAGE_EN } }]);
    const result = await transformer.hyde({ query: EXPAND_QUERY, language: 'en', protectedTokens: ['QX-210'], signal: signal() });
    expect(result).toEqual({
      variant: { text: PASSAGE_EN, language: 'en', kind: 'hyde', legs: 'dense', protectedOk: true },
      truncated: false,
      skipped: [],
    });
    expect(fake.structuredRequests.map((r) => [r.name, r.method])).toEqual([['HypotheticalDocument', 'jsonSchema']]);
    const prompt = fake.calls[0].prompt;
    expect(prompt.startsWith(`Please write a passage to answer the question\nQuestion: ${EXPAND_QUERY}\nPassage:`)).toBe(true);
    expect(prompt.endsWith(suffixFor('en', 1, ['QX-210']))).toBe(true);
    expect(fake.calls[0].config).toMatchObject({ signal: true, callbacks: 0 });
  });

  test('a failure or an invalid object is a skip with reason error; an abort propagates', async () => {
    for (const fail of ['error', 'invalid'] as const) {
      const { transformer } = langchain([{ transform: 'hyde', query: EXPAND_QUERY, fail }]);
      expect(await transformer.hyde({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], signal: signal() })).toEqual({
        variant: null,
        truncated: false,
        skipped: [{ transform: 'hyde', reason: 'error' }],
      });
    }
    const slow = langchain([{ transform: 'hyde', query: EXPAND_QUERY, delay_ms: 5000, output: { passage: PASSAGE_EN } }]);
    const controller = new AbortController();
    const pending = slow.transformer.hyde({ query: EXPAND_QUERY, language: 'en', protectedTokens: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', transform: 'hyde' });
  });

  test('hyde: every scripted query gives the native result and a HypotheticalDocument-valid passage', async () => {
    const entries = committedTable().entries.filter((e) => e.transform === 'hyde' && !e.fail);
    expect(entries.length).toBeGreaterThan(0);
    const fake = createFakeQueryLlm({ table: committedTable() as unknown as FakeQueryLlmTable });
    const { transformer } = langchain(committedTable());
    for (const entry of entries) {
      const language = (/[一-鿿]/u.test(entry.query) ? 'zh' : entry.item_id?.startsWith('it-') ? 'it' : 'en') as Lang;
      const base = { query: entry.query, language, protectedTokens: [], signal: signal() };
      const lc = await transformer.hyde(base);
      const native = await nativeHyde({ ...base, deps: { queryLlm: () => fake } });
      expect(lc).toEqual(native);
      expect(lc.variant).not.toBeNull();
      expect(HypotheticalDocumentSchema.safeParse({ passage: lc.variant!.text }).success).toBe(true);
    }
  });

  test('the adapter never imports HydeRetriever or a VectorStore class', () => {
    const dir = join(process.cwd(), 'src/lib/rag/query/langchain');
    let total = 0;
    for (const file of ['index.ts', 'chat-model.ts', 'capture.ts', 'errors.ts', 'fake.ts']) {
      const source = readFileSync(join(dir, file), 'utf8');
      const imports = source.match(/^\s*(?:import|export)\b[^;]*?from\s*['"][^'"]+['"]/gmsu) ?? [];
      total += imports.length;
      for (const statement of imports) expect(statement).not.toMatch(/HydeRetriever|VectorStore|retrievers\/hyde|vectorstores/u);
      expect(source).not.toMatch(/import\(\s*['"][^'"]*(?:hyde|vectorstores)/u);
    }
    expect(total).toBeGreaterThan(10);
  });
});
