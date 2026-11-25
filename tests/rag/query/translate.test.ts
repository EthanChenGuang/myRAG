import { describe, expect, test } from 'vitest';
import { QueryTranslationSchema } from '@/lib/rag-eval/contracts.generated';
import { QueryLlmError, type QueryLlm, type QueryLlmRequest } from '@/lib/rag/query/llm';
import { nativeTranslate } from '@/lib/rag/query/llamaindex/translate';
import { loadPrompt, PROMPT_REGISTRY } from '@/lib/rag/query/prompts/render';
import { createFakeQueryLlm, type FakeQueryLlmTable } from '../../../eval/harness/fake-query-llm.mts';

const PLAIN = 'What does the synthetic module report each cycle?';
const PLAIN_ZH = '合成模块每个周期报告什么？';
const PLAIN_IT = 'Che cosa riporta il modulo sintetico a ogni ciclo?';
const CODED = 'How does the sample service handle ERR_TIMEOUT?';
const WRONG = 'Which synthetic field holds the sample value?';
const SLOW = 'Which synthetic queue drains first?';

const table: FakeQueryLlmTable = {
  version: 1,
  entries: [
    { transform: 'translate', query: PLAIN, output: { target_language: 'zh', text: PLAIN_ZH } },
    { transform: 'translate', query: PLAIN, output: { target_language: 'it', text: PLAIN_IT } },
    { transform: 'translate', query: CODED, output: { target_language: 'zh', text: '示例服务如何处理超时错误？' } },
    { transform: 'translate', query: CODED, output: { target_language: 'it', text: 'Come gestisce ERR_TIMEOUT il servizio di esempio?' } },
    { transform: 'translate', query: WRONG, target_language: 'zh', output: { target_language: 'it', text: 'Quale campo sintetico contiene il valore?' } },
    { transform: 'translate', query: SLOW, target_language: 'zh', delay_ms: 5000, output: { target_language: 'zh', text: '哪个合成队列先清空？' } },
    { transform: 'translate', query: SLOW, target_language: 'it', delay_ms: 5000, output: { target_language: 'it', text: 'Quale coda sintetica si svuota per prima?' } },
  ],
};

function fakeDeps() {
  const llm = createFakeQueryLlm({ table });
  return { llm, deps: { queryLlm: () => llm } };
}

function recordingDeps(inner: QueryLlm) {
  const requests: Array<QueryLlmRequest<unknown>> = [];
  const llm: QueryLlm = {
    model: inner.model,
    generate<T>(request: QueryLlmRequest<T>) {
      requests.push(request as QueryLlmRequest<unknown>);
      return inner.generate(request);
    },
  };
  return { requests, deps: { queryLlm: () => llm } };
}

describe('nativeTranslate', () => {
  test('one target gives one translated variant in that language', async () => {
    const { deps } = fakeDeps();
    const result = await nativeTranslate({
      query: PLAIN,
      language: 'en',
      targets: ['zh'],
      protectedTokens: [],
      signal: new AbortController().signal,
      deps,
    });
    expect(result.variants).toEqual([{ kind: 'translated', language: 'zh', text: PLAIN_ZH }]);
    expect(result.skipped).toEqual([]);
  });

  test('each call uses the translate transform, QueryTranslationSchema and the shared prompt for its target', async () => {
    const { llm } = fakeDeps();
    const { requests, deps } = recordingDeps(llm);
    await nativeTranslate({
      query: CODED,
      language: 'en',
      targets: ['zh', 'it'],
      protectedTokens: ['ERR_TIMEOUT'],
      signal: new AbortController().signal,
      deps,
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.targetLanguage)).toEqual(['zh', 'it']);
    for (const request of requests) {
      expect(request.transform).toBe('translate');
      expect(request.schema).toBe(QueryTranslationSchema);
      expect(request.input).toBe(CODED);
      expect(request.prompt).toContain(CODED);
      expect(request.prompt).toContain('"ERR_TIMEOUT"');
      expect(request.prompt).toMatch(/verbatim/);
      expect(request.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
    expect(requests[0].prompt).toContain('Chinese');
    expect(requests[0].prompt).toContain('"zh"');
    expect(requests[1].prompt).toContain('Italian');
  });

  test('two targets run in parallel and give at most two variants', async () => {
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createFakeQueryLlm({ table });
    const llm: QueryLlm = {
      model: 'parallel-probe',
      async generate<T>(request: QueryLlmRequest<T>) {
        started += 1;
        if (started === 2) release();
        await bothStarted;
        return inner.generate(request);
      },
    };
    const result = await Promise.race([
      nativeTranslate({
        query: PLAIN,
        language: 'en',
        targets: ['zh', 'it', 'zh'],
        protectedTokens: [],
        signal: new AbortController().signal,
        deps: { queryLlm: () => llm },
      }),
      new Promise<'serial'>((resolve) => setTimeout(() => resolve('serial'), 1000)),
    ]);
    expect(result).not.toBe('serial');
    if (result === 'serial') return;
    expect(started).toBe(2);
    expect(result.variants.map((v) => v.language)).toEqual(['zh', 'it']);
    expect(result.variants.length).toBeLessThanOrEqual(2);
  });

  test('never more than two targets, and the query language itself is never a target', async () => {
    const { llm } = fakeDeps();
    const { requests, deps } = recordingDeps(llm);
    const result = await nativeTranslate({
      query: PLAIN,
      language: 'en',
      targets: ['en', 'zh', 'it'],
      protectedTokens: [],
      signal: new AbortController().signal,
      deps,
      maxItems: 5,
    });
    expect(requests.map((r) => r.targetLanguage)).toEqual(['zh', 'it']);
    expect(result.variants).toHaveLength(2);
  });

  test('a translation that loses a protected token is discarded with protected_token_lost', async () => {
    const { deps } = fakeDeps();
    const result = await nativeTranslate({
      query: CODED,
      language: 'en',
      targets: ['zh', 'it'],
      protectedTokens: ['ERR_TIMEOUT'],
      signal: new AbortController().signal,
      deps,
    });
    expect(result.variants.map((v) => v.language)).toEqual(['it']);
    expect(result.variants[0].text).toContain('ERR_TIMEOUT');
    expect(result.skipped).toEqual([{ kind: 'translate', target: 'zh', reason: 'protected_token_lost' }]);
  });

  test('a translation into a language that was not asked for fails validation and is skipped', async () => {
    const { deps } = fakeDeps();
    const result = await nativeTranslate({
      query: WRONG,
      language: 'en',
      targets: ['zh'],
      protectedTokens: [],
      signal: new AbortController().signal,
      deps,
    });
    expect(result.variants).toEqual([]);
    expect(result.skipped).toEqual([{ kind: 'translate', target: 'zh', reason: 'invalid_output' }]);
  });

  test('an empty translation is skipped and an LLM failure is recorded by kind', async () => {
    const llm: QueryLlm = {
      model: 'failing',
      async generate<T>(request: QueryLlmRequest<T>) {
        if (request.targetLanguage === 'zh') return { target_language: 'zh', text: '  ' } as T;
        throw new QueryLlmError('unavailable', 'translate');
      },
    };
    const result = await nativeTranslate({
      query: PLAIN,
      language: 'en',
      targets: ['zh', 'it'],
      protectedTokens: [],
      signal: new AbortController().signal,
      deps: { queryLlm: () => llm },
    });
    expect(result.variants).toEqual([]);
    expect(result.skipped).toEqual([
      { kind: 'translate', target: 'zh', reason: 'empty' },
      { kind: 'translate', target: 'it', reason: 'unavailable' },
    ]);
  });

  test('an abort cancels both calls', async () => {
    const { llm } = fakeDeps();
    const { requests, deps } = recordingDeps(llm);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = nativeTranslate({
      query: SLOW,
      language: 'en',
      targets: ['zh', 'it'],
      protectedTokens: [],
      signal: controller.signal,
      deps,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.signal.aborted)).toBe(true);
    expect(result.variants).toEqual([]);
    expect(result.skipped).toEqual([
      { kind: 'translate', target: 'zh', reason: 'aborted' },
      { kind: 'translate', target: 'it', reason: 'aborted' },
    ]);
  });

  test('no targets makes no call', async () => {
    const { llm, deps } = fakeDeps();
    const result = await nativeTranslate({
      query: PLAIN,
      language: 'en',
      targets: [],
      protectedTokens: [],
      signal: new AbortController().signal,
      deps,
    });
    expect(result).toEqual({ variants: [], skipped: [] });
    expect(llm.calls).toHaveLength(0);
  });
});

describe('shared translate prompt (research A-6)', () => {
  test('is registered and validates', () => {
    expect(Object.keys(PROMPT_REGISTRY)).toContain('shared.translate');
    const prompt = loadPrompt('shared.translate');
    expect(prompt).toMatchObject({ id: 'shared.translate', version: 1, source: 'myRAG', license: 'MIT' });
    expect(prompt.template.toLowerCase()).toMatch(/do not answer/);
  });
});
