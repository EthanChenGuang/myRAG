import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { CondensedQuerySchema, SubQuestionsSchema } from '@/lib/rag-eval/contracts.generated';

const providerFactory = vi.hoisted(() => vi.fn());
vi.mock('@openrouter/ai-sdk-provider', () => {
  providerFactory();
  return { createOpenRouter: vi.fn(() => vi.fn(() => ({ specificationVersion: 'v2' }))) };
});

import { createQueryLlm, QueryLlmError, resetQueryLlmForTests } from '@/lib/rag/query/llm';
import { getRagDeps, resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';

const FAKE_KEY = 'sk-or-placeholder-not-a-real-key-0000000000';

function jsonResult(value: unknown): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  } as unknown as LanguageModelV3GenerateResult;
}

function request(signal = new AbortController().signal) {
  return {
    transform: 'condense' as const,
    schema: CondensedQuerySchema,
    system: 'system text',
    prompt: 'prompt text',
    input: 'synthetic follow-up question',
    signal,
  };
}

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetQueryLlmForTests();
  resetRagDepsForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('createQueryLlm', () => {
  test('returns the parsed object; the call used temperature 0 and a json response format', async () => {
    const model = new MockLanguageModelV3({ doGenerate: jsonResult({ standalone: 'synthetic standalone question', unchanged: false }) });
    const llm = createQueryLlm({ model: 'openai/gpt-4.1-nano', apiKey: () => FAKE_KEY, languageModel: () => model });
    const out = await llm.generate(request());
    expect(out).toEqual({ standalone: 'synthetic standalone question', unchanged: false });
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call.temperature).toBe(0);
    expect(call.responseFormat?.type).toBe('json');
  });

  test('output that fails the schema raises invalid_output', async () => {
    const model = new MockLanguageModelV3({ doGenerate: jsonResult({ questions: ['a', 'b', 'c', 'd', 'e'] }) });
    const llm = createQueryLlm({ apiKey: () => FAKE_KEY, languageModel: () => model });
    const err = await llm.generate({ ...request(), transform: 'decompose', schema: SubQuestionsSchema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryLlmError);
    expect((err as QueryLlmError).kind).toBe('invalid_output');
    expect((err as QueryLlmError).transform).toBe('decompose');
  });

  test('non-JSON text raises invalid_output', async () => {
    const result = jsonResult({});
    (result.content as Array<{ type: 'text'; text: string }>)[0].text = 'not json';
    const model = new MockLanguageModelV3({ doGenerate: result });
    const llm = createQueryLlm({ apiKey: () => FAKE_KEY, languageModel: () => model });
    await expect(llm.generate(request())).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  test('an aborted signal raises aborted without calling the model', async () => {
    const model = new MockLanguageModelV3({ doGenerate: jsonResult({ standalone: 'x', unchanged: true }) });
    const llm = createQueryLlm({ apiKey: () => FAKE_KEY, languageModel: () => model });
    const controller = new AbortController();
    controller.abort();
    await expect(llm.generate(request(controller.signal))).rejects.toMatchObject({ kind: 'aborted' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test('an abort during the call raises aborted', async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doGenerate: async (options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          setTimeout(() => controller.abort(), 5);
        }),
    });
    const llm = createQueryLlm({ apiKey: () => FAKE_KEY, languageModel: () => model });
    await expect(llm.generate(request(controller.signal))).rejects.toMatchObject({ kind: 'aborted' });
  });

  test('a provider error raises error and is not retried', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw Object.assign(new Error('upstream 503'), { statusCode: 503, isRetryable: true });
      },
    });
    const llm = createQueryLlm({ apiKey: () => FAKE_KEY, languageModel: () => model });
    await expect(llm.generate(request())).rejects.toMatchObject({ kind: 'error' });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test('without an API key it raises unavailable and logs one [Query Layer] line with no key material', async () => {
    const llm = createQueryLlm({ apiKey: () => undefined });
    await expect(llm.generate(request())).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(llm.generate(request())).rejects.toMatchObject({ kind: 'unavailable' });
    const lines = warn.mock.calls.filter((call) => String(call[0]).includes('[Query Layer]'));
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-or/);
  });

  test('errors never carry the key or the prompt in their message', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error(`bad request with ${FAKE_KEY}`);
      },
    });
    const llm = createQueryLlm({ apiKey: () => FAKE_KEY, languageModel: () => model });
    const err = (await llm.generate(request()).catch((e: unknown) => e)) as QueryLlmError;
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain('prompt text');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(FAKE_KEY);
  });
});

describe('RagDeps.queryLlm', () => {
  test('the default client is created lazily and the provider module loads on first use only', async () => {
    expect(providerFactory).not.toHaveBeenCalled();
    const llm = getRagDeps().queryLlm();
    expect(getRagDeps().queryLlm()).toBe(llm);
    expect(llm.model).toBe('openai/gpt-4.1-nano');
    expect(providerFactory).not.toHaveBeenCalled();
  });

  test('setRagDepsForTests replaces the client', () => {
    const fake = { model: 'fake', generate: vi.fn() };
    setRagDepsForTests({ queryLlm: () => fake });
    expect(getRagDeps().queryLlm()).toBe(fake);
  });
});
