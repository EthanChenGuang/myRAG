import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { resetKbLanguageCacheForTests } from '@/lib/rag/query/kb-languages';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { resetTranslatorForTests } from '@/lib/rag/query/translate';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const ORG = '33333333-3333-4333-8333-333333333333';
const QUERY_EN = 'What does the synthetic module report each cycle?';
const QUERY_ZH = '合成模块每个周期报告什么？';
const VOICE_TRANSLATE_TIMEOUT_MS = 250;
const WITH_TRANSLATE = 'condense_history,normalize_dates,translate';

const scope = mintScope('org', null, ORG);

function sharesClient(shares: Record<string, number>): RpcClient {
  return {
    rpc() {
      const response: RpcResponse = { data: Object.entries(shares).map(([language, share]) => ({ language, share, docs: 1 })), error: null };
      const request = {
        abortSignal: () => request,
        then: (resolve: (value: RpcResponse) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
}

function install(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      return fake.generate(request);
    },
  };
  setRagDepsForTests({ queryLlm: () => llm, adminClient: () => sharesClient({ zh: 0.85, en: 0.15 }) as never });
  return fake;
}

function voiceConfig(voiceTransforms?: string) {
  resetRagConfigForTests();
  return loadRagConfig({
    RAG_PIPELINE: 'v2',
    RAG_LEXICAL_SEARCH: 'false',
    RAG_RERANKER: 'none',
    RAG_QUERY_LAYER: 'true',
    ...(voiceTransforms !== undefined ? { RAG_QUERY_VOICE_TRANSFORMS: voiceTransforms } : {}),
  });
}

async function runVoice(voiceTransforms?: string) {
  const collector = createTraceCollector({ profile: 'voice', tenantKey: scopeKey(scope) });
  const signal = new AbortController().signal;
  const config = voiceConfig(voiceTransforms);
  const out = await runQueryStages({ input: { scope, query: QUERY_EN, profile: 'voice', signal }, scope, config, profile: 'voice', signal, collector });
  return { out, config, translate: collector.stages().filter((row) => row.name === 'translate') };
}

const translateEntry = (delayMs?: number): FakeQueryLlmEntry => ({
  transform: 'translate',
  query: QUERY_EN,
  output: { text: QUERY_ZH, target_language: 'zh', source_language: null },
  ...(delayMs !== undefined ? { delay_ms: delayMs } : {}),
});

describe('voice translate runs only when listed, inside its 250 ms budget (Phase 6.2 D-16, Phase 6 D-28)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetKbLanguageCacheForTests();
    resetTranslatorForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetKbLanguageCacheForTests();
    resetTranslatorForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('the default voice list stays condense_history,normalize_dates and the voice translate timeout is 250 ms under the layer', () => {
    const config = voiceConfig();
    expect(config.queryLayer.voiceTransforms).toEqual(['condense_history', 'normalize_dates']);
    expect(config.timeouts.voice.translate).toBe(VOICE_TRANSLATE_TIMEOUT_MS);
  });

  it('unlisted, translate never calls the model and the original query is the only variant', async () => {
    const fake = install([translateEntry()]);
    const { out, translate } = await runVoice();
    expect(fake.calls).toEqual([]);
    for (const row of translate) expect(row.status).toBe('disabled');
    expect(out.variants.filter((variant) => variant.kind === 'translated')).toEqual([]);
    expect(out.variants[0]).toMatchObject({ kind: 'original', text: QUERY_EN });
  });

  it('listed, voice translate runs and adds the translated variant beside the original', async () => {
    const fake = install([translateEntry()]);
    const { out, translate } = await runVoice(WITH_TRANSLATE);
    expect(fake.calls).toEqual([{ transform: 'translate', input: QUERY_EN }]);
    expect(translate).toHaveLength(1);
    expect(translate[0]).toMatchObject({ status: 'ok' });
    expect(out.variants[0]).toMatchObject({ kind: 'original', text: QUERY_EN });
    expect(out.variants.filter((variant) => variant.kind === 'translated')).toEqual([expect.objectContaining({ text: QUERY_ZH, language: 'zh' })]);
  });

  it('a 400 ms translate is skipped with reason timeout at 250 ms and the turn keeps the original query', async () => {
    install([translateEntry(400)]);
    const { out, translate } = await runVoice(WITH_TRANSLATE);
    expect(translate).toHaveLength(1);
    expect(translate[0]).toMatchObject({ status: 'skipped', reason: 'timeout' });
    expect(translate[0]!.endedAt - translate[0]!.startedAt).toBeGreaterThanOrEqual(VOICE_TRANSLATE_TIMEOUT_MS - 5);
    expect(translate[0]!.endedAt - translate[0]!.startedAt).toBeLessThan(400);
    expect(out.queryLayer?.plan?.skipped).toContainEqual({ transform: 'translate', reason: 'timeout' });
    expect(out.variants[0]).toMatchObject({ kind: 'original', text: QUERY_EN });
    expect(out.variants.filter((variant) => variant.kind === 'translated')).toEqual([]);
  });
});
