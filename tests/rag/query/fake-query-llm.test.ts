import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod/v3';
import {
  CondensedQuerySchema,
  HypotheticalDocumentSchema,
  QueryTranslationSchema,
  QueryVariantsSchema,
  SubQuestionsSchema,
} from '@/lib/rag-eval/contracts.generated';
import { QueryLlmError, type QueryLlmTransform } from '@/lib/rag/query/llm';
import {
  createFakeQueryLlm,
  loadFakeQueryLlmTable,
  normalizeFakeQuery,
  type FakeQueryLlmTable,
} from '../../../eval/harness/fake-query-llm.mts';

const SCHEMAS: Record<QueryLlmTransform, ZodType<unknown, ZodTypeDef, unknown>> = {
  condense: CondensedQuerySchema,
  expand: QueryVariantsSchema,
  hyde: HypotheticalDocumentSchema,
  decompose: SubQuestionsSchema,
  translate: QueryTranslationSchema,
};

const TABLE_PATH = join(process.cwd(), 'eval/fixtures/query-llm/transforms.json');
const table = loadFakeQueryLlmTable(TABLE_PATH);

type GoldenItem = { id: string; category: string; question: string; conversation: unknown[] };
const golden: GoldenItem[] = readFileSync(join(process.cwd(), 'eval/fixtures/golden.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as GoldenItem);

function req<T>(transform: QueryLlmTransform, input: string, signal = new AbortController().signal, targetLanguage?: 'zh' | 'en' | 'it') {
  return {
    transform,
    schema: SCHEMAS[transform] as ZodType<T, ZodTypeDef, unknown>,
    system: 'system',
    prompt: 'prompt',
    input,
    signal,
    ...(targetLanguage ? { targetLanguage } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createFakeQueryLlm', () => {
  test('a condense entry keyed by a multi_turn item question returns its scripted CondensedQuery', async () => {
    const llm = createFakeQueryLlm({ table });
    const items = golden.filter((item) => item.category === 'multi_turn');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const out = await llm.generate(req<{ standalone: string; unchanged: boolean }>('condense', `  ${item.question}\n`));
      expect(out.unchanged).toBe(false);
      expect(out.standalone).not.toBe(item.question);
    }
  });

  test('every compound item has a scripted decomposition of at most 4 parts', async () => {
    const llm = createFakeQueryLlm({ table });
    for (const item of golden.filter((g) => g.category === 'compound')) {
      const out = await llm.generate(req<{ questions: string[] }>('decompose', item.question));
      expect(out.questions.length).toBeGreaterThanOrEqual(2);
      expect(out.questions.length).toBeLessThanOrEqual(4);
    }
  });

  test('a delayed entry resolves after its delay', async () => {
    vi.useFakeTimers();
    const llm = createFakeQueryLlm({ table });
    let settled = false;
    const pending = llm.generate(req('expand', 'synthetic expand delay probe')).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ queries: ['synthetic probe variant alpha'] });
  });

  test('an abort during the delay rejects as aborted at the abort time', async () => {
    vi.useFakeTimers();
    const llm = createFakeQueryLlm({ table });
    const controller = new AbortController();
    let rejectedAt = -1;
    const pending = llm.generate(req('condense', 'synthetic condense delay probe', controller.signal)).catch((error: unknown) => {
      rejectedAt = Date.now();
      return error;
    });
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = await pending;
    expect(error).toBeInstanceOf(QueryLlmError);
    expect((error as QueryLlmError).kind).toBe('aborted');
    expect(rejectedAt - start).toBe(300);
  });

  test('an already aborted signal rejects before any delay', async () => {
    const llm = createFakeQueryLlm({ table });
    const controller = new AbortController();
    controller.abort();
    await expect(llm.generate(req('hyde', 'synthetic hyde delay probe', controller.signal))).rejects.toMatchObject({ kind: 'aborted' });
  });

  test('fail invalid produces model output that fails the schema, surfaced as invalid_output; fail error throws error', async () => {
    const llm = createFakeQueryLlm({ table });
    for (const transform of Object.keys(SCHEMAS) as QueryLlmTransform[]) {
      const raw = llm.rawOutput(transform, `synthetic ${transform} invalid probe`);
      expect(SCHEMAS[transform].safeParse(raw).success).toBe(false);
      await expect(llm.generate(req(transform, `synthetic ${transform} invalid probe`))).rejects.toMatchObject({ kind: 'invalid_output' });
      await expect(llm.generate(req(transform, `synthetic ${transform} error probe`))).rejects.toMatchObject({ kind: 'error' });
    }
  });

  test('without a matching entry each transform returns its documented default', async () => {
    const llm = createFakeQueryLlm({ table });
    const input = 'a synthetic question with no scripted entry';
    expect(await llm.generate(req('condense', input))).toEqual({ standalone: input, unchanged: true });
    expect(await llm.generate(req('expand', input))).toEqual({ queries: [] });
    expect(await llm.generate(req('decompose', input))).toEqual({ questions: [] });
    expect(await llm.generate(req('hyde', input))).toEqual({ passage: input });
    expect(await llm.generate(req('translate', input, undefined, 'zh'))).toEqual({ target_language: 'zh', text: '' });
  });

  test('translate entries key on the target language', async () => {
    const llm = createFakeQueryLlm({ table });
    const q = 'What accuracy does the XR-5100 reference thermometer have?';
    expect(await llm.generate(req('translate', q, undefined, 'it'))).toMatchObject({ target_language: 'it' });
    expect(await llm.generate(req('translate', q, undefined, 'zh'))).toEqual({ target_language: 'zh', text: '' });
  });

  test('every scripted output validates against its transform schema and keeps protected codes verbatim', () => {
    const codePattern = /\b[A-Z]{2}-\d{2,4}(?:-\d{4})?\b/g;
    for (const raw of table.entries) {
      if (raw.fail) continue;
      expect(SCHEMAS[raw.transform].safeParse(raw.output).success, `${raw.transform}|${raw.query}`).toBe(true);
      const codes = raw.query.match(codePattern) ?? [];
      const text = JSON.stringify(raw.output);
      for (const code of codes) expect(text, `${raw.transform}|${raw.query}`).toContain(code);
    }
  });

  test('keys normalize NFC, trim and collapse whitespace; duplicate keys are rejected', () => {
    expect(normalizeFakeQuery('  á   b \n')).toBe('á b');
    const dup: FakeQueryLlmTable = {
      version: 1,
      entries: [
        { transform: 'expand', query: 'same', output: { queries: [] } },
        { transform: 'expand', query: ' same ', output: { queries: [] } },
      ],
    };
    expect(() => createFakeQueryLlm({ table: dup })).toThrow(/duplicate/);
  });

  test('a delay and a failure entry exist for every transform', () => {
    for (const transform of Object.keys(SCHEMAS)) {
      const own = table.entries.filter((entry) => entry.transform === transform);
      expect(own.some((entry) => (entry.delay_ms ?? 0) > 0)).toBe(true);
      expect(own.some((entry) => entry.fail === 'invalid')).toBe(true);
      expect(own.some((entry) => entry.fail === 'error')).toBe(true);
    }
  });
});
