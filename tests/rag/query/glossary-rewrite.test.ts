import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry, type FakeQueryLlmTable } from '../../../eval/harness/fake-query-llm.mts';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { checkBypassReason, type TurnFacts } from '@/lib/rag/cache/bypass';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { glossarySourceSurfaces, type GlossaryPair } from '@/lib/rag/query/glossary';
import { resetKbLanguageCacheForTests } from '@/lib/rag/query/kb-languages';
import { createLangChainTransformer } from '@/lib/rag/query/langchain';
import { createFakeLangChainChatModel, type FakeLangChainTable } from '@/lib/rag/query/langchain/fake';
import { checkCondensed, checkSubQuestions, checkVariant, DEFAULT_POST_CHECK_LIMITS } from '@/lib/rag/query/post-checks';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';
import { resetTranslatorForTests } from '@/lib/rag/query/translate';
import { getQueryTransformer, QUERY_TRANSFORM_FINISHERS, type QueryTransformer } from '@/lib/rag/query/transformer';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { resetTerminologyLexiconForTests } from '@/lib/rag/terminology/lexicon';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn } from '@/lib/rag/types';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const LIMITS = DEFAULT_POST_CHECK_LIMITS;
const TERM = 'quartz relay unit';
const TARGET = '石英中继单元';
const signal = () => new AbortController().signal;

const PAIRS: GlossaryPair[] = [
  { entryId: 'e-1', sourceLanguage: 'en', targetLanguage: 'zh', sources: [TERM], target: TARGET },
  { entryId: 'e-2', sourceLanguage: 'en', targetLanguage: 'it', sources: ['amber gauge'], target: 'indicatore ambra' },
  { entryId: 'e-3', sourceLanguage: 'it', targetLanguage: 'en', sources: ['modulo campione'], target: 'sample module' },
];

describe('glossarySourceSurfaces (D-14)', () => {
  it('returns the source surfaces found in the text as written there, for every target of the query language', () => {
    expect(glossarySourceSurfaces('How does the Quartz Relay Unit pair with the amber gauge?', 'en', PAIRS)).toEqual(['Quartz Relay Unit', 'amber gauge']);
  });

  it('ignores pairs of another source language, no glossary and no match', () => {
    expect(glossarySourceSurfaces('modulo campione and quartz relay unit', 'it', PAIRS)).toEqual(['modulo campione']);
    expect(glossarySourceSurfaces('What does the synthetic module report?', 'en', PAIRS)).toEqual([]);
    expect(glossarySourceSurfaces(`Where is the ${TERM}?`, 'en', null)).toEqual([]);
  });
});

describe('post-checks with glossaryProtected', () => {
  const input = `Where is the ${TERM} installed?`;

  it('a variant that drops a glossary term is discarded; one that keeps it passes', () => {
    expect(checkVariant({ kind: 'expand', text: 'relay installation site', input, protectedTokens: [], glossaryProtected: [TERM] }, LIMITS)).toEqual({
      ok: false,
      skip: { kind: 'expand', reason: 'protected_token_lost' },
    });
    expect(checkVariant({ kind: 'expand', text: `${TERM} installation site`, input, protectedTokens: [], glossaryProtected: [TERM] }, LIMITS)).toEqual({
      ok: true,
      text: `${TERM} installation site`,
    });
  });

  it('a condensed query that drops a glossary term falls back to the original', () => {
    expect(checkCondensed({ text: 'Where is the relay installed?', input, protectedTokens: [], glossaryProtected: [TERM] }, LIMITS)).toEqual({
      text: input,
      passThrough: false,
      skip: { kind: 'condense', reason: 'protected_token_lost' },
    });
    expect(checkCondensed({ text: `Where is the ${TERM} placed?`, input, protectedTokens: [], glossaryProtected: [TERM] }, LIMITS).skip).toBeNull();
  });

  it('sub-questions must keep every glossary term together, not each one', () => {
    const compare = `Compare the ${TERM} with the amber gauge`;
    const glossaryProtected = [TERM, 'amber gauge'];
    const kept = checkSubQuestions({ questions: [`What is the ${TERM}?`, 'What is the amber gauge?'], input: compare, protectedTokens: [], glossaryProtected }, LIMITS);
    expect(kept.subQuestions).toEqual([`What is the ${TERM}?`, 'What is the amber gauge?']);
    const lost = checkSubQuestions({ questions: ['What is the relay?', 'What is the amber gauge?'], input: compare, protectedTokens: [], glossaryProtected }, LIMITS);
    expect(lost).toEqual({ subQuestions: [], notCompound: false, skipped: [{ kind: 'decompose', reason: 'protected_token_lost' }] });
  });

  it('without glossary terms every result equals the result without the field', () => {
    const variant = { kind: 'expand' as const, text: 'relay installation site', input, protectedTokens: [] };
    expect(checkVariant({ ...variant, glossaryProtected: [] }, LIMITS)).toEqual(checkVariant(variant, LIMITS));
    const condensed = { text: 'Where is the relay installed?', input, protectedTokens: [] };
    expect(checkCondensed({ ...condensed, glossaryProtected: [] }, LIMITS)).toEqual(checkCondensed(condensed, LIMITS));
    const sub = { questions: ['What is the relay?', 'Where is it?'], input, protectedTokens: [] };
    expect(checkSubQuestions({ ...sub, glossaryProtected: [] }, LIMITS)).toEqual(checkSubQuestions(sub, LIMITS));
  });
});

describe('both frameworks discard a rewrite that loses a glossary term', () => {
  const QUERY = `${TERM} wiring`;
  const COMPARE = `Compare the ${TERM} and the amber gauge`;
  const FOLLOW_UP = 'Where is it installed?';
  const HISTORY: HistoryTurn[] = [
    { role: 'user', content: `Tell me about the ${TERM}.` },
    { role: 'assistant', content: 'It is a synthetic component.' },
  ];
  const table: FakeLangChainTable = {
    version: 1,
    entries: [
      { transform: 'expand', query: QUERY, output: { queries: [`${TERM} wiring diagram`, 'relay wiring diagram'] } },
      { transform: 'decompose', query: COMPARE, output: { questions: ['What is the relay?', 'What is the amber gauge?'] } },
      { transform: 'condense', query: FOLLOW_UP, output: { standalone: 'Where is the relay installed?', unchanged: false, language: null } },
    ],
  };

  function frameworks(): Record<'native' | 'langchain', QueryTransformer> {
    const nativeFake = createFakeQueryLlm({ table: table as unknown as FakeQueryLlmTable });
    setRagDepsForTests({ queryLlm: () => nativeFake });
    const fake = createFakeLangChainChatModel({ table });
    return {
      native: getQueryTransformer('llamaindex'),
      langchain: createLangChainTransformer({ chatModelFactory: () => fake, deps: { finish: QUERY_TRANSFORM_FINISHERS } }),
    };
  }

  afterEach(() => resetRagDepsForTests());

  test.each(['native', 'langchain'] as const)('%s: expand, decompose and condense', async (name) => {
    const transformer = frameworks()[name];
    const expand = await transformer.expand({ query: QUERY, language: 'en', protectedTokens: [], glossaryProtected: [TERM], maxItems: 2, signal: signal() });
    expect(expand.variants.map((variant) => variant.text)).toEqual([`${TERM} wiring diagram`]);
    expect(expand.skipped).toContainEqual({ kind: 'expand', reason: 'protected_token_lost', index: 1 });

    const decompose = await transformer.decompose({ query: COMPARE, language: 'en', protectedTokens: [], glossaryProtected: [TERM, 'amber gauge'], signal: signal() });
    expect(decompose.variants).toEqual([]);
    expect(decompose.skipped).toContainEqual({ kind: 'decompose', reason: 'protected_token_lost' });

    const condense = await transformer.condense({ query: FOLLOW_UP, history: HISTORY, language: 'en', protectedTokens: [], glossaryProtected: [TERM], signal: signal() });
    expect(condense.standalone).toBe(FOLLOW_UP);
    expect(condense.skip).toEqual({ kind: 'condense', reason: 'protected_token_lost' });

    const free = await transformer.expand({ query: QUERY, language: 'en', protectedTokens: [], maxItems: 2, signal: signal() });
    expect(free.variants.map((variant) => variant.text)).toEqual([`${TERM} wiring diagram`, 'relay wiring diagram']);
  });
});

describe('run-layer: glossaryProtected from the tenant glossary, cache bypass unchanged', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const QUERY = `${TERM} wiring`;
  const ENTRIES: FakeQueryLlmEntry[] = [
    { transform: 'expand', query: QUERY, output: { queries: [`${TERM} wiring diagram`, 'relay wiring diagram'] } },
    { transform: 'translate', query: QUERY, output: { target_language: 'zh', text: `${TARGET}接线`, source_language: null } },
  ];
  let scopeA: TenantScope;
  let scopeB: TenantScope;

  function termRow(entryId: string, source: string, target: string) {
    return {
      entry_id: entryId,
      layer: 'workspace',
      canonical: target,
      variants: [source],
      normalized_variants: [],
      language: 'en',
      kind: 'translation',
      mode: 'one_way',
      source_language: 'en',
      target_language: 'zh',
      shared_version: 1,
      tenant_version: 2,
    };
  }

  function install(terms: Record<string, Array<Record<string, unknown>>>) {
    const fake = createFakeQueryLlm({ table: { version: 1, entries: ENTRIES } });
    const rpc: RpcClient = {
      rpc(fn, args) {
        const tenant = String(args.p_tenant_key);
        const response: RpcResponse =
          fn === 'rag_tenant_language_shares'
            ? { data: [{ language: 'zh', share: 0.9, docs: 9 }, { language: 'en', share: 0.1, docs: 1 }], error: null }
            : fn === 'rag_term_effective'
              ? { data: terms[tenant] ?? [], error: null }
              : { data: null, error: { code: 'P0001', message: 'unexpected' } };
        const request = {
          abortSignal: () => request,
          then: (resolve: (value: RpcResponse) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
        };
        return request as ReturnType<RpcClient['rpc']>;
      },
    };
    setRagDepsForTests({ queryLlm: () => fake, adminClient: () => rpc as never });
  }

  async function run(scope: TenantScope, env: Record<string, string>) {
    resetRagConfigForTests();
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...env });
    const collector = createTraceCollector({ profile: 'chat', tenantKey: scopeKey(scope) });
    const requestSignal = signal();
    return runQueryStages({ input: { scope, query: QUERY, profile: 'chat', signal: requestSignal }, scope, config, profile: 'chat', signal: requestSignal, collector });
  }

  beforeEach(() => {
    uninstallDeps();
    resetKbLanguageCacheForTests();
    resetTranslatorForTests();
    invalidateTerminologyCache('all');
    resetTerminologyLexiconForTests();
    scopeA = mintScope('org', null, ORG_A);
    scopeB = mintScope('org', null, ORG_B);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    invalidateTerminologyCache('all');
    vi.restoreAllMocks();
  });

  function expanded(out: Awaited<ReturnType<typeof run>>): string[] {
    return out.variants.filter((variant) => variant.kind === 'expanded').map((variant) => variant.text);
  }

  it('switch on: the expansion that drops the term is discarded; switch off and the other tenant keep it', async () => {
    const terms = () => ({ [scopeKey(scopeA)]: [termRow('00000000-0000-4000-8000-00000000000a', TERM, TARGET)] });
    install(terms());
    const on = await run(scopeA, { RAG_TRANSLATION_GLOSSARY: 'true' });
    expect(expanded(on)).toEqual([`${TERM} wiring diagram`]);
    expect(on.plan?.skipped).toContainEqual({ transform: 'expand', reason: 'protected_token_lost' });

    invalidateTerminologyCache('all');
    resetTerminologyLexiconForTests();
    install(terms());
    const other = await run(scopeB, { RAG_TRANSLATION_GLOSSARY: 'true' });
    expect(expanded(other)).toEqual([`${TERM} wiring diagram`, 'relay wiring diagram']);

    install(terms());
    const off = await run(scopeA, {});
    expect(expanded(off)).toEqual([`${TERM} wiring diagram`, 'relay wiring diagram']);

    expect(on.plan?.gate.protectedTokens).toEqual([]);
    expect(on.plan?.gate.protectedTokens).toEqual(off.plan?.gate.protectedTokens);
  });

  it('a glossary-only query stays cacheable: the bypass decision does not see glossary terms', () => {
    const NOW = new Date('2026-06-15T12:00:00Z');
    const facts: TurnFacts = {
      profile: 'chat',
      evalCacheOverride: false,
      ragMode: 'strict',
      gate: needsRewrite(QUERY, { hasHistory: false, now: NOW }),
      rawQuery: QUERY,
      standalone: QUERY,
      historyLength: 0,
      condenseOk: true,
      webSearch: false,
      mcpTools: false,
      documentRefCount: 0,
      retrievalOptions: { maxResults: 5 },
      defaultMaxResults: 5,
    };
    expect(glossarySourceSurfaces(QUERY, 'en', PAIRS)).toEqual([TERM]);
    expect(checkBypassReason(facts)).toBeNull();
  });
});
