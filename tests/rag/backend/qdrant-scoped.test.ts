import { describe, expect, it } from 'vitest';
import {
  SCOPED_BUILDERS,
  assertScoped,
  qdrantScopedBatch,
  qdrantScopedRequest,
  scopedCount,
  scopedDeleteByFilter,
  scopedDeleteIds,
  scopedScroll,
  type QdrantFilter,
  type QdrantQueryNode,
} from '@/lib/rag/backend/qdrant/scoped-request';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';

const USER_A = '0f8e2c1a-9b7d-4c3e-8a21-5d6f7e8a9b0c';
const USER_B = '7c6b5a49-3827-4615-a4b3-c2d1e0f9a8b7';
const DOC_ID = '11111111-2222-4333-8444-555555555555';
const POINT_ID = '99999999-8888-4777-8666-555555555555';
const scopeA = mintScope('personal', USER_A.toUpperCase(), null);
const scopeB = mintScope('personal', USER_B, null);
const TENANT_A = { key: 'tenant_key', match: { value: `u:${USER_A}` } };
const TENANT_B = { key: 'tenant_key', match: { value: `u:${USER_B}` } };
const DENSE = [0.1, 0.2, 0.3];
const LEXICAL = { text: 'alpha beta' };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function mustOf(filter: QdrantFilter | null | undefined): unknown[] {
  const must = filter?.must;
  return Array.isArray(must) ? must : must ? [must] : [];
}

const asNode = (value: unknown) => value as QdrantQueryNode;
const SECURITY = /\[RAG Security\]/;

describe('qdrantScopedRequest', () => {
  it('adds a filter whose must is exactly the tenant clause when none is given', () => {
    const out = qdrantScopedRequest(scopeA, { query: DENSE, using: 'dense', limit: 5 });
    expect(out.filter).toEqual({ must: [TENANT_A] });
  });

  it('puts the tenant clause first and keeps must, should and must_not', () => {
    const docClause = { key: 'document_id', match: { value: DOC_ID } };
    const should = [{ key: 'language', match: { value: 'en' } }];
    const mustNot = [{ key: 'doc_type', match: { value: 'image' } }];
    const out = qdrantScopedRequest(scopeA, {
      query: DENSE,
      filter: { must: [docClause], should, must_not: mustNot },
    });
    expect(out.filter).toEqual({ must: [TENANT_A, docClause], should, must_not: mustNot });
  });

  it('normalises a single must condition into the list', () => {
    const docClause = { key: 'document_id', match: { value: DOC_ID } };
    const out = qdrantScopedRequest(scopeA, { query: DENSE, filter: { must: docClause } });
    expect(out.filter).toEqual({ must: [TENANT_A, docClause] });
  });

  it('scopes every prefetch at every depth', () => {
    const out = qdrantScopedRequest(scopeA, {
      query: { fusion: 'rrf' },
      prefetch: [
        { query: DENSE, using: 'dense', limit: 10 },
        { query: { fusion: 'rrf' }, prefetch: [{ query: DENSE, using: 'dense', limit: 10 }] },
      ],
    });
    const prefetch = out.prefetch as QdrantQueryNode[];
    expect(mustOf(out.filter)).toContainEqual(TENANT_A);
    expect(mustOf(prefetch[0].filter)).toEqual([TENANT_A]);
    expect(mustOf(prefetch[1].filter)).toEqual([TENANT_A]);
    expect(mustOf((prefetch[1].prefetch as QdrantQueryNode[])[0].filter)).toEqual([TENANT_A]);
  });

  it('handles a single prefetch object', () => {
    const out = qdrantScopedRequest(scopeA, {
      query: { fusion: 'rrf' },
      prefetch: { query: DENSE, using: 'dense', limit: 10 },
    });
    const prefetch = Array.isArray(out.prefetch) ? out.prefetch : [out.prefetch as QdrantQueryNode];
    expect(prefetch).toHaveLength(1);
    expect(mustOf(prefetch[0].filter)).toEqual([TENANT_A]);
  });

  it('adds the tenant clause to an existing idf corpus filter', () => {
    const lang = { key: 'language', match: { value: 'en' } };
    const out = qdrantScopedRequest(scopeA, {
      query: LEXICAL,
      using: 'lexical_text',
      params: { idf: { corpus: { must: [lang] } } },
    });
    expect(out.params?.idf).toEqual({ corpus: { must: [TENANT_A, lang] } });
  });

  it('gives a lexical query without idf a tenant-scoped corpus', () => {
    const out = qdrantScopedRequest(scopeA, { query: LEXICAL, using: 'lexical_text', params: { acorn: { enable: true } } });
    expect(out.params).toEqual({ acorn: { enable: true }, idf: { corpus: { must: [TENANT_A] } } });
    const nested = qdrantScopedRequest(scopeA, { query: { fusion: 'rrf' }, prefetch: [{ query: { nearest: LEXICAL } }] });
    expect((nested.prefetch as QdrantQueryNode[])[0].params?.idf).toEqual({ corpus: { must: [TENANT_A] } });
  });

  it('uses the lower-case key for a scope minted from an upper-case UUID', () => {
    const out = qdrantScopedRequest(scopeA, { query: DENSE });
    expect(JSON.stringify(out)).not.toContain(USER_A.toUpperCase());
  });

  it('rejects lookup_from, shard_key, with_lookup and global idf at any depth', () => {
    const cases: unknown[] = [
      { query: DENSE, lookup_from: { collection: 'other' } },
      { query: DENSE, shard_key: 'tenant-b' },
      { query: { fusion: 'rrf' }, prefetch: [{ query: DENSE, lookup_from: { collection: 'other' } }] },
      { query: { fusion: 'rrf' }, prefetch: [{ query: { fusion: 'rrf' }, prefetch: [{ query: DENSE, shard_key: 'b' }] }] },
      { query: LEXICAL, params: { idf: 'global' } },
      { query: { fusion: 'rrf' }, prefetch: [{ query: { fusion: 'rrf' }, prefetch: [{ query: LEXICAL, params: { idf: 'global' } }] }] },
      { query: DENSE, with_lookup: { collection: 'other' } },
    ];
    for (const node of cases) expect(() => qdrantScopedRequest(scopeA, asNode(node))).toThrow(SECURITY);
  });

  it('rejects a caller-supplied tenant_key condition anywhere', () => {
    expect(() => qdrantScopedRequest(scopeA, { query: DENSE, filter: { should: [TENANT_B] } })).toThrow(SECURITY);
    expect(() =>
      qdrantScopedRequest(scopeA, { query: { fusion: 'rrf' }, prefetch: [{ query: DENSE, filter: { must_not: [TENANT_B] } }] }),
    ).toThrow(SECURITY);
    expect(() => qdrantScopedRequest(scopeA, { query: DENSE, filter: { must: [{ must: [TENANT_A] }] } })).toThrow(SECURITY);
  });

  it('rejects queries that look up stored points by id', () => {
    const cases: unknown[] = [
      { query: POINT_ID },
      { query: 42 },
      { query: { nearest: POINT_ID } },
      { query: { recommend: { positive: [POINT_ID] } } },
      { query: { discover: { target: POINT_ID, context: [] } } },
      { query: { context: [{ positive: POINT_ID, negative: POINT_ID }] } },
      { query: [POINT_ID] },
    ];
    for (const node of cases) expect(() => qdrantScopedRequest(scopeA, asNode(node))).toThrow(SECURITY);
  });

  it('rejects unknown request keys', () => {
    expect(() => qdrantScopedRequest(scopeA, asNode({ query: DENSE, collection_name: 'other' }))).toThrow(SECURITY);
    expect(() =>
      qdrantScopedRequest(scopeA, asNode({ query: DENSE, params: { exact: true, corpus_override: {} } })),
    ).toThrow(SECURITY);
  });

  it('rejects a forged scope', () => {
    const forged = { kind: 'personal', userId: USER_A, organizationId: null } as unknown as TenantScope;
    expect(() => qdrantScopedRequest(forged, { query: DENSE })).toThrow(/\[RAG Tenant\]/);
  });

  it('never mutates its input', () => {
    const input = {
      query: { fusion: 'rrf' as const },
      filter: { must: [{ key: 'document_id', match: { value: DOC_ID } }] },
      prefetch: [
        { query: DENSE, using: 'dense', limit: 10 },
        { query: LEXICAL, using: 'lexical_text', limit: 10, params: { idf: { corpus: { must: [] } } } },
      ],
    };
    const snapshot = structuredClone(input);
    deepFreeze(input);
    qdrantScopedRequest(scopeA, input);
    expect(input).toEqual(snapshot);
  });
});

describe('qdrantScopedBatch', () => {
  it('scopes every search in the batch', () => {
    const out = qdrantScopedBatch(scopeA, {
      searches: [
        { query: DENSE, using: 'dense', limit: 5, params: { acorn: { enable: true } }, with_payload: false },
        { query: LEXICAL, using: 'lexical_text', limit: 5, params: { idf: { corpus: { must: [] } } } },
      ],
    });
    expect(out.searches).toHaveLength(2);
    for (const search of out.searches) expect(mustOf(search.filter)[0]).toEqual(TENANT_A);
    expect(out.searches[1].params?.idf).toEqual({ corpus: { must: [TENANT_A] } });
  });

  it('rejects an empty batch and a forbidden key in one search', () => {
    expect(() => qdrantScopedBatch(scopeA, { searches: [] })).toThrow(SECURITY);
    expect(() =>
      qdrantScopedBatch(scopeA, { searches: [{ query: DENSE }, asNode({ query: DENSE, shard_key: 'b' })] }),
    ).toThrow(SECURITY);
  });
});

describe('assertScoped negative controls', () => {
  it('negative control (a): throws when the top-level filter lacks the clause', () => {
    expect(() => assertScoped({ query: DENSE }, scopeA)).toThrow(SECURITY);
    expect(() => assertScoped({ query: DENSE, filter: { must: [] } }, scopeA)).toThrow(SECURITY);
    expect(() => assertScoped({ query: DENSE, filter: { should: [TENANT_A] } }, scopeA)).toThrow(SECURITY);
  });

  it('negative control (b): throws when a depth-1 prefetch lacks the clause', () => {
    const request = { query: { fusion: 'rrf' }, filter: { must: [TENANT_A] }, prefetch: [{ query: DENSE }] };
    expect(() => assertScoped(request, scopeA)).toThrow(SECURITY);
  });

  it('negative control (c): throws when a depth-2 prefetch lacks the clause', () => {
    const request = {
      query: { fusion: 'rrf' },
      filter: { must: [TENANT_A] },
      prefetch: [{ query: { fusion: 'rrf' }, filter: { must: [TENANT_A] }, prefetch: { query: DENSE, filter: { must: [] } } }],
    };
    expect(() => assertScoped(request, scopeA)).toThrow(SECURITY);
  });

  it('negative control (d): throws when idf.corpus lacks the clause or a lexical query has no idf', () => {
    const missingCorpusClause = { query: LEXICAL, filter: { must: [TENANT_A] }, params: { idf: { corpus: { must: [] } } } };
    const missingCorpus = { query: LEXICAL, filter: { must: [TENANT_A] }, params: { idf: {} } };
    const missingIdf = { query: LEXICAL, filter: { must: [TENANT_A] } };
    const nestedMissing = {
      query: { fusion: 'rrf' },
      filter: { must: [TENANT_A] },
      prefetch: [{ query: LEXICAL, filter: { must: [TENANT_A] }, params: { idf: { corpus: { must: [TENANT_B] } } } }],
    };
    for (const request of [missingCorpusClause, missingCorpus, missingIdf, nestedMissing]) {
      expect(() => assertScoped(request, scopeA)).toThrow(SECURITY);
    }
  });

  it('negative control (e): throws when the clause carries a different tenant value', () => {
    expect(() => assertScoped({ query: DENSE, filter: { must: [TENANT_B] } }, scopeA)).toThrow(SECURITY);
    expect(() => assertScoped(qdrantScopedRequest(scopeB, { query: DENSE }), scopeA)).toThrow(SECURITY);
    const upper = { key: 'tenant_key', match: { value: `u:${USER_A.toUpperCase()}` } };
    expect(() => assertScoped({ query: DENSE, filter: { must: [upper] } }, scopeA)).toThrow(SECURITY);
    const widened = { key: 'tenant_key', match: { any: [`u:${USER_A}`, `u:${USER_B}`] } };
    expect(() => assertScoped({ query: DENSE, filter: { must: [widened] } }, scopeA)).toThrow(SECURITY);
  });

  it('negative control (f): throws when one search in a batch lacks the clause', () => {
    const batch = { searches: [{ query: DENSE, filter: { must: [TENANT_A] } }, { query: DENSE }] };
    expect(() => assertScoped(batch, scopeA)).toThrow(SECURITY);
  });

  it('negative control (g): throws for a delete by point ids without a filter', () => {
    expect(() => assertScoped({ points: [POINT_ID] }, scopeA)).toThrow(SECURITY);
    expect(() => assertScoped({ points: [POINT_ID], filter: { must: [TENANT_A] } }, scopeA)).toThrow(SECURITY);
  });

  it('negative control (h): throws for forbidden keys in an otherwise scoped request', () => {
    const request = { query: DENSE, filter: { must: [TENANT_A] }, lookup_from: { collection: 'other' } };
    expect(() => assertScoped(request, scopeA)).toThrow(SECURITY);
  });

  it('passes for a correctly scoped request', () => {
    expect(() => assertScoped({ query: DENSE, filter: { must: [TENANT_A] } }, scopeA)).not.toThrow();
  });
});

describe('scoped builders', () => {
  it('scopedCount scopes the filter', () => {
    expect(scopedCount(scopeA, { exact: true })).toEqual({ exact: true, filter: { must: [TENANT_A] } });
    expect(scopedCount(scopeA).filter).toEqual({ must: [TENANT_A] });
  });

  it('scopedScroll keeps the cursor and scopes the filter', () => {
    const out = scopedScroll(scopeA, { limit: 100, offset: POINT_ID, with_payload: ['document_id'] });
    expect(out).toEqual({ limit: 100, offset: POINT_ID, with_payload: ['document_id'], filter: { must: [TENANT_A] } });
  });

  it('scopedDeleteByFilter scopes a document delete and rejects an empty filter', () => {
    const docClause = { key: 'document_id', match: { value: DOC_ID } };
    expect(scopedDeleteByFilter(scopeA, { must: [docClause] })).toEqual({ filter: { must: [TENANT_A, docClause] } });
    expect(() => scopedDeleteByFilter(scopeA, {})).toThrow(SECURITY);
    expect(() => scopedDeleteByFilter(scopeA, { must: [] })).toThrow(SECURITY);
  });

  it('scopedDeleteIds deletes ids only within the tenant', () => {
    expect(scopedDeleteIds(scopeA, [POINT_ID, DOC_ID])).toEqual({
      filter: { must: [TENANT_A, { has_id: [POINT_ID, DOC_ID] }] },
    });
    expect(() => scopedDeleteIds(scopeA, [])).toThrow(SECURITY);
    expect(() => scopedDeleteIds(scopeA, ['not-a-uuid'])).toThrow(SECURITY);
  });

  const samples: { [K in keyof typeof SCOPED_BUILDERS]: () => unknown } = {
    qdrantScopedRequest: () =>
      qdrantScopedRequest(scopeA, {
        query: { fusion: 'rrf' },
        prefetch: [{ query: DENSE, using: 'dense' }, { query: { fusion: 'rrf' }, prefetch: { query: LEXICAL } }],
      }),
    qdrantScopedBatch: () =>
      qdrantScopedBatch(scopeA, { searches: [{ query: DENSE }, { query: LEXICAL, using: 'lexical_text' }] }),
    scopedCount: () => scopedCount(scopeA, { exact: false }),
    scopedScroll: () => scopedScroll(scopeA, { limit: 10, offset: POINT_ID }),
    scopedDeleteByFilter: () => scopedDeleteByFilter(scopeA, { must: [{ key: 'document_id', match: { value: DOC_ID } }] }),
    scopedDeleteIds: () => scopedDeleteIds(scopeA, [POINT_ID]),
  };

  it('every exported builder produces output that passes assertScoped', () => {
    const names = Object.keys(SCOPED_BUILDERS) as (keyof typeof SCOPED_BUILDERS)[];
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      expect(samples[name], `sample for ${name}`).toBeTypeOf('function');
      const out = samples[name]();
      expect(() => assertScoped(out, scopeA), name).not.toThrow();
      expect(() => assertScoped(out, scopeB), name).toThrow(SECURITY);
    }
  });
});
