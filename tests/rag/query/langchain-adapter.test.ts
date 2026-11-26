import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createChatModel, OPENROUTER_BASE_URL, structured } from '@/lib/rag/query/langchain/chat-model';
import { LangChainAdapterError } from '@/lib/rag/query/langchain/errors';
import { createFakeLangChainChatModel, type FakeLangChainEntry, type FakeLangChainTable } from '@/lib/rag/query/langchain/fake';

const QUERY = 'What is the rated range of sensor QX-210?';
const PASSAGE = 'Sensor QX-210 has a rated range listed in its specification sheet.';

function table(entries: FakeLangChainEntry[]): FakeLangChainTable {
  return { version: 1, entries };
}

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

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
