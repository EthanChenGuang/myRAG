import { describe, expect, test } from 'vitest';
import { QueryVariantsSchema } from '@/lib/rag-eval/contracts.generated';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { nativeExpand } from '@/lib/rag/query/llamaindex/expand';
import fusionPrompt from '@/lib/rag/query/prompts/llamaindex.fusion.v1.json';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';

const ZH_QUERY = '设备 QX-210 的配置步骤';
const EN_QUERY = 'setup steps for module QX-210';

type Captured = { requests: Array<QueryLlmRequest<unknown>> };

function depsFor(entries: FakeQueryLlmEntry[]): { deps: { queryLlm: () => QueryLlm }; captured: Captured } {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const captured: Captured = { requests: [] };
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      captured.requests.push(request as QueryLlmRequest<unknown>);
      return fake.generate(request);
    },
  };
  return { deps: { queryLlm: () => llm }, captured };
}

const signal = () => new AbortController().signal;

describe('nativeExpand', () => {
  test('two scripted queries become two expanded variants; the original is not among them', async () => {
    const { deps, captured } = depsFor([
      {
        transform: 'expand',
        query: ZH_QUERY,
        output: { queries: [ZH_QUERY, '如何配置设备 QX-210', '设备 QX-210 的设置流程'] },
      },
    ]);
    const result = await nativeExpand({ query: ZH_QUERY, language: 'zh', protectedTokens: ['QX-210'], maxItems: 2, signal: signal(), deps });
    expect(result.variants.map((v) => v.text)).toEqual(['如何配置设备 QX-210', '设备 QX-210 的设置流程']);
    for (const variant of result.variants) {
      expect(variant).toMatchObject({ kind: 'expanded', language: 'zh', legs: 'both', protectedOk: true });
    }
    expect(result.variants.some((v) => v.text === ZH_QUERY)).toBe(false);
    expect(captured.requests).toHaveLength(1);
    const request = captured.requests[0];
    expect(request.transform).toBe('expand');
    expect(request.schema).toBe(QueryVariantsSchema);
    expect(request.input).toBe(ZH_QUERY);
    expect(request.prompt).toContain('Generate 2 search queries, one on each line, related to the following input query:');
    expect(request.prompt).toContain(`Query: ${ZH_QUERY}`);
    expect(request.prompt).toContain('Mandatory rules:');
    expect(request.prompt).toContain('Return at most 2 item(s).');
    expect(request.prompt).toContain('["QX-210"]');
  });

  test('four scripted queries with maxItems 2 keep the first two that pass and record cap for the rest', async () => {
    const { deps } = depsFor([
      {
        transform: 'expand',
        query: EN_QUERY,
        output: {
          queries: ['configure module QX-210', 'module QX-210 setup guide', 'installing QX-210', 'QX-210 initial setup'],
        },
      },
    ]);
    const result = await nativeExpand({ query: EN_QUERY, language: 'en', protectedTokens: ['QX-210'], maxItems: 2, signal: signal(), deps });
    expect(result.variants.map((v) => v.text)).toEqual(['configure module QX-210', 'module QX-210 setup guide']);
    expect(result.skipped).toEqual([{ kind: 'expand', reason: 'cap', count: 2 }]);
  });

  test('a query that drops a protected token is discarded and the others are kept', async () => {
    const { deps } = depsFor([
      {
        transform: 'expand',
        query: EN_QUERY,
        output: { queries: ['how to configure the module', 'module QX-210 setup guide'] },
      },
    ]);
    const result = await nativeExpand({ query: EN_QUERY, language: 'en', protectedTokens: ['QX-210'], maxItems: 2, signal: signal(), deps });
    expect(result.variants.map((v) => v.text)).toEqual(['module QX-210 setup guide']);
    expect(result.skipped).toEqual([{ kind: 'expand', reason: 'protected_token_lost', index: 0 }]);
  });

  test('maxItems 0 makes no LLM call', async () => {
    const { deps, captured } = depsFor([]);
    const result = await nativeExpand({ query: EN_QUERY, language: 'en', protectedTokens: [], maxItems: 0, signal: signal(), deps });
    expect(result).toEqual({ variants: [], skipped: [] });
    expect(captured.requests).toHaveLength(0);
  });

  test('an invalid model output skips the transform with reason error', async () => {
    const { deps } = depsFor([{ transform: 'expand', query: EN_QUERY, fail: 'invalid' }]);
    const result = await nativeExpand({ query: EN_QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: signal(), deps });
    expect(result).toEqual({ variants: [], skipped: [{ transform: 'expand', reason: 'error' }] });
  });

  test('an aborted call propagates so the stage runner records the timeout', async () => {
    const { deps } = depsFor([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      nativeExpand({ query: EN_QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: controller.signal, deps }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  test('the prompt file records the LlamaIndex source, MIT license and attribution', () => {
    expect(fusionPrompt.source).toContain('llama-index-core==0.14.26');
    expect(fusionPrompt.license).toBe('MIT');
    expect(fusionPrompt.attribution).toMatch(/LlamaIndex/);
  });
});
