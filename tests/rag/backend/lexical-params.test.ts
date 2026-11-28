import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { resetBackendFactoryForTests, resolveRetrievalBackend, setExternalBackendForTests } from '@/lib/rag/backend/factory';
import {
  LEXICAL_PARAMS_CHECK_TTL_MS,
  LEXICAL_PARAMS_MISMATCH,
  LexicalParamsMismatchError,
  createLexicalParamsCheck,
  externalLexicalParams,
  isLexicalParamsStore,
  lexicalParamsMismatchMessage,
  recordedLexicalParams,
  resetLexicalParamsChecks,
  sameLexicalParams,
} from '@/lib/rag/backend/lexical-params';
import { createQdrantBackend, searchQdrantLegs } from '@/lib/rag/backend/qdrant/adapter';
import { QDRANT_PAYLOAD_INDEXES, describeQdrantCollection, qdrantCollectionSpec } from '@/lib/rag/backend/qdrant/collection';
import { assertScoped, qdrantScopedBatch } from '@/lib/rag/backend/qdrant/scoped-request';
import { READINESS_TTL_MS, resetReadinessCacheForTests } from '@/lib/rag/backend/readiness';
import { backendForRequest, resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { canonicalTenantKey, qdrantCollectionName, weaviateCollectionName, weaviateTenantName } from '@/lib/rag/backend/tenant-key';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { createWeaviateBackend, createWeaviateReader, searchWeaviateLegs } from '@/lib/rag/backend/weaviate/adapter';
import { describeWeaviateCollection, ensureWeaviateCollection, weaviateCollectionSpec } from '@/lib/rag/backend/weaviate/collection';
import { LEXICAL_SCORING_DEFAULTS, loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import type { StoreSearchRequest } from '@/lib/rag/sync/stores/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { lexicalScoringArg } from '@/lib/rag/v2/stages/search';
import { hit } from '../fusion/helpers';
import { createFakeQdrantClient, scopedBodyOf } from './qdrant-fake-client';
import { createFakeWeaviate } from './weaviate-fake';

const PROFILE = 'neutral-profile-3';
const SCOPE = mintScope('personal', '00000000-0000-4000-8000-0000000000a1', null);
const TENANT_KEY = canonicalTenantKey(SCOPE);
const BASE = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_SUPPORTED_LANGUAGES: 'en', RAG_PRIMARY_LANGUAGE: 'en' };
const BM25_15 = { ...BASE, RAG_LEXICAL_SCORING: 'bm25', RAG_LEXICAL_BM25_K1: '1.5' };
const DEFAULT_PAIR = { k1: LEXICAL_SCORING_DEFAULTS.k1, b: LEXICAL_SCORING_DEFAULTS.b };

function cfg(env: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig(env);
}

function storeReq(): StoreSearchRequest {
  return {
    scope: SCOPE,
    profileId: PROFILE,
    denseVector: [0.3, 0.4, 0.5],
    lexicalTokens: ['neutral', 'marker'],
    denseLimit: 4,
    lexicalLimit: 5,
    filters: { currentOnly: true, docTypes: ['general'] },
    signal: new AbortController().signal,
  };
}

function backendReq(extra: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope: SCOPE,
    embeddingProfileId: PROFILE,
    denseVector: [0.3, 0.4, 0.5],
    lexicalTokens: ['neutral', 'marker'],
    lexicalLanguages: null,
    access: { mode: 'off' },
    filters: { currentOnly: true },
    denseLimit: 4,
    lexicalLimit: 5,
    signal: new AbortController().signal,
    ...extra,
  };
}

function lexicalNode(client: ReturnType<typeof createFakeQdrantClient>): Record<string, unknown> {
  const batch = client.requests.filter((r) => r.method === 'queryBatch').at(-1)!;
  const searches = (batch.body as { searches: Array<Record<string, unknown>> }).searches;
  return searches.find((s) => s.using === 'lexical_text')!;
}

function denseNode(client: ReturnType<typeof createFakeQdrantClient>): Record<string, unknown> {
  const batch = client.requests.filter((r) => r.method === 'queryBatch').at(-1)!;
  return (batch.body as { searches: Array<Record<string, unknown>> }).searches.find((s) => s.using === 'dense')!;
}

function weaviateCreateArgs(fake: ReturnType<typeof createFakeWeaviate>): Record<string, unknown> {
  return fake.calls.filter((c) => c.op === 'collections.create').at(-1)!.args as Record<string, unknown>;
}

function stripLexicalRecord(spec: Record<string, unknown>): { spec: Record<string, unknown>; recorded: unknown } {
  const copy = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const description = JSON.parse(String(copy.description)) as Record<string, unknown>;
  const recorded = description.lexical_bm25;
  delete description.lexical_bm25;
  copy.description = JSON.stringify(description);
  return { spec: copy, recorded };
}

beforeEach(() => {
  resetLexicalParamsChecks();
});

afterEach(() => {
  resetRagConfigForTests();
  vi.restoreAllMocks();
});

describe('externalLexicalParams (LEX-05)', () => {
  it('tracer k1 1.5 reaches qdrant: the lexical node carries k 1.5 and b 0.75, the dense node none, the batch stays scoped', async () => {
    const config = cfg(BM25_15);
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client, lexicalParams: () => externalLexicalParams(config) });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    const created = client.requests.find((r) => r.method === 'createCollection')!;
    expect((created.body.metadata as Record<string, unknown>).lexical_bm25).toEqual({ k1: 1.5, b: 0.75 });
    await store.searchLegs(storeReq());
    expect(lexicalNode(client).query).toEqual({ text: { query: 'neutral marker', scoring: { bm25: { k: 1.5, b: 0.75 } } } });
    expect(JSON.stringify(denseNode(client))).not.toMatch(/bm25|scoring/);
    const batch = client.requests.filter((r) => r.method === 'queryBatch').at(-1)!;
    expect(() => assertScoped(scopedBodyOf(batch), SCOPE)).not.toThrow();
    expect((lexicalNode(client).params as { idf: { corpus: unknown } }).idf.corpus).toEqual({
      must: [{ key: 'tenant_key', match: { value: TENANT_KEY } }],
    });
  });

  it('tracer k1 1.5 reaches weaviate collection: bm25k1 1.5 and bm25b 0.75 in the inverted index and the description', async () => {
    const config = cfg(BM25_15);
    const fake = createFakeWeaviate();
    const store = createWeaviateStore({ client: fake, lexicalParams: () => externalLexicalParams(config) });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    const args = JSON.parse(JSON.stringify(weaviateCreateArgs(fake))) as Record<string, unknown>;
    expect((args.invertedIndex as { bm25: unknown }).bm25).toEqual({ k1: 1.5, b: 0.75 });
    expect(JSON.parse(String(args.description)).lexical_bm25).toEqual({ k1: 1.5, b: 0.75 });
    expect(await store.recordedLexicalParams(PROFILE)).toEqual({ k1: 1.5, b: 0.75 });
  });

  it('off equals defaults whatever the variables say', () => {
    const vars = { RAG_LEXICAL_BM25_K1: '1.5', RAG_LEXICAL_BM25_B: '0.5' };
    expect(externalLexicalParams(cfg(vars))).toEqual(DEFAULT_PAIR);
    expect(externalLexicalParams(cfg({ ...BASE, ...vars }))).toEqual(DEFAULT_PAIR);
    expect(externalLexicalParams(cfg({ ...BASE, ...vars, RAG_LEXICAL_SEARCH: 'false', RAG_LEXICAL_SCORING: 'bm25' }))).toEqual(DEFAULT_PAIR);
    expect(externalLexicalParams(cfg({ ...vars, RAG_LEXICAL_SCORING: 'bm25' }))).toEqual(DEFAULT_PAIR);
    expect(externalLexicalParams(cfg({ ...BASE, ...vars, RAG_LEXICAL_SCORING: 'bm25' }))).toEqual({ k1: 1.5, b: 0.5 });
  });

  it('pair equals req.lexicalScoring under the same configuration', () => {
    for (const env of [BM25_15, { ...BASE, RAG_LEXICAL_SCORING: 'bm25', RAG_LEXICAL_BM25_B: '0.4' }]) {
      const config = cfg(env);
      const scoring = lexicalScoringArg(config).lexicalScoring!;
      expect(externalLexicalParams(config)).toEqual({ k1: scoring.k1, b: scoring.b });
    }
    expect(lexicalScoringArg(cfg(BASE)).lexicalScoring).toBeUndefined();
    expect(externalLexicalParams(cfg(BASE))).toEqual(DEFAULT_PAIR);
  });

  it('lexicalScoring is not a routing capability: backendForRequest picks the same backend with and without the field', () => {
    const selected: RetrievalBackend = { id: 'qdrant', search: async () => ({ dense: [], lexical: [] }), health: async () => ({ ok: true }), isReady: async () => true };
    const without = backendForRequest(backendReq(), selected);
    const withField = backendForRequest(backendReq({ lexicalScoring: { mode: 'bm25', k1: 1.5, b: 0.75 } }), selected);
    expect(without.backend).toBe(selected);
    expect(withField.backend).toBe(selected);
    expect(withField.reason).toBeUndefined();
  });

  it('recorded pair parsing, equality and the TTL shared with readiness', () => {
    expect(recordedLexicalParams(undefined)).toEqual(DEFAULT_PAIR);
    expect(recordedLexicalParams({ k1: 'x', b: 0.75 })).toEqual(DEFAULT_PAIR);
    expect(recordedLexicalParams([1.5, 0.75])).toEqual(DEFAULT_PAIR);
    expect(recordedLexicalParams({ k1: 1.5, b: 0.6 })).toEqual({ k1: 1.5, b: 0.6 });
    expect(sameLexicalParams({ k1: 1.5, b: 0.75 }, { k1: 1.5, b: 0.75 })).toBe(true);
    expect(sameLexicalParams({ k1: 1.5, b: 0.75 }, { k1: 1.2, b: 0.75 })).toBe(false);
    expect(LEXICAL_PARAMS_CHECK_TTL_MS).toBe(READINESS_TTL_MS);
  });
});

describe('default requests are deep-equal to the base snapshot', () => {
  const DEFAULTS_CONFIG = () => externalLexicalParams(cfg({ ...BASE, RAG_LEXICAL_BM25_K1: '1.5' }));

  it('weaviate creation body (apart from the new lexical_bm25 record)', () => {
    const { spec, recorded } = stripLexicalRecord(weaviateCollectionSpec(PROFILE, 3, DEFAULTS_CONFIG()));
    expect(recorded).toEqual(DEFAULT_PAIR);
    expect(spec).toMatchInlineSnapshot(`
    {
      "description": "{"profile_id":"neutral-profile-3","dims":3,"lexical_mode":"bm25_whitespace"}",
      "invertedIndex": {
        "bm25": {
          "b": 0.75,
          "k1": 1.2,
        },
        "indexNullState": true,
        "stopwords": {
          "preset": "none",
        },
      },
      "multiTenancy": {
        "autoTenantActivation": false,
        "autoTenantCreation": false,
        "enabled": true,
      },
      "name": "Myrag_chunks_neutral_profile_3_14212a88",
      "properties": [
        {
          "dataType": "text",
          "indexFilterable": false,
          "indexSearchable": true,
          "name": "lexical_text",
          "tokenization": "whitespace",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "tenant_key",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "document_id",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "doc_type",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "language",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "source",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "chunking_profile_id",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "parent_id",
          "tokenization": "field",
        },
        {
          "dataType": "text",
          "indexFilterable": true,
          "indexSearchable": false,
          "name": "content_hash",
          "tokenization": "field",
        },
        {
          "dataType": "date",
          "indexFilterable": true,
          "indexRangeFilters": true,
          "name": "doc_date",
        },
        {
          "dataType": "int",
          "indexFilterable": true,
          "name": "lexical_version",
        },
      ],
      "vectorizers": {
        "vectorIndex": {
          "config": {
            "distance": "cosine",
            "efConstruction": 200,
            "filterStrategy": "acorn",
            "maxConnections": 64,
            "quantizer": {
              "type": "none",
            },
            "type": "hnsw",
          },
          "name": "hnsw",
        },
        "vectorizer": {
          "name": "none",
        },
      },
    }
  `);
  });

  it('qdrant creation body (apart from the new metadata field) and payload indexes', () => {
    const spec = JSON.parse(JSON.stringify(qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }, DEFAULTS_CONFIG()))) as { metadata: Record<string, unknown> };
    expect(spec.metadata.lexical_bm25).toEqual(DEFAULT_PAIR);
    delete spec.metadata.lexical_bm25;
    expect({ spec, indexes: QDRANT_PAYLOAD_INDEXES }).toMatchInlineSnapshot(`
    {
      "indexes": [
        {
          "field": "tenant_key",
          "schema": {
            "is_tenant": true,
            "type": "keyword",
          },
        },
        {
          "field": "document_id",
          "schema": {
            "type": "keyword",
          },
        },
        {
          "field": "doc_type",
          "schema": {
            "type": "keyword",
          },
        },
        {
          "field": "language",
          "schema": {
            "type": "keyword",
          },
        },
        {
          "field": "source",
          "schema": {
            "type": "keyword",
          },
        },
        {
          "field": "chunking_profile_id",
          "schema": {
            "type": "keyword",
          },
        },
        {
          "field": "parent_id",
          "schema": {
            "type": "keyword",
          },
        },
        {
          "field": "doc_date",
          "schema": {
            "type": "datetime",
          },
        },
        {
          "field": "lexical_text",
          "schema": {
            "lowercase": false,
            "scoring": {
              "type": "bm25",
            },
            "tokenizer": "whitespace",
            "type": "text",
          },
        },
      ],
      "spec": {
        "hnsw_config": {
          "ef_construct": 200,
          "m": 64,
        },
        "metadata": {
          "dims": 3,
          "hnsw": {
            "ef_construct": 200,
            "m": 64,
          },
          "lexical_mode": "text_bm25",
          "profile_id": "neutral-profile-3",
        },
        "strict_mode_config": {
          "enabled": true,
          "unindexed_filtering_retrieve": false,
          "unindexed_filtering_update": false,
        },
        "vectors": {
          "dense": {
            "distance": "Cosine",
            "size": 3,
          },
        },
      },
    }
  `);
  });

  it('qdrant search request', async () => {
    const c = createFakeQdrantClient();
    await c.createCollection(qdrantCollectionName(PROFILE), qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
    c.requests.length = 0;
    await searchQdrantLegs(c, storeReq(), DEFAULTS_CONFIG());
    expect(c.requests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "searches": [
              {
                "filter": {
                  "must": [
                    {
                      "key": "tenant_key",
                      "match": {
                        "value": "u:00000000-0000-4000-8000-0000000000a1",
                      },
                    },
                    {
                      "key": "doc_type",
                      "match": {
                        "any": [
                          "general",
                        ],
                      },
                    },
                  ],
                },
                "limit": 4,
                "params": {
                  "acorn": {
                    "enable": true,
                  },
                },
                "query": [
                  0.3,
                  0.4,
                  0.5,
                ],
                "using": "dense",
                "with_payload": false,
              },
              {
                "filter": {
                  "must": [
                    {
                      "key": "tenant_key",
                      "match": {
                        "value": "u:00000000-0000-4000-8000-0000000000a1",
                      },
                    },
                    {
                      "key": "doc_type",
                      "match": {
                        "any": [
                          "general",
                        ],
                      },
                    },
                  ],
                },
                "limit": 5,
                "params": {
                  "idf": {
                    "corpus": {
                      "must": [
                        {
                          "key": "tenant_key",
                          "match": {
                            "value": "u:00000000-0000-4000-8000-0000000000a1",
                          },
                        },
                      ],
                    },
                  },
                },
                "query": {
                  "text": "neutral marker",
                },
                "using": "lexical_text",
                "with_payload": false,
              },
            ],
          },
          "collection": "myrag_chunks_neutral-profile-3",
          "method": "queryBatch",
        },
      ]
    `);
  });

  it('weaviate search request', async () => {
    const f = createFakeWeaviate();
    await ensureWeaviateCollection(f, PROFILE, 3, DEFAULTS_CONFIG());
    f.plant(weaviateCollectionName(PROFILE), weaviateTenantName(TENANT_KEY), {
      id: '00000000-0000-4000-8000-0000000a0001',
      properties: { tenant_key: TENANT_KEY, lexical_text: 'neutral marker', doc_type: 'general' },
      vector: [0.3, 0.4, 0.5],
    });
    f.calls.length = 0;
    await searchWeaviateLegs(f, storeReq());
    expect(JSON.parse(JSON.stringify(f.calls))).toMatchInlineSnapshot(`
      [
        {
          "collection": "Myrag_chunks_neutral_profile_3_14212a88",
          "op": "withTenant",
          "tenant": "u_00000000-0000-4000-8000-0000000000a1",
        },
        {
          "args": {
            "filters": {
              "operator": "ContainsAny",
              "target": {
                "property": "doc_type",
              },
              "value": [
                "general",
              ],
            },
            "limit": 4,
            "returnMetadata": [
              "distance",
            ],
            "returnProperties": [
              "document_id",
            ],
          },
          "collection": "Myrag_chunks_neutral_profile_3_14212a88",
          "op": "nearVector",
          "tenant": "u_00000000-0000-4000-8000-0000000000a1",
        },
        {
          "args": {
            "filters": {
              "operator": "ContainsAny",
              "target": {
                "property": "doc_type",
              },
              "value": [
                "general",
              ],
            },
            "limit": 5,
            "query": "neutral marker",
            "queryProperties": [
              "lexical_text",
            ],
            "returnMetadata": [
              "score",
            ],
            "returnProperties": [
              "document_id",
            ],
          },
          "collection": "Myrag_chunks_neutral_profile_3_14212a88",
          "op": "bm25",
          "tenant": "u_00000000-0000-4000-8000-0000000000a1",
        },
      ]
    `);
  });

  it('the default store reader sends the base request under the shipped configuration', async () => {
    const c = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: c, lexicalParams: () => externalLexicalParams(cfg()) });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await store.searchLegs(storeReq());
    expect(lexicalNode(c).query).toEqual({ text: 'neutral marker' });
  });
});

describe('legacy collections and ensure', () => {
  it('legacy collection without lexical_bm25 reads as defaults on both stores', async () => {
    const fake = createFakeWeaviate();
    const legacy = weaviateCollectionSpec(PROFILE, 3);
    const description = JSON.parse(String(legacy.description)) as Record<string, unknown>;
    delete description.lexical_bm25;
    await fake.collections.create({ ...legacy, description: JSON.stringify(description) });
    expect((await describeWeaviateCollection(fake, PROFILE)).lexicalParams).toEqual(DEFAULT_PAIR);
    await expect(ensureWeaviateCollection(fake, PROFILE, 3)).resolves.toBeUndefined();

    const client = createFakeQdrantClient();
    const spec = qdrantCollectionSpec({ profileId: PROFILE, dims: 3 });
    delete (spec.metadata as Record<string, unknown>).lexical_bm25;
    await client.createCollection(qdrantCollectionName(PROFILE), spec);
    expect((await describeQdrantCollection(client, PROFILE))?.lexicalParams).toEqual(DEFAULT_PAIR);
    const store = createQdrantStore({ writeClient: client, lexicalParams: () => DEFAULT_PAIR, log: () => undefined });
    client.requests.length = 0;
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests.some((r) => r.method === 'updateCollection')).toBe(false);
  });

  it('ensure refuses a differing index-bound pair with the rebuild command in the message', async () => {
    const fake = createFakeWeaviate();
    await ensureWeaviateCollection(fake, PROFILE, 3);
    const warn: string[] = [];
    const store = createWeaviateStore({ client: fake, lexicalParams: () => ({ k1: 1.5, b: 0.75 }), warn: (line) => warn.push(line) });
    const failure = await store.ensureCollection({ profileId: PROFILE, dims: 3 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LexicalParamsMismatchError);
    expect(failure).toBeInstanceOf(BackendNotReadyError);
    const error = failure as LexicalParamsMismatchError;
    expect(error.lexicalReason).toBe(LEXICAL_PARAMS_MISMATCH);
    expect(error.message).toContain('npm run rag:vector-sync -- rebuild-lexical --target weaviate --confirm');
    expect(error.message).toContain(PROFILE);
    expect(error.message).toContain('k1 1.2, b 0.75');
    expect(error.message).toContain('k1 1.5, b 0.75');
    await store.ensureCollection({ profileId: PROFILE, dims: 3 }).catch(() => undefined);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatch(/^\[Vector Sync\]/);
    expect(fake.calls.filter((c) => c.op === 'collections.create')).toHaveLength(1);
    expect(fake.calls.some((c) => c.op === 'collections.delete')).toBe(false);
  });

  it('query-bound qdrant ensure refreshes a differing recorded pair in place with one [Vector Sync] line', async () => {
    const client = createFakeQdrantClient();
    await client.createCollection(qdrantCollectionName(PROFILE), qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
    client.requests.length = 0;
    const lines: string[] = [];
    const store = createQdrantStore({ writeClient: client, lexicalParams: () => ({ k1: 1.5, b: 0.75 }), log: (line) => lines.push(line) });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests.filter((r) => r.method === 'updateCollection').map((r) => r.body)).toEqual([{ metadata: { lexical_bm25: { k1: 1.5, b: 0.75 } } }]);
    expect(client.requests.some((r) => r.method === 'deleteCollection' || r.method === 'createCollection')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[Vector Sync\] qdrant collection for profile neutral-profile-3/);
    expect(lines[0]).not.toContain(TENANT_KEY);
    expect((await describeQdrantCollection(client, PROFILE))?.lexicalParams).toEqual({ k1: 1.5, b: 0.75 });
    expect(isLexicalParamsStore(store)).toBe(true);
    expect(store.lexicalBinding).toBe('query');
  });

  it('the scoped builder accepts only the bm25 scorer with its two numbers', () => {
    const node = (text: unknown) => ({ searches: [{ query: { text }, using: 'lexical_text', limit: 3 }] });
    expect(() => qdrantScopedBatch(SCOPE, node({ query: 'a', scoring: { bm25: { k: 1.5, b: 0.75 } } }) as never)).not.toThrow();
    const scoped = qdrantScopedBatch(SCOPE, node({ query: 'a', scoring: { bm25: { k: 1.5 } } }) as never);
    expect((scoped.searches[0].params as { idf: unknown }).idf).toEqual({ corpus: { must: [{ key: 'tenant_key', match: { value: TENANT_KEY } }] } });
    for (const bad of [
      { query: 'a', scoring: { other: { k: 1 } } },
      { query: 'a', scoring: { bm25: { k: 1.5, extra: 1 } } },
      { query: 'a', scoring: { bm25: { k: '1.5' } } },
      { query: 'a', extra: true },
      { scoring: { bm25: { k: 1.5 } } },
    ]) {
      expect(() => qdrantScopedBatch(SCOPE, node(bad) as never)).toThrow(/query form not allowed/);
    }
  });
});

function readinessRpc(): RpcClient {
  return {
    rpc() {
      const answer: RpcResponse = { data: [{ state: 'ready', lag_seconds: 0, outbox_lag_seconds: 0 }], error: null };
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
}

describe('read-side refusal of a mismatched index (Task 2)', () => {
  beforeEach(() => {
    resetBackendFactoryForTests();
    resetReadinessCacheForTests();
    resetRetrievalBackendForTests();
  });

  afterEach(() => {
    resetBackendFactoryForTests();
    resetReadinessCacheForTests();
    resetRetrievalBackendForTests();
  });

  it('mismatch falls back to pgvector: backend_not_ready, degraded, and no Weaviate query recorded', async () => {
    const pgCalls: BackendSearchRequest[] = [];
    const pg: RetrievalBackend = {
      id: 'pgvector',
      async search(req): Promise<BackendLegs> {
        pgCalls.push(req);
        return { dense: [hit('pgvector-1', { similarity: 0.9 })], lexical: [] };
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
    setRetrievalBackendForTests(pg);
    const fake = createFakeWeaviate();
    await ensureWeaviateCollection(fake, PROFILE, 3);
    fake.calls.length = 0;
    const logs: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const weaviate = createWeaviateBackend({
      readClient: () => fake,
      revalidate: () => null,
      readiness: async () => true,
      lexicalParams: () => ({ k1: 1.5, b: 0.75 }),
      log: (line) => logs.push(line),
    });
    setExternalBackendForTests('weaviate', weaviate);
    const config = cfg({ ...BM25_15, RAG_RETRIEVAL_BACKEND: 'weaviate' });
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc() });
    const out = await resolved.backend.search(backendReq());
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(resolved.selection()).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_not_ready', degraded: true });
    expect(fake.calls.some((c) => c.op === 'bm25' || c.op === 'nearVector')).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('rebuild-lexical --target weaviate --confirm');
    expect(logs[0]).not.toContain(TENANT_KEY);
    expect(pgCalls).toHaveLength(1);
  });

  it('the reader describes at most once per TTL window, logs once per window, and an equal pair logs nothing', async () => {
    const fake = createFakeWeaviate();
    await ensureWeaviateCollection(fake, PROFILE, 3);
    let clock = 1_000;
    let describes = 0;
    const logs: string[] = [];
    const check = createLexicalParamsCheck({
      target: 'weaviate',
      describe: async (profileId) => {
        describes += 1;
        return (await describeWeaviateCollection(fake, profileId)).lexicalParams;
      },
      configured: () => ({ k1: 1.5, b: 0.75 }),
      log: (line) => logs.push(line),
      now: () => clock,
    });
    await expect(check(PROFILE)).rejects.toBeInstanceOf(LexicalParamsMismatchError);
    await expect(check(PROFILE)).rejects.toBeInstanceOf(LexicalParamsMismatchError);
    expect(describes).toBe(1);
    expect(logs).toHaveLength(1);
    clock += LEXICAL_PARAMS_CHECK_TTL_MS;
    await expect(check(PROFILE)).rejects.toBeInstanceOf(LexicalParamsMismatchError);
    expect(describes).toBe(2);
    expect(logs).toHaveLength(2);

    const equalLogs: string[] = [];
    const equal = createLexicalParamsCheck({
      target: 'weaviate',
      describe: async (profileId) => (await describeWeaviateCollection(fake, profileId)).lexicalParams,
      configured: () => DEFAULT_PAIR,
      log: (line) => equalLogs.push(line),
    });
    await expect(equal(PROFILE)).resolves.toBeUndefined();
    expect(equalLogs).toEqual([]);
  });

  it('a failed describe is not a mismatch: the search proceeds under its own error mapping', async () => {
    const fake = createFakeWeaviate();
    await ensureWeaviateCollection(fake, PROFILE, 3);
    fake.plant(weaviateCollectionName(PROFILE), weaviateTenantName(TENANT_KEY), {
      id: '00000000-0000-4000-8000-0000000a0001',
      properties: { tenant_key: TENANT_KEY, lexical_text: 'neutral marker', doc_type: 'general' },
      vector: [0.3, 0.4, 0.5],
    });
    const broken = { ...fake, collections: { ...fake.collections, export: async () => { throw new Error('forbidden'); } } } as typeof fake;
    const reader = createWeaviateReader(broken, { lexicalParams: () => ({ k1: 1.5, b: 0.75 }), log: () => undefined });
    const legs = await reader.searchLegs(storeReq());
    expect(legs.lexical.map((h) => h.id)).toEqual(['00000000-0000-4000-8000-0000000a0001']);
  });

  it('a query-bound qdrant reader never refuses on the recorded pair', async () => {
    const client = createFakeQdrantClient();
    await client.createCollection(qdrantCollectionName(PROFILE), qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
    const backend = createQdrantBackend({ readClient: client, adminClient: () => null, lexicalParams: () => ({ k1: 1.5, b: 0.75 }) });
    client.requests.length = 0;
    await expect(backend.search(backendReq())).rejects.not.toBeInstanceOf(LexicalParamsMismatchError);
    expect(client.requests.some((r) => r.method === 'queryBatch')).toBe(true);
    expect(lexicalNode(client).query).toEqual({ text: { query: 'neutral marker', scoring: { bm25: { k: 1.5, b: 0.75 } } } });
  });

  it('the mismatch message names target, profile, both pairs and the command, and nothing else', () => {
    const message = lexicalParamsMismatchMessage('weaviate', PROFILE, DEFAULT_PAIR, { k1: 1.5, b: 0.75 });
    expect(message).toBe(
      '[RAG Backend] weaviate collection for profile neutral-profile-3 was built with BM25 k1 1.2, b 0.75 but the configuration says ' +
        'k1 1.5, b 0.75; it is not served until `npm run rag:vector-sync -- rebuild-lexical --target weaviate --confirm` rebuilds it',
    );
  });
});
