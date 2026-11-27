import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createLangChainTransformer } from '@/lib/rag/query/langchain';
import { createFakeLangChainChatModel, type FakeLangChainTable } from '@/lib/rag/query/langchain/fake';
import { QUERY_TRANSFORM_FINISHERS, getQueryTransformer, type QueryTransformer } from '@/lib/rag/query/transformer';
import { collectRequiredTerms, type RequiredTermSources } from '@/lib/rag/query/completeness';
import { needsRewrite, type Lang } from '@/lib/rag/query/rewrite-gate';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { createFakeQueryLlm, type FakeQueryLlmTable } from '../../../eval/harness/fake-query-llm.mts';

const NOW = new Date('2026-06-15T12:00:00Z');
const signal = () => new AbortController().signal;

const PROTECTED_DROP = '比较 QX-210 和 QX-220 的状态码含义有什么区别？';

/**
 * The committed table plus the protected-token drop: the committed table keeps every protected code by rule
 * (fake-query-llm.test.ts), so the one script that drops a code lives here.
 */
function buildTable(): FakeLangChainTable {
  const committed = JSON.parse(readFileSync(join(process.cwd(), 'eval/fixtures/query-llm/transforms.json'), 'utf8')) as FakeLangChainTable;
  return {
    ...committed,
    entries: [...committed.entries, { transform: 'decompose', query: PROTECTED_DROP, output: { questions: ['QX-210 的状态码含义是什么？'] } }],
  };
}

function frameworks(): { native: QueryTransformer; langchain: QueryTransformer } {
  const table = buildTable();
  const nativeFake = createFakeQueryLlm({ table: table as unknown as FakeQueryLlmTable });
  setRagDepsForTests({ queryLlm: () => nativeFake });
  const fake = createFakeLangChainChatModel({ table });
  return {
    native: getQueryTransformer('llamaindex'),
    langchain: createLangChainTransformer({ chatModelFactory: () => fake, deps: { finish: QUERY_TRANSFORM_FINISHERS } }),
  };
}

interface DropCase {
  name: string;
  query: string;
  language: Lang;
  sources?: RequiredTermSources;
  expected: string[];
  action: 'added' | 'discarded';
}

const CASES: DropCase[] = [
  {
    name: 'en period (R2 span)',
    query: 'Compare the sample index last year and this year.',
    language: 'en',
    expected: ['What was the sample index last year?', 'What was the sample index this year?'],
    action: 'added',
  },
  {
    name: 'it scope value',
    query: 'Quali sono le regole del modulo campione per la zona alfa e per la zona beta?',
    language: 'it',
    sources: { vocabulary: [{ label: 'Zona Alfa', aliases: [] }, { label: 'Zona Beta', aliases: [] }] },
    expected: [
      'Quali sono le regole del modulo campione per la zona alfa?',
      'Quali sono le regole del modulo campione per la zona beta?',
    ],
    action: 'added',
  },
  {
    name: 'zh protected token',
    query: PROTECTED_DROP,
    language: 'zh',
    expected: ['QX-210 的状态码含义是什么？', 'QX-220 的状态码含义是什么？'],
    action: 'added',
  },
  {
    name: 'en entity',
    query: 'How do the Alder Module and the Birch Module differ in setup?',
    language: 'en',
    expected: ['How is the Alder Module set up?', 'How is the Birch Module set up?'],
    action: 'added',
  },
  {
    name: 'en no sibling: the original is added',
    query: 'What does the sample guide say about 2024 and the Alder Module?',
    language: 'en',
    expected: ['What does the sample guide say about 2024?', 'What does the sample guide say about 2024 and the Alder Module?'],
    action: 'added',
  },
  {
    name: 'en fifth sub-question: discarded',
    query: 'Compare the sample totals of 2023 and 2024 in each quarter.',
    language: 'en',
    expected: [],
    action: 'discarded',
  },
];

afterEach(() => resetRagDepsForTests());

describe('decomposition completeness: LlamaIndex and LangChain parity', () => {
  for (const item of CASES) {
    test(`${item.name}: both frameworks repair the same way with the same counts`, async () => {
      const { native, langchain } = frameworks();
      const gate = needsRewrite(item.query, { hasHistory: false, now: NOW });
      const input = {
        query: item.query,
        language: item.language,
        protectedTokens: gate.protectedTokens,
        requiredTerms: collectRequiredTerms(item.query, gate, item.sources),
        signal: signal(),
      };
      const [a, b] = [await native.decompose(input), await langchain.decompose(input)];
      expect(b).toEqual(a);
      expect(a.variants.map((variant) => variant.text)).toEqual(item.expected);
      expect(a.variants.map((variant) => variant.subQuestionIndex)).toEqual(item.expected.map((_, index) => index));
      expect(a.completeness).toMatchObject({ missing_count: 1, action: item.action });
      expect(JSON.stringify(a.completeness)).not.toContain(item.query.slice(0, 12));
    });
  }

  test('without required terms both frameworks return the D-15 result and no completeness record', async () => {
    const { native, langchain } = frameworks();
    for (const item of CASES) {
      const gate = needsRewrite(item.query, { hasHistory: false, now: NOW });
      const input = { query: item.query, language: item.language, protectedTokens: gate.protectedTokens, signal: signal() };
      const [a, b] = [await native.decompose(input), await langchain.decompose(input)];
      expect(b).toEqual(a);
      expect('completeness' in a).toBe(false);
    }
  });
});
