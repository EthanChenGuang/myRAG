import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, BackendSearchRequest, RankedHit, RetrievalBackend, RetrievalFilterInput } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { checkBypassReason, type TurnFacts } from '@/lib/rag/cache/bypass';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { buildQueryPlan, planToVariants } from '@/lib/rag/query/plan';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';
import {
  isVersionQuestion,
  narrowFilters,
  parseProposedFilter,
  subQuestionVersionScope,
  SUB_QUESTION_FILTER_FIELDS,
  type NarrowVocabulary,
  type SubQuestionFilter,
  type VersionRules,
} from '@/lib/rag/query/subq-filters';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { hit } from '../fusion/helpers';
import { fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

/** Neutral synthetic vocabulary and questions; no domain strings. */
const VOCAB: NarrowVocabulary = { scopes: [], docTypes: ['general'], languages: ['en', 'it'] };
const ALLOWED: VersionRules = { versionScopeEffective: true, versionQuestion: true };

function proposal(overrides: Partial<SubQuestionFilter> = {}): SubQuestionFilter {
  return { date_range: null, scopes: null, doc_types: null, languages: null, ...overrides };
}

describe('SubQuestionFilter.versions contract (P-17)', () => {
  it('lists versions among the fields the decomposer may propose', () => {
    expect(SUB_QUESTION_FILTER_FIELDS).toContain('versions');
  });

  it('accepts the RET-11 values and a filter written without versions', () => {
    for (const versions of ['current', 'all', { from: '2023-01-01' }, { to: '2024-12-31' }, { from: '2023-01-01', to: '2024-12-31' }, null] as const) {
      expect(parseProposedFilter(proposal({ versions } as Partial<SubQuestionFilter>)).ok).toBe(true);
    }
    expect(parseProposedFilter(proposal())).toEqual({ ok: true, filter: proposal() });
  });

  it('rejects a version value outside the RET-11 shape', () => {
    expect(parseProposedFilter({ ...proposal(), versions: 'superseded' }).ok).toBe(false);
    expect(parseProposedFilter({ ...proposal(), versions: { from: '2023-01-01', tenant: 's:default' } }).ok).toBe(false);
  });
});

describe('isVersionQuestion (P-35)', () => {
  it('fires on a comparison or on a period term, not on a plain question', () => {
    const comparison = 'How does the first version compare with the second version of the sample note?';
    expect(isVersionQuestion(comparison, needsRewrite(comparison, { hasHistory: false, language: 'en', now: new Date('2026-11-27T00:00:00Z') }).reasons)).toBe(true);
    expect(isVersionQuestion('What did the sample note state last year?', [])).toBe(true);
    expect(isVersionQuestion('What did the sample note state in 2023?', [])).toBe(true);
    expect(isVersionQuestion('What does the sample note state?', [])).toBe(false);
    expect(isVersionQuestion('What does code FT-2025-00417 mean?', [])).toBe(false);
  });
});

describe('narrowFilters versions (D-06, P-35)', () => {
  it('a versions all proposal on a comparison or period question is accepted', () => {
    const out = narrowFilters(undefined, proposal({ versions: 'all' }), VOCAB, ALLOWED);
    expect(out.status).toBe('applied');
    expect(out.filters).toEqual({ versionScope: 'all' });
    expect(out.applied).toEqual(proposal({ versions: 'all' }));
  });

  it('the same proposal on a question without a comparison or a period term is dropped', () => {
    const out = narrowFilters(undefined, proposal({ versions: 'all' }), VOCAB, { versionScopeEffective: true, versionQuestion: false });
    expect(out).toEqual({ status: 'dropped_unknown_values', filters: undefined, applied: null });
    const withDocType = narrowFilters(undefined, proposal({ versions: 'all', doc_types: ['general'] }), VOCAB, {
      versionScopeEffective: true,
      versionQuestion: false,
    });
    expect(withDocType.status).toBe('applied');
    expect(withDocType.filters).toEqual({ docTypes: ['general'] });
    expect(withDocType.applied?.versions ?? null).toBeNull();
  });

  it('is dropped while RAG_VERSION_SCOPE is not effective, and without rules', () => {
    expect(narrowFilters(undefined, proposal({ versions: 'all' }), VOCAB, { versionScopeEffective: false, versionQuestion: true }).status).toBe(
      'dropped_unknown_values',
    );
    expect(narrowFilters(undefined, proposal({ versions: { from: '2023-01-01' } }), VOCAB).status).toBe('dropped_unknown_values');
  });

  it('a caller filter with versions current overrides any proposal', () => {
    const rules: VersionRules = { ...ALLOWED, callerCurrent: true };
    expect(narrowFilters(undefined, proposal({ versions: 'all' }), VOCAB, rules)).toEqual({
      status: 'dropped_unknown_values',
      filters: undefined,
      applied: null,
    });
    const mixed = narrowFilters(undefined, proposal({ versions: { to: '2024-12-31' }, doc_types: ['general'] }), VOCAB, rules);
    expect(mixed.filters).toEqual({ docTypes: ['general'] });
    expect(mixed.filters && 'versionScope' in mixed.filters).toBe(false);
  });

  it('never widens a caller version scope: a range intersects, all keeps the caller range, current narrows', () => {
    const range: RetrievalFilterInput = { versionScope: { from: '2022-01-01', to: '2024-12-31' } };
    const narrower = narrowFilters(range, proposal({ versions: { from: '2023-06-01' } }), VOCAB, { versionScopeEffective: true, versionQuestion: false });
    expect(narrower.status).toBe('applied');
    expect(narrower.filters?.versionScope).toEqual({ from: '2023-06-01', to: '2024-12-31' });
    expect(narrowFilters(range, proposal({ versions: { from: '2025-01-01' } }), VOCAB, ALLOWED).status).toBe('dropped_empty_intersection');
    expect(narrowFilters(range, proposal({ versions: 'all' }), VOCAB, ALLOWED).status).toBe('dropped_unknown_values');
    const current = narrowFilters({ versionScope: 'all' }, proposal({ versions: 'current' }), VOCAB, ALLOWED);
    expect(current.status).toBe('applied');
    expect(current.applied?.versions).toBe('current');
    expect(current.filters && 'versionScope' in current.filters).toBe(false);
  });

  it('a range with no bound or reversed bounds is dropped', () => {
    expect(narrowFilters(undefined, proposal({ versions: {} as { from?: string } }), VOCAB, ALLOWED).status).toBe('dropped_unknown_values');
    expect(narrowFilters(undefined, proposal({ versions: { from: '2024-01-01', to: '2023-01-01' } }), VOCAB, ALLOWED).status).toBe(
      'dropped_empty_intersection',
    );
  });

  it('keeps the request filters it does not own and adds no tenant field', () => {
    const base: RetrievalFilterInput = { documentIds: ['00000000-0000-4000-8000-000000000001'], sources: ['upload'] };
    const out = narrowFilters(base, proposal({ versions: 'all' }), VOCAB, ALLOWED);
    expect(out.filters).toEqual({ ...base, versionScope: 'all' });
    expect(Object.keys(out.filters ?? {}).some((key) => /tenant|scope_key|user/i.test(key))).toBe(false);
  });
});

describe('plan and cache (RET-11 text, P-35)', () => {
  const gate = needsRewrite('How does the first version compare with the second version of the sample note?', { hasHistory: false, language: 'en', now: new Date('2026-11-27T00:00:00Z') });

  function planWith(versions: SubQuestionFilter['versions']) {
    return buildQueryPlan({
      original: 'How does the first version compare with the second version of the sample note?',
      gate,
      framework: 'llamaindex',
      subQuestions: ['What did the first version state?', 'What does the second version state?'],
      subQuestionSpecs: [
        { text: 'What did the first version state?', filter: proposal({ versions }) },
        { text: 'What does the second version state?', filter: null },
      ],
    });
  }

  it('a sub-question with versions carries its scope to its variant only', () => {
    const variants = planToVariants(planWith('all'));
    const sub = variants.filter((variant) => variant.kind === 'sub_question');
    expect(sub[0]?.versionScope).toBe('all');
    expect(sub[1]?.versionScope).toBeUndefined();
    for (const variant of variants.filter((item) => item.kind !== 'sub_question')) expect(variant.versionScope).toBeUndefined();
  });

  it('subQuestionVersionScope reports the first non-current scope among the applied specs', () => {
    expect(subQuestionVersionScope(planWith('all').sub_question_specs)).toBe('all');
    expect(subQuestionVersionScope(planWith({ from: '2023-01-01' }).sub_question_specs)).toEqual({ from: '2023-01-01' });
    expect(subQuestionVersionScope(planWith('current').sub_question_specs)).toBeUndefined();
    expect(subQuestionVersionScope(undefined)).toBeUndefined();
  });

  it('a turn with versions all or range bypasses the cache with version_scope; current does not', () => {
    const facts = (versionScope?: TurnFacts['versionScope']): TurnFacts => ({
      profile: 'chat',
      evalCacheOverride: false,
      ragMode: 'strict',
      gate: { transforms: [], reasons: [], protectedTokens: [], skipRetrieval: false },
      rawQuery: 'What does the sample note state?',
      standalone: 'What does the sample note state?',
      historyLength: 0,
      condenseOk: true,
      webSearch: false,
      mcpTools: false,
      documentRefCount: 0,
      defaultMaxResults: 8,
      ...(versionScope !== undefined ? { versionScope } : {}),
    });
    expect(checkBypassReason(facts(subQuestionVersionScope(planWith('all').sub_question_specs)))).toBe('version_scope');
    expect(checkBypassReason(facts(subQuestionVersionScope(planWith({ to: '2024-12-31' }).sub_question_specs)))).toBe('version_scope');
    expect(checkBypassReason(facts(subQuestionVersionScope(planWith('current').sub_question_specs)))).toBeNull();
  });
});

describe('search stage: a sub-question version scope stays in the tenant (T-06.2-69)', () => {
  const SCOPE_A = mintScope('personal', '00000000-0000-4000-8000-0000000625a1', null);
  const SCOPE_B = mintScope('personal', '00000000-0000-4000-8000-0000000625b1', null);
  const ON = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_VERSION_SCOPE: 'true' };

  function rows(tenant: string, superseded: boolean): RankedHit[] {
    const current = hit(`${tenant}-current`, { rank: 1, lexicalScore: 1 });
    return superseded ? [current, hit(`${tenant}-older`, { rank: 2, lexicalScore: 0.9, isCurrent: false, documentVersion: 1 })] : [current];
  }

  function install(envVars: Record<string, string>): BackendSearchRequest[] {
    const requests: BackendSearchRequest[] = [];
    // Rows are chosen by the request scope only, as the RPC does with p_tenant_key; a version scope adds that tenant's older rows.
    const backend: RetrievalBackend = {
      id: 'pgvector',
      capabilities: { versionScope: true, identifierFilter: true },
      search: async (req): Promise<BackendLegs> => {
        requests.push(req);
        const tenant = scopeKey(req.scope) === scopeKey(SCOPE_A) ? 'a' : 'b';
        const superseded = req.versionScope !== undefined && req.versionScope !== 'current';
        return { dense: rows(tenant, false), lexical: rows(tenant, superseded) };
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
    installDeps({ embedder: fakeEmbedder().embedder, adminClient: fakeAssemblyAdmin(), ragEnv: () => envVars });
    setRetrievalBackendForTests(backend);
    return requests;
  }

  async function run(envVars: Record<string, string>, scope: TenantScope, variants: QueryVariant[]) {
    resetRagConfigForTests();
    const cfg: RagConfig = loadRagConfig(envVars);
    await verifyV2Startup();
    const collector = createTraceCollector({ profile: 'chat', tenantKey: scopeKey(scope) });
    return runSearchStages({
      input: { scope, query: variants[0]!.text, profile: 'chat', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'chat',
      params: effectiveRetrievalParams('chat', cfg, null),
      embedding: { vector: [0.1, 0.2], profile: null },
      signal: new AbortController().signal,
      collector,
      variants,
    });
  }

  const VARIANTS: QueryVariant[] = [
    { text: 'How does the first version compare with the second version?', language: 'en', kind: 'original' },
    { text: 'What did the first version state?', language: 'en', kind: 'sub_question', subQuestionIndex: 0, versionScope: 'all' },
    { text: 'What does the second version state?', language: 'en', kind: 'sub_question', subQuestionIndex: 1 },
  ];

  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('only the sub-question with versions all reads superseded rows, of its own tenant only', async () => {
    const requests = install(ON);
    const out = await run(ON, SCOPE_A, VARIANTS);
    const withScope = requests.filter((req) => req.versionScope !== undefined);
    expect(withScope).toHaveLength(1);
    expect(withScope[0]!.versionScope).toBe('all');
    for (const req of requests) {
      expect(scopeKey(req.scope)).toBe(scopeKey(SCOPE_A));
      expect(req.filters.currentOnly).toBe(true);
    }
    const ids = out.fusedHits.map((row) => row.hit.chunkId);
    expect(ids.some((id) => String(id).startsWith('a-older'))).toBe(true);
    expect(ids.some((id) => String(id).startsWith('b-'))).toBe(false);
    expect(out.versionScope).toBe('all');

    const requestsB = install(ON);
    const outB = await run(ON, SCOPE_B, VARIANTS);
    for (const req of requestsB) expect(scopeKey(req.scope)).toBe(scopeKey(SCOPE_B));
    expect(outB.fusedHits.map((row) => row.hit.chunkId).some((id) => id.startsWith('a-'))).toBe(false);
  });

  it('with RAG_VERSION_SCOPE off a variant scope is not sent and the search reports current', async () => {
    const off = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' };
    const requests = install(off);
    const out = await run(off, SCOPE_A, VARIANTS);
    for (const req of requests) expect('versionScope' in req).toBe(false);
    expect(out.versionScope).toBe('current');
  });
});
