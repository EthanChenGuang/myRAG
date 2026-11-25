import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import { resetKbLanguageCacheForTests } from '@/lib/rag/query/kb-languages';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import {
  createFixtureTranslator,
  queryLayerTranslator,
  resetTranslatorForTests,
  setTranslatorForTests,
} from '@/lib/rag/query/translate';
import { QueryPlanSchema } from '@/lib/rag-eval/contracts.generated';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { Profile } from '@/lib/rag/types';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { statusRecords } from '@/lib/rag/v2/result';
import type { StageRecord } from '@/lib/rag/types';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const QUERY_EN = 'What does the synthetic module report each cycle?';
const QUERY_ZH = '合成模块每个周期报告什么？';
const QUERY_CODE = 'What does the synthetic module report for ERR_SAMPLE_42?';
const QUERY_CODE_ZH = '合成模块对 ERR_SAMPLE_42 报告什么？';

type Shares = Record<string, number>;

function sharesClient(byTenant: Record<string, Shares | 'error'>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const entry = byTenant[String(args.p_tenant_key)];
      const response: RpcResponse =
        entry === 'error' || entry === undefined
          ? { data: null, error: { code: 'P0001', message: 'synthetic failure' } }
          : { data: Object.entries(entry).map(([language, share]) => ({ language, share, docs: 1 })), error: null };
      const request = {
        abortSignal: () => request,
        then: (resolve: (value: RpcResponse) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  return { client, calls };
}

function install(entries: FakeQueryLlmEntry[], byTenant: Record<string, Shares | 'error'>) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      return fake.generate(request);
    },
  };
  const rpc = sharesClient(byTenant);
  setRagDepsForTests({ queryLlm: () => llm, adminClient: () => rpc.client as never });
  return { fake, rpc };
}

function config(over: Record<string, string> = {}) {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...over });
}

async function run(query: string, scope: TenantScope, options: { env?: Record<string, string>; profile?: Profile } = {}) {
  const profile = options.profile ?? 'chat';
  const collector = createTraceCollector({ profile, tenantKey: scopeKey(scope) });
  const signal = new AbortController().signal;
  const out = await runQueryStages({
    input: { scope, query, profile, signal },
    scope,
    config: config(options.env),
    profile,
    signal,
    collector,
  });
  const translateRecords = collector.stages().filter((row) => row.name === 'translate');
  return { out, translateRecords };
}

const translateEntry = (query: string, text: string, target: 'zh' | 'en' | 'it'): FakeQueryLlmEntry => ({
  transform: 'translate',
  query,
  output: { text, target_language: target },
});

describe('the query layer serves the D-22 translate slot', () => {
  let scopeA: TenantScope;
  let scopeB: TenantScope;

  beforeEach(() => {
    uninstallDeps();
    resetKbLanguageCacheForTests();
    resetTranslatorForTests();
    scopeA = mintScope('org', null, ORG_A);
    scopeB = mintScope('org', null, ORG_B);
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

  it('an English query on a mostly-zh KB runs translate in the layer and searches one zh variant with a zh lexical leg', async () => {
    const { fake } = install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    const { out, translateRecords } = await run(QUERY_EN, scopeA);

    expect(fake.calls).toEqual([{ transform: 'translate', input: QUERY_EN }]);
    expect(translateRecords).toHaveLength(1);
    expect(translateRecords[0]).toMatchObject({ status: 'ok', detail: 'targets=zh variants=1' });
    expect(out.queryLayer?.handledTranslate).toBe(true);
    const plan = out.queryLayer?.plan;
    expect(QueryPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan?.gate.reasons).toContain('R8_LANGUAGE_MISMATCH');
    expect(plan?.variants?.filter((variant) => variant.kind === 'translated')).toEqual([
      { text: QUERY_ZH, language: 'zh', kind: 'translated', sub_question_index: null, protected_ok: true },
    ]);
    const translated = out.variants.filter((variant) => variant.kind === 'translated');
    expect(translated).toEqual([expect.objectContaining({ text: QUERY_ZH, language: 'zh', legs: 'both' })]);
    expect(out.variants[0]).toMatchObject({ kind: 'original', text: QUERY_EN });
  });

  it('a tenant whose KB is mostly English does not translate, and the Phase 4 stage stands down', async () => {
    const { fake } = install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], { [scopeKey(scopeA)]: { en: 0.9, zh: 0.1 } });
    const { out, translateRecords } = await run(QUERY_EN, scopeA);

    expect(fake.calls).toEqual([]);
    expect(out.queryLayer?.plan?.gate.reasons).not.toContain('R8_LANGUAGE_MISMATCH');
    expect(translateRecords).toEqual([expect.objectContaining({ status: 'disabled', detail: 'handled_by_query_layer' })]);
    expect(out.variants.some((variant) => variant.kind === 'translated')).toBe(false);
  });

  it('unavailable shares skip translate with reason error and the request keeps the original', async () => {
    const { fake } = install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], { [scopeKey(scopeA)]: 'error' });
    const { out, translateRecords } = await run(QUERY_EN, scopeA);

    expect(fake.calls).toEqual([]);
    expect(out.queryLayer?.plan?.skipped).toContainEqual({ transform: 'translate', reason: 'error' });
    expect(translateRecords.every((record) => record.status !== 'skipped' && record.status !== 'failed')).toBe(true);
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original']);
  });

  it('an embedding profile listed in RAG_QUERY_TRANSLATE_DISABLED_PROFILES is disabled_for_profile with no shares read and no LLM call', async () => {
    const { fake, rpc } = install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    const { out } = await run(QUERY_EN, scopeA, { env: { RAG_QUERY_TRANSLATE_DISABLED_PROFILES: LEGACY_PROFILE.id } });

    expect(fake.calls).toEqual([]);
    expect(rpc.calls).toEqual([]);
    expect(out.queryLayer?.plan?.skipped).toContainEqual({ transform: 'translate', reason: 'disabled_for_profile' });
    expect(out.variants.some((variant) => variant.kind === 'translated')).toBe(false);
  });

  it('reads the shares with the request scope key only, cached per tenant', async () => {
    const { rpc } = install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], {
      [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 },
      [scopeKey(scopeB)]: { en: 1 },
    });
    const a = await run(QUERY_EN, scopeA);
    const b = await run(QUERY_EN, scopeB);
    await run(QUERY_EN, scopeA);

    expect(rpc.calls).toEqual([
      { fn: 'rag_tenant_language_shares', args: { p_tenant_key: scopeKey(scopeA) } },
      { fn: 'rag_tenant_language_shares', args: { p_tenant_key: scopeKey(scopeB) } },
    ]);
    expect(a.out.variants.some((variant) => variant.kind === 'translated')).toBe(true);
    expect(b.out.variants.some((variant) => variant.kind === 'translated')).toBe(false);
  });

  it('a failing translate call is skipped (stage skipped, plan error) and the request completes with the original', async () => {
    const { fake } = install([{ transform: 'translate', query: QUERY_EN, fail: 'error' }], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    const { out, translateRecords } = await run(QUERY_EN, scopeA);

    expect(fake.calls).toHaveLength(1);
    expect(translateRecords).toEqual([expect.objectContaining({ status: 'skipped', reason: 'failed' })]);
    expect(out.queryLayer?.plan?.skipped).toContainEqual({ transform: 'translate', reason: 'error' });
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original']);
  });

  it('a translation that drops a protected token is discarded and recorded as protected_token_lost', async () => {
    install([translateEntry(QUERY_CODE, '合成模块报告什么？', 'zh')], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    const { out, translateRecords } = await run(QUERY_CODE, scopeA);

    expect(translateRecords[0]?.status).toBe('ok');
    expect(out.queryLayer?.plan?.skipped).toContainEqual({ transform: 'translate', reason: 'protected_token_lost' });
    expect(out.variants.some((variant) => variant.kind === 'translated')).toBe(false);
  });

  it('a translation that keeps the protected token is searched', async () => {
    install([translateEntry(QUERY_CODE, QUERY_CODE_ZH, 'zh')], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    const { out } = await run(QUERY_CODE, scopeA);

    expect(out.variants.filter((variant) => variant.kind === 'translated').map((variant) => variant.text)).toEqual([QUERY_CODE_ZH]);
  });

  it('with the layer off and RAG_LEXICAL_TRANSLATION on, the Phase 4 fixture translator runs exactly as before', async () => {
    const { fake, rpc } = install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    setTranslatorForTests(
      createFixtureTranslator({ version: 1, entries: [{ question: QUERY_EN, translations: [{ text: '夹具翻译', language: 'zh' }] }] }),
    );
    const { out, translateRecords } = await run(QUERY_EN, scopeA, { env: { RAG_QUERY_LAYER: 'false', RAG_LEXICAL_TRANSLATION: 'true' } });

    expect(fake.calls).toEqual([]);
    expect(rpc.calls).toEqual([]);
    expect(out.queryLayer).toBeUndefined();
    expect(translateRecords).toEqual([expect.objectContaining({ status: 'ok' })]);
    expect(out.variants.map((variant) => [variant.kind, variant.text, variant.language])).toEqual([
      ['original', QUERY_EN, 'en'],
      ['translated', '夹具翻译', 'zh'],
    ]);
  });

  it('with the layer on, the fixture translator never runs on top of the layer (no double translation)', async () => {
    install([translateEntry(QUERY_EN, QUERY_ZH, 'zh')], { [scopeKey(scopeA)]: { zh: 0.85, en: 0.15 } });
    setTranslatorForTests(
      createFixtureTranslator({ version: 1, entries: [{ question: QUERY_EN, translations: [{ text: '夹具翻译', language: 'zh' }] }] }),
    );
    const { out } = await run(QUERY_EN, scopeA, { env: { RAG_LEXICAL_TRANSLATION: 'true' } });

    expect(out.variants.filter((variant) => variant.kind === 'translated').map((variant) => variant.text)).toEqual([QUERY_ZH]);
  });

  it('queryLayerTranslator honours the D-22 contract and translates nothing without query-layer targets', async () => {
    const signal = new AbortController().signal;
    expect(queryLayerTranslator.name).toBe('query_layer');
    await expect(queryLayerTranslator.translate(QUERY_EN, { signal, sourceLanguage: 'en' })).resolves.toEqual([]);
  });

  it('with zero survivors and core ok, a skipped layer translate is soft; the Phase 4 translate record still counts', () => {
    const record = (name: string, status: StageRecord['status']): StageRecord =>
      ({ name, status, startedAt: 0, endedAt: 0, latency_ms: 0, candidates_in: null, candidates_out: null, rules: [] }) as StageRecord;
    const records = [record('translate', 'skipped'), record('embed', 'ok'), record('search', 'ok'), record('fuse', 'ok')];

    expect(statusRecords(records, 0, true).map((row) => row.name)).toEqual(['embed', 'search', 'fuse']);
    expect(statusRecords(records, 0).map((row) => row.name)).toEqual(['translate', 'embed', 'search', 'fuse']);
  });
});
