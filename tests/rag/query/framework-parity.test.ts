import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createLangChainTransformer } from '@/lib/rag/query/langchain';
import { createFakeLangChainChatModel, type FakeLangChainEntry, type FakeLangChainTable } from '@/lib/rag/query/langchain/fake';
import { QUERY_TRANSFORM_FINISHERS, getQueryTransformer, type QueryTransformer } from '@/lib/rag/query/transformer';
import type { Lang } from '@/lib/rag/query/rewrite-gate';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import {
  CondensedQuerySchema,
  HypotheticalDocumentSchema,
  QueryTranslationSchema,
  QueryVariantsSchema,
  SubQuestionsSchema,
} from '@/lib/rag-eval/contracts.generated';
import type { HistoryTurn } from '@/lib/rag/types';
import { createFakeQueryLlm, type FakeQueryLlmTable } from '../../../eval/harness/fake-query-llm.mts';

const LANGS: readonly Lang[] = ['zh', 'en', 'it'];
const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'The sample module QX-210 reports a status code.' },
  { role: 'assistant', content: 'The status code means the module is waiting for input.' },
];
const signal = () => new AbortController().signal;

function committedTable(): FakeLangChainTable {
  return JSON.parse(readFileSync(join(process.cwd(), 'eval/fixtures/query-llm/transforms.json'), 'utf8')) as FakeLangChainTable;
}

/** Both transformers over the same table: the native one through RagDeps, the LangChain one through its chat-model seam. */
function frameworks(table: FakeLangChainTable): { native: QueryTransformer; langchain: QueryTransformer } {
  const nativeFake = createFakeQueryLlm({ table: table as unknown as FakeQueryLlmTable });
  setRagDepsForTests({ queryLlm: () => nativeFake });
  const fake = createFakeLangChainChatModel({ table });
  const langchain = createLangChainTransformer({ chatModelFactory: () => fake, deps: { finish: QUERY_TRANSFORM_FINISHERS } });
  return { native: getQueryTransformer('llamaindex'), langchain };
}

/** Paths whose values differ between two results; reported by the parity test, not failed. */
function differingFields(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return [path || '(root)'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) => differingFields((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`));
}

function languageOf(entry: FakeLangChainEntry): Lang {
  const prefix = (entry.item_id ?? '').replace(/^xl-/u, '').slice(0, 2);
  return (LANGS as readonly string[]).includes(prefix) ? (prefix as Lang) : 'en';
}

/** Every scripted query except the delay and failure probes. */
function fixtureInputs(): FakeLangChainEntry[] {
  return committedTable().entries.filter((entry) => !entry.fail && !entry.delay_ms);
}

const differences: Record<string, string[]> = {};

afterEach(() => resetRagDepsForTests());

describe('LangChain decompose', () => {
  const COMPARE = 'A 和 B 有什么区别？';
  const SIX = ['A 是什么？', 'B 是什么？', 'A 的特点是什么？', 'B 的特点是什么？', 'A 和 B 的共同点是什么？', 'A 和 B 的不同点是什么？'];

  test('keeps at most four sub-questions, uses the vendored decomposition prompt and structured SubQuestions', async () => {
    const entries: FakeLangChainEntry[] = [{ transform: 'decompose', query: COMPARE, output: { questions: SIX } }];
    const fake = createFakeLangChainChatModel({ table: { version: 1, entries } });
    const transformer = createLangChainTransformer({ chatModelFactory: () => fake, deps: { finish: QUERY_TRANSFORM_FINISHERS } });
    const result = await transformer.decompose({ query: COMPARE, language: 'zh', protectedTokens: [], signal: signal() });
    expect(result.variants.map((v) => v.text)).toEqual(SIX.slice(0, 4));
    expect(result.variants.every((v) => v.kind === 'sub_question' && v.legs === 'both')).toBe(true);
    expect(result.skipped).toContainEqual({ kind: 'decompose', reason: 'cap', count: 2 });
    expect(SubQuestionsSchema.safeParse({ questions: result.variants.map((v) => v.text) }).success).toBe(true);
    expect(fake.structuredRequests.map((r) => [r.name, r.method])).toEqual([['SubQuestions', 'jsonSchema']]);
    expect(fake.calls[0]?.prompt).toContain('Perform query decomposition.');
    expect(fake.calls[0]?.config).toMatchObject({ signal: true, callbacks: 0 });
  });

  test('matches native on the six-item output, an invalid output and a failed call', async () => {
    const entries: FakeLangChainEntry[] = [
      { transform: 'decompose', query: COMPARE, output: { questions: SIX } },
      { transform: 'decompose', query: 'synthetic decompose invalid probe', fail: 'invalid' },
      { transform: 'decompose', query: 'synthetic decompose error probe', fail: 'error' },
    ];
    const { native, langchain } = frameworks({ version: 1, entries });
    for (const entry of entries) {
      const input = { query: entry.query, language: languageOf(entry), protectedTokens: [], signal: signal() };
      expect(await langchain.decompose(input)).toEqual(await native.decompose(input));
    }
    const failed = await langchain.decompose({ query: 'synthetic decompose error probe', language: 'en', protectedTokens: [], signal: signal() });
    expect(failed.skipped).toEqual([{ transform: 'decompose', reason: 'error' }]);
  });

  test('an abort rejects, as on the native path', async () => {
    const { langchain } = frameworks({ version: 1, entries: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(langchain.decompose({ query: COMPARE, language: 'zh', protectedTokens: [], signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
  });
});

describe('LangChain translate', () => {
  const QUERY = 'What is the rated range of sensor QX-210?';
  const ZH = '传感器 QX-210 的额定量程是多少？';
  const IT = "Qual è l'intervallo nominale del sensore QX-210?";

  test('returns one QueryTranslation-valid variant per target with the shared translate prompt', async () => {
    const entries: FakeLangChainEntry[] = [
      { transform: 'translate', query: QUERY, output: { target_language: 'zh', text: ZH } },
      { transform: 'translate', query: QUERY, output: { target_language: 'it', text: IT } },
    ];
    const fake = createFakeLangChainChatModel({ table: { version: 1, entries } });
    const transformer = createLangChainTransformer({ chatModelFactory: () => fake, deps: { finish: QUERY_TRANSFORM_FINISHERS } });
    const result = await transformer.translate({ query: QUERY, language: 'en', targets: ['zh', 'it'], protectedTokens: ['QX-210'], signal: signal() });
    expect(result).toEqual({
      variants: [
        { kind: 'translated', language: 'zh', text: ZH },
        { kind: 'translated', language: 'it', text: IT },
      ],
      skipped: [],
    });
    for (const variant of result.variants) {
      expect(QueryTranslationSchema.safeParse({ target_language: variant.language, text: variant.text }).success).toBe(true);
    }
    expect(fake.structuredRequests.map((r) => r.name)).toEqual(['QueryTranslation', 'QueryTranslation']);
    expect(fake.calls.map((c) => c.prompt.includes('Translate the search query below into'))).toEqual([true, true]);
  });

  test('matches native on a missing target, an invalid output, a failed call and an abort', async () => {
    const entries: FakeLangChainEntry[] = [
      { transform: 'translate', query: QUERY, output: { target_language: 'zh', text: ZH } },
      { transform: 'translate', query: 'synthetic translate invalid probe', fail: 'invalid' },
      { transform: 'translate', query: 'synthetic translate error probe', fail: 'error' },
    ];
    const { native, langchain } = frameworks({ version: 1, entries });
    const aborted = new AbortController();
    aborted.abort();
    const inputs = [
      { query: QUERY, language: 'en' as const, targets: ['zh', 'it'] as Lang[], protectedTokens: ['QX-210'], signal: signal() },
      { query: 'synthetic translate invalid probe', language: 'en' as const, targets: ['zh'] as Lang[], protectedTokens: [], signal: signal() },
      { query: 'synthetic translate error probe', language: 'en' as const, targets: ['it'] as Lang[], protectedTokens: [], signal: signal() },
      { query: QUERY, language: 'en' as const, targets: ['zh'] as Lang[], protectedTokens: [], signal: aborted.signal },
    ];
    for (const input of inputs) expect(await langchain.translate(input)).toEqual(await native.translate(input));
    expect((await langchain.translate(inputs[3]!)).skipped).toEqual([{ kind: 'translate', target: 'zh', reason: 'aborted' }]);
  });
});

describe('the five transforms on the fixture inputs', () => {
  test('condense: both frameworks return CondensedQuery-valid results', async () => {
    const { native, langchain } = frameworks(committedTable());
    for (const entry of fixtureInputs()) {
      const input = { query: entry.query, history: HISTORY, language: languageOf(entry), protectedTokens: [], signal: signal() };
      const [a, b] = [await native.condense(input), await langchain.condense(input)];
      for (const result of [a, b]) expect(CondensedQuerySchema.safeParse({ standalone: result.standalone, unchanged: result.passThrough }).success).toBe(true);
      differences.condense = [...(differences.condense ?? []), ...differingFields(a, b)];
    }
  });

  test('expand: both frameworks return QueryVariants-valid results', async () => {
    const { native, langchain } = frameworks(committedTable());
    for (const entry of fixtureInputs()) {
      const input = { query: entry.query, language: languageOf(entry), protectedTokens: [], maxItems: 2, signal: signal() };
      const [a, b] = [await native.expand(input), await langchain.expand(input)];
      for (const result of [a, b]) expect(QueryVariantsSchema.safeParse({ queries: result.variants.map((v) => v.text) }).success).toBe(true);
      differences.expand = [...(differences.expand ?? []), ...differingFields(a, b)];
    }
  });

  test('hyde: both frameworks return HypotheticalDocument-valid results', async () => {
    const { native, langchain } = frameworks(committedTable());
    for (const entry of fixtureInputs()) {
      const input = { query: entry.query, language: languageOf(entry), protectedTokens: [], signal: signal() };
      const [a, b] = [await native.hyde(input), await langchain.hyde(input)];
      for (const result of [a, b]) {
        if (result.variant) expect(HypotheticalDocumentSchema.safeParse({ passage: result.variant.text }).success).toBe(true);
      }
      differences.hyde = [...(differences.hyde ?? []), ...differingFields(a, b)];
    }
  });

  test('decompose: both frameworks return SubQuestions-valid results', async () => {
    const { native, langchain } = frameworks(committedTable());
    const decomposeEntries = fixtureInputs().filter((entry) => entry.transform === 'decompose');
    expect(decomposeEntries.length).toBeGreaterThan(0);
    let withQuestions = 0;
    for (const entry of fixtureInputs()) {
      const input = { query: entry.query, language: languageOf(entry), protectedTokens: [], signal: signal() };
      const [a, b] = [await native.decompose(input), await langchain.decompose(input)];
      for (const result of [a, b]) expect(SubQuestionsSchema.safeParse({ questions: result.variants.map((v) => v.text) }).success).toBe(true);
      if (b.variants.length > 0) withQuestions += 1;
      differences.decompose = [...(differences.decompose ?? []), ...differingFields(a, b)];
    }
    expect(withQuestions).toBeGreaterThan(0);
  });

  test('translate: both frameworks return QueryTranslation-valid results (plumbing only, research A-6)', async () => {
    const { native, langchain } = frameworks(committedTable());
    let translated = 0;
    for (const entry of fixtureInputs()) {
      const language = languageOf(entry);
      const input = { query: entry.query, language, targets: LANGS.filter((l) => l !== language), protectedTokens: [], signal: signal() };
      const [a, b] = [await native.translate(input), await langchain.translate(input)];
      for (const result of [a, b]) {
        for (const v of result.variants) expect(QueryTranslationSchema.safeParse({ target_language: v.language, text: v.text }).success).toBe(true);
      }
      translated += b.variants.length;
      differences.translate = [...(differences.translate ?? []), ...differingFields(a, b)];
    }
    expect(translated).toBeGreaterThan(0);
  });

  test('reports the fields whose values differ between the frameworks', () => {
    const report = Object.entries(differences).map(([transform, fields]) => `${transform}: ${fields.length === 0 ? 'none' : [...new Set(fields)].join(', ')}`);
    console.info('[Framework Parity]', report.join('; '));
    expect(Object.keys(differences).sort()).toEqual(['condense', 'decompose', 'expand', 'hyde', 'translate']);
  });
});
