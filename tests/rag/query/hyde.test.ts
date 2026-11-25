import { describe, expect, test } from 'vitest';
import { HypotheticalDocumentSchema } from '@/lib/rag-eval/contracts.generated';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { nativeHyde } from '@/lib/rag/query/llamaindex/hyde';
import hydeEn from '@/lib/rag/query/prompts/llamaindex.hyde.en.v1.json';
import hydeZh from '@/lib/rag/query/prompts/llamaindex.hyde.zh.v1.json';
import hydeIt from '@/lib/rag/query/prompts/llamaindex.hyde.it.v1.json';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';

const QUERIES = {
  en: 'what does component QX-210 measure',
  zh: '组件 QX-210 测量什么',
  it: 'che cosa misura il componente QX-210',
} as const;

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
const firstLine = (template: string) => template.split('\n')[0];

describe('nativeHyde', () => {
  test.each([
    ['en', hydeEn],
    ['zh', hydeZh],
    ['it', hydeIt],
  ] as const)('a %s query uses its own template and gives one dense-only hyde variant', async (language, prompt) => {
    const query = QUERIES[language];
    const passage = `${query}: a synthetic passage.`;
    const { deps, requests } = depsFor([{ transform: 'hyde', query, output: { passage } }]);
    const result = await nativeHyde({ query, language, protectedTokens: ['QX-210'], signal: signal(), deps });
    expect(requests).toHaveLength(1);
    expect(requests[0].schema).toBe(HypotheticalDocumentSchema);
    expect(requests[0].transform).toBe('hyde');
    expect(requests[0].prompt).toContain(firstLine(prompt.template));
    expect(requests[0].prompt).toContain(query);
    expect(requests[0].prompt).toContain('Mandatory rules:');
    for (const other of [hydeEn, hydeZh, hydeIt].filter((p) => p !== prompt)) {
      expect(requests[0].prompt).not.toContain(firstLine(other.template));
    }
    expect(result.variant).toEqual({ text: passage, language, kind: 'hyde', legs: 'dense', protectedOk: true });
  });

  test('the en template is HYDE_TMPL verbatim and every file records source, MIT and attribution', () => {
    expect(hydeEn.template).toBe(
      'Please write a passage to answer the question\nTry to include as many key details as possible.\n\n\n{{context_str}}\n\n\nPassage:"""\n',
    );
    for (const prompt of [hydeEn, hydeZh, hydeIt]) {
      expect(prompt.source).toContain('llama-index-core==0.14.26');
      expect(prompt.license).toBe('MIT');
      expect(prompt.attribution).toMatch(/LlamaIndex/);
    }
    expect(hydeZh.source).toMatch(/^derived from/);
    expect(hydeIt.source).toMatch(/^derived from/);
  });

  test('a passage without the protected token is kept and marked protectedOk false (A-10 exemption)', async () => {
    const query = QUERIES.en;
    const { deps } = depsFor([{ transform: 'hyde', query, output: { passage: 'The component measures a synthetic quantity.' } }]);
    const result = await nativeHyde({ query, language: 'en', protectedTokens: ['QX-210'], signal: signal(), deps });
    expect(result.variant).toMatchObject({ kind: 'hyde', legs: 'dense', protectedOk: false });
    expect(result.skipped).toEqual([]);
  });

  test('a passage over 500 characters is cut at the last sentence end under the limit and the cut is recorded', async () => {
    const query = QUERIES.en;
    const sentence = 'Alpha beta gamma delta epsilon zeta eta theta iota. ';
    const passage = sentence.repeat(20);
    expect(passage.length).toBeGreaterThan(500);
    const { deps } = depsFor([{ transform: 'hyde', query, output: { passage } }]);
    const result = await nativeHyde({ query, language: 'en', protectedTokens: [], signal: signal(), deps });
    expect(result.variant).not.toBeNull();
    const text = result.variant!.text;
    expect(Array.from(text).length).toBeLessThanOrEqual(500);
    expect(text.endsWith('.')).toBe(true);
    expect(text).toBe(sentence.repeat(9).trim());
    expect(result.truncated).toBe(true);
    expect(result.variant!.legs).toBe('dense');
  });

  test('a long zh passage is cut at the last full stop under the limit', async () => {
    const query = QUERIES.zh;
    const sentence = '这是一个用于测试的合成句子，内容没有实际含义。';
    const passage = sentence.repeat(40);
    const { deps } = depsFor([{ transform: 'hyde', query, output: { passage } }]);
    const result = await nativeHyde({ query, language: 'zh', protectedTokens: [], signal: signal(), deps });
    const text = result.variant!.text;
    expect(Array.from(text).length).toBeLessThanOrEqual(500);
    expect(text.endsWith('。')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test('the hyde passage is never returned as the standalone query', async () => {
    const query = QUERIES.en;
    const { deps } = depsFor([{ transform: 'hyde', query, output: { passage: 'A synthetic passage about QX-210.' } }]);
    const result = await nativeHyde({ query, language: 'en', protectedTokens: ['QX-210'], signal: signal(), deps });
    expect(result.variant?.kind).toBe('hyde');
    expect(Object.keys(result).sort()).toEqual(['skipped', 'truncated', 'variant']);
    expect(JSON.stringify(result)).not.toContain('standalone');
    expect(result.truncated).toBe(false);
  });

  test('an empty passage gives no variant and records empty; a failed call records error', async () => {
    const query = QUERIES.en;
    const empty = depsFor([{ transform: 'hyde', query, output: { passage: '  ' } }]);
    expect(await nativeHyde({ query, language: 'en', protectedTokens: [], signal: signal(), deps: empty.deps })).toEqual({
      variant: null,
      truncated: false,
      skipped: [{ kind: 'hyde', reason: 'empty' }],
    });
    const failed = depsFor([{ transform: 'hyde', query, fail: 'error' }]);
    expect(await nativeHyde({ query, language: 'en', protectedTokens: [], signal: signal(), deps: failed.deps })).toEqual({
      variant: null,
      truncated: false,
      skipped: [{ transform: 'hyde', reason: 'error' }],
    });
  });
});
