import { describe, expect, test } from 'vitest';
import { SubQuestionsSchema } from '@/lib/rag-eval/contracts.generated';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { nativeDecompose } from '@/lib/rag/query/llamaindex/decompose';
import subqPrompt from '@/lib/rag/query/prompts/llamaindex.subq.v1.json';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';

const ZH_COMPARE = '组件甲和组件乙有什么区别？';
const EN_COMPOUND = 'compare the inputs, outputs and limits of units QX-1 and QX-2';

function depsFor(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const requests: Array<QueryLlmRequest<unknown>> = [];
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      requests.push(request as QueryLlmRequest<unknown>);
      return fake.generate(request);
    },
  };
  return { deps: { queryLlm: () => llm }, requests };
}

const signal = () => new AbortController().signal;

describe('nativeDecompose', () => {
  test('a comparison gives the scripted two sub-questions as sub_question variants with indexes 0 and 1', async () => {
    const { deps, requests } = depsFor([
      { transform: 'decompose', query: ZH_COMPARE, output: { questions: ['组件甲有哪些特点？', '组件乙有哪些特点？'] } },
    ]);
    const result = await nativeDecompose({ query: ZH_COMPARE, language: 'zh', protectedTokens: [], signal: signal(), deps });
    expect(result.notCompound).toBe(false);
    expect(result.variants).toEqual([
      { text: '组件甲有哪些特点？', language: 'zh', kind: 'sub_question', legs: 'both', protectedOk: true, subQuestionIndex: 0 },
      { text: '组件乙有哪些特点？', language: 'zh', kind: 'sub_question', legs: 'both', protectedOk: true, subQuestionIndex: 1 },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].transform).toBe('decompose');
    expect(requests[0].prompt).toContain('output a list of relevant sub-questions');
    expect(requests[0].prompt).toContain(`<User Question>\n${ZH_COMPARE}`);
    expect(requests[0].prompt).toContain('Return at most 4 item(s).');
    expect(requests[0].prompt).not.toMatch(/tool/i);
  });

  test('six scripted questions are cut to four and the cut is recorded', async () => {
    const questions = [
      'what are the inputs of QX-1',
      'what are the outputs of QX-1',
      'what are the limits of QX-1',
      'what are the inputs of QX-2',
      'what are the outputs of QX-2',
      'what are the limits of QX-2',
    ];
    const { deps } = depsFor([{ transform: 'decompose', query: EN_COMPOUND, output: { questions } }]);
    const result = await nativeDecompose({ query: EN_COMPOUND, language: 'en', protectedTokens: [], signal: signal(), deps });
    expect(result.variants.map((v) => v.text)).toEqual(questions.slice(0, 4));
    expect(result.variants.map((v) => v.subQuestionIndex)).toEqual([0, 1, 2, 3]);
    expect(result.skipped).toEqual([{ kind: 'decompose', reason: 'cap', count: 2 }]);
  });

  test('an empty list means not compound and gives no variant', async () => {
    const { deps } = depsFor([{ transform: 'decompose', query: EN_COMPOUND, output: { questions: [] } }]);
    const result = await nativeDecompose({ query: EN_COMPOUND, language: 'en', protectedTokens: [], signal: signal(), deps });
    expect(result).toEqual({ variants: [], notCompound: true, skipped: [] });
  });

  test('the output schema has no answer field; an extra answer key fails validation and skips with reason error', async () => {
    expect(Object.keys(SubQuestionsSchema.shape)).toEqual(['questions']);
    const { deps } = depsFor([
      {
        transform: 'decompose',
        query: EN_COMPOUND,
        fail: 'invalid',
        output: { questions: ['what are the inputs of QX-1'], answer: 'a synthetic answer' },
      },
    ]);
    const result = await nativeDecompose({ query: EN_COMPOUND, language: 'en', protectedTokens: [], signal: signal(), deps });
    expect(result).toEqual({ variants: [], notCompound: false, skipped: [{ transform: 'decompose', reason: 'error' }] });
  });

  test('sub-questions go through checkSubQuestions: one keeping no protected token is dropped', async () => {
    const { deps } = depsFor([
      {
        transform: 'decompose',
        query: EN_COMPOUND,
        output: { questions: ['what are the limits of QX-1', 'what are the limits of the second unit', 'what are the limits of QX-2'] },
      },
    ]);
    const result = await nativeDecompose({ query: EN_COMPOUND, language: 'en', protectedTokens: ['QX-1', 'QX-2'], signal: signal(), deps });
    expect(result.variants.map((v) => [v.text, v.subQuestionIndex])).toEqual([
      ['what are the limits of QX-1', 0],
      ['what are the limits of QX-2', 1],
    ]);
    expect(result.skipped).toEqual([{ kind: 'decompose', reason: 'protected_token_lost', index: 1 }]);
  });

  test('the prompt file records source, MIT license and attribution, and drops the tool list', () => {
    expect(subqPrompt.source).toContain('@llamaindex/core@0.6.23');
    expect(subqPrompt.license).toBe('MIT');
    expect(subqPrompt.attribution).toMatch(/LlamaIndex/);
    expect(subqPrompt.template).not.toMatch(/<Tools>|toolName|tools_str|toolsStr/);
  });
});
