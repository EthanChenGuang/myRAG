import { describe, expect, it } from 'vitest';
import { parseRetrievalFilters } from '@/lib/rag/query/filters';
import { ScopeFilterError, resolveScopesFilter } from '@/lib/rag/query/scopes';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { hasNarrowingFilters } from '@/lib/rag/v2/stages/search';
import { loadRagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendSearchRequest, RetrievalFilters } from '@/lib/rag/backend/types';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const PROFILE = 'openai-3-small-1536';
const SCOPE = mintScope('personal', USER_A, null);

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function client(answer: (fn: string) => RpcResponse) {
  const calls: Call[] = [];
  const rpc: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(answer(fn)).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { rpc, calls };
}

const VOCABULARY = [
  { dimension: 'region', value: 'a1', label: 'Area one', aliases: [], active: true },
  { dimension: 'region', value: 'b2', label: 'Area two', aliases: [], active: true },
  { dimension: 'department', value: 'unit-x', label: 'Unit X', aliases: [], active: true },
  { dimension: 'legal_entity', value: 'old-one', label: 'Retired entity', aliases: [], active: false },
];

function vocabularyClient(rows: Record<string, unknown>[] = VOCABULARY) {
  return client(() => ({ data: rows, error: null }));
}

const scopesOn = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_SCOPE_TAGS: 'true' });

function baseRequest(filters: RetrievalFilters): BackendSearchRequest {
  return {
    scope: SCOPE,
    embeddingProfileId: PROFILE,
    denseVector: [0.1, 0.2, 0.3],
    lexicalTokens: ['term'],
    lexicalLanguages: null,
    filters,
    denseLimit: 5,
    lexicalLimit: 7,
    signal: new AbortController().signal,
  };
}

async function rpcArgsFor(filters: RetrievalFilters): Promise<Record<string, unknown>> {
  const recorded = client(() => ({ data: [], error: null }));
  const backend = createPgvectorBackend({ adminClient: () => recorded.rpc, getConfig: () => loadRagConfig({ RAG_PIPELINE: 'v2' }) });
  await backend.search(baseRequest(filters));
  expect(recorded.calls).toHaveLength(1);
  return recorded.calls[0]!.args;
}

/** The hybrid_search_chunks body a filter-free v2 search sent before scope tags existed. */
const RECORDED_FILTER_FREE_BODY = {
  p_tenant_key: `u:${USER_A}`,
  p_profile_id: PROFILE,
  p_query_embedding: [0.1, 0.2, 0.3],
  p_lexical_tokens: ['term'],
  p_dense_limit: 5,
  p_lexical_limit: 7,
  p_date_from: null,
  p_date_to: null,
  p_sources: null,
  p_document_ids: null,
  p_doc_types: null,
  p_languages: null,
  p_iterative_scan: 'off',
  p_exact_scan_cutoff: 0,
  p_lexical_languages: null,
  p_supplier: null,
  p_amount_min: null,
  p_amount_max: null,
  p_currency: null,
  p_chunking_override: null,
};

describe('retrievalFilters.scopes body schema (D-39)', () => {
  it('accepts one dimension and turns it into dimension:value tags', () => {
    const parsed = parseRetrievalFilters({ scopes: { region: ['a1'] }, includeUntagged: false });
    expect(parsed).toEqual({ ok: true, filters: { scopes: ['region:a1'] } });
  });

  it('keeps includeUntagged only when it is true', () => {
    const parsed = parseRetrievalFilters({ scopes: { region: ['a1'] }, includeUntagged: true });
    expect(parsed).toEqual({ ok: true, filters: { scopes: ['region:a1'], scopesIncludeUntagged: true } });
  });

  it('sorts and de-duplicates the tags whatever the order of dimensions and values', () => {
    const one = parseRetrievalFilters({ scopes: { region: ['b2', 'a1', 'a1'], department: ['unit-x'] } });
    const two = parseRetrievalFilters({ scopes: { department: ['unit-x'], region: ['a1', 'b2'] } });
    expect(one).toEqual(two);
    expect(one).toEqual({ ok: true, filters: { scopes: ['department:unit-x', 'region:a1', 'region:b2'] } });
  });

  it('rejects a fourth dimension', () => {
    const parsed = parseRetrievalFilters({ scopes: { team: ['a1'] } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.details[0]!.path).toContain('scopes');
  });

  it('rejects a value that is not a slug', () => {
    for (const value of ['A1', 'a 1', 'a1-', '-a1', 'a_1', '']) {
      const parsed = parseRetrievalFilters({ scopes: { region: [value] } });
      expect(parsed.ok, value).toBe(false);
    }
  });

  it('rejects includeUntagged that is not a boolean', () => {
    expect(parseRetrievalFilters({ scopes: { region: ['a1'] }, includeUntagged: 'yes' }).ok).toBe(false);
  });
});

describe('resolveScopesFilter checks the tenant vocabulary', () => {
  it('passes known active values and reads the vocabulary of the verified tenant only', async () => {
    const vocab = vocabularyClient();
    const filters = await resolveScopesFilter({ scopes: ['department:unit-x', 'region:a1'] }, { scope: SCOPE, config: scopesOn, client: vocab.rpc });
    expect(filters).toEqual({ scopes: ['department:unit-x', 'region:a1'] });
    expect(vocab.calls).toEqual([{ fn: 'rag_scope_vocabulary_for', args: { p_tenant_key: `u:${USER_A}` } }]);
  });

  it('throws unknown_scope_value for an absent value', async () => {
    const vocab = vocabularyClient();
    const error = await resolveScopesFilter({ scopes: ['region:zz'] }, { scope: SCOPE, config: scopesOn, client: vocab.rpc }).catch((e) => e);
    expect(error).toBeInstanceOf(ScopeFilterError);
    expect(error.code).toBe('unknown_scope_value');
    expect(error.status).toBe(400);
  });

  it('throws unknown_scope_value for a retired value', async () => {
    const vocab = vocabularyClient();
    const error = await resolveScopesFilter({ scopes: ['legal_entity:old-one'] }, { scope: SCOPE, config: scopesOn, client: vocab.rpc }).catch((e) => e);
    expect(error).toBeInstanceOf(ScopeFilterError);
    expect(error.code).toBe('unknown_scope_value');
  });

  it('treats a missing tenant as an empty vocabulary', async () => {
    const vocab = vocabularyClient();
    const error = await resolveScopesFilter({ scopes: ['region:a1'] }, { scope: null, config: scopesOn, client: vocab.rpc }).catch((e) => e);
    expect(error).toBeInstanceOf(ScopeFilterError);
    expect(error.code).toBe('unknown_scope_value');
    expect(vocab.calls).toEqual([]);
  });

  it('fails closed when the vocabulary cannot be read', async () => {
    const failing = client(() => ({ data: null, error: { message: 'boom', code: 'XX000' } }));
    const error = await resolveScopesFilter({ scopes: ['region:a1'] }, { scope: SCOPE, config: scopesOn, client: failing.rpc }).catch((e) => e);
    expect(error).toBeInstanceOf(ScopeFilterError);
    expect(error.code).toBe('scope_vocabulary_unavailable');
    expect(error.status).toBe(503);
  });

  it('leaves a filter without scopes untouched and reads nothing', async () => {
    const vocab = vocabularyClient();
    expect(await resolveScopesFilter(undefined, { scope: SCOPE, config: scopesOn, client: vocab.rpc })).toBeUndefined();
    expect(await resolveScopesFilter({ languages: ['en'] }, { scope: SCOPE, config: scopesOn, client: vocab.rpc })).toEqual({ languages: ['en'] });
    expect(vocab.calls).toEqual([]);
  });
});

describe('the pgvector backend arguments', () => {
  it('a filter-free search sends the recorded body byte for byte', async () => {
    const args = await rpcArgsFor({ currentOnly: true });
    expect(JSON.stringify(args)).toBe(JSON.stringify(RECORDED_FILTER_FREE_BODY));
  });

  it('a scopes filter adds p_scopes, and p_scopes_include_untagged only when asked', async () => {
    const narrow = await rpcArgsFor({ currentOnly: true, scopes: ['region:a1'] });
    expect(narrow.p_scopes).toEqual(['region:a1']);
    expect('p_scopes_include_untagged' in narrow).toBe(false);
    const wide = await rpcArgsFor({ currentOnly: true, scopes: ['region:a1'], scopesIncludeUntagged: true });
    expect(wide.p_scopes).toEqual(['region:a1']);
    expect(wide.p_scopes_include_untagged).toBe(true);
  });

  it('an empty scopes list sends no p_scopes', async () => {
    const args = await rpcArgsFor({ currentOnly: true, scopes: [], scopesIncludeUntagged: true });
    expect(JSON.stringify(args)).toBe(JSON.stringify(RECORDED_FILTER_FREE_BODY));
  });

  it('a scopes filter is a narrowing filter, so the exact-id leg stands down', () => {
    expect(hasNarrowingFilters({ currentOnly: true })).toBe(false);
    expect(hasNarrowingFilters({ currentOnly: true, scopes: [] })).toBe(false);
    expect(hasNarrowingFilters({ currentOnly: true, scopes: ['region:a1'] })).toBe(true);
  });
});
