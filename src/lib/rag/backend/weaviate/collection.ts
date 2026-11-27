import { isCanonicalTenantKey, weaviateCollectionName, weaviateTenantName } from '../tenant-key';
import { weaviateConfigure as configure } from './client';
import { mapWeaviateError } from './errors';
import type { WeaviateClientLike } from './types';

export const WEAVIATE_LEXICAL_MODE = 'bm25_whitespace';
export const WEAVIATE_LEXICAL_PROPERTY = 'lexical_text';

/** D-03 filter and bookkeeping properties; exact-match text (field tokenisation), never searchable. */
export const WEAVIATE_KEYWORD_PROPERTIES = [
  'tenant_key',
  'document_id',
  'doc_type',
  'language',
  'source',
  'chunking_profile_id',
  'parent_id',
  'content_hash',
] as const;

export interface WeaviateCollectionDescription {
  profile_id: string;
  dims: number;
  lexical_mode: typeof WEAVIATE_LEXICAL_MODE;
}

export interface WeaviateCollectionState {
  exists: boolean;
  dims: number | null;
  lexicalMode: string | null;
}

/**
 * D-06, D-13, A-4, RET-10: one multi-tenant collection per embedding profile, tenants created only by the worker, one
 * self-provided vector with the pgvector HNSW parameters, no quantization, no stopwords, BM25 over the shared tokenizer output.
 */
export function weaviateCollectionSpec(profileId: string, dims: number): Record<string, unknown> {
  if (!Number.isInteger(dims) || dims <= 0) throw new Error('[Vector Sync] weaviate collection dims must be a positive integer');
  const description: WeaviateCollectionDescription = { profile_id: profileId, dims, lexical_mode: WEAVIATE_LEXICAL_MODE };
  return {
    name: weaviateCollectionName(profileId),
    description: JSON.stringify(description),
    multiTenancy: configure.multiTenancy({ enabled: true, autoTenantCreation: false, autoTenantActivation: false }),
    vectorizers: configure.vectors.selfProvided({
      vectorIndexConfig: configure.vectorIndex.hnsw({
        maxConnections: 64,
        efConstruction: 200,
        distanceMetric: 'cosine',
        filterStrategy: 'acorn',
        quantizer: configure.vectorIndex.quantizer.none(),
      }),
    }),
    invertedIndex: configure.invertedIndex({
      indexNullState: true,
      stopwordsPreset: 'none',
      bm25k1: 1.2,
      bm25b: 0.75,
    }),
    properties: [
      {
        name: WEAVIATE_LEXICAL_PROPERTY,
        dataType: configure.dataType.TEXT,
        tokenization: configure.tokenization.WHITESPACE,
        indexFilterable: false,
        indexSearchable: true,
      },
      ...WEAVIATE_KEYWORD_PROPERTIES.map((name) => ({
        name,
        dataType: configure.dataType.TEXT,
        tokenization: configure.tokenization.FIELD,
        indexFilterable: true,
        indexSearchable: false,
      })),
      { name: 'doc_date', dataType: configure.dataType.DATE, indexFilterable: true, indexRangeFilters: true },
      { name: 'lexical_version', dataType: configure.dataType.INT, indexFilterable: true },
    ],
  };
}

function parseDescription(raw: string | null | undefined): Partial<WeaviateCollectionDescription> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<WeaviateCollectionDescription>) : {};
  } catch {
    return {};
  }
}

export async function describeWeaviateCollection(client: WeaviateClientLike, profileId: string): Promise<WeaviateCollectionState> {
  const name = weaviateCollectionName(profileId);
  try {
    if (!(await client.collections.exists(name))) return { exists: false, dims: null, lexicalMode: null };
    const description = parseDescription((await client.collections.export(name)).description);
    return {
      exists: true,
      dims: typeof description.dims === 'number' ? description.dims : null,
      lexicalMode: typeof description.lexical_mode === 'string' ? description.lexical_mode : null,
    };
  } catch (error) {
    throw mapWeaviateError(error, 'describe_collection');
  }
}

/** Creates the collection when absent (write client); an existing one with other dims or another lexical mode is refused. */
export async function ensureWeaviateCollection(client: WeaviateClientLike, profileId: string, dims: number, raced = false): Promise<void> {
  const spec = weaviateCollectionSpec(profileId, dims);
  const state = await describeWeaviateCollection(client, profileId);
  if (!state.exists) {
    try {
      await client.collections.create(spec);
      return;
    } catch (error) {
      if (raced || !/already exists/i.test(error instanceof Error ? error.message : '')) throw mapWeaviateError(error, 'create_collection');
    }
    return ensureWeaviateCollection(client, profileId, dims, true);
  }
  if (state.dims !== dims) throw new Error('[Vector Sync] weaviate collection dims differ');
  if (state.lexicalMode !== WEAVIATE_LEXICAL_MODE) throw new Error('[Vector Sync] weaviate collection lexical mode differs');
}

/** D-07: tenants are created only here, from canonical keys, on the write client; the server never creates one. */
export async function ensureWeaviateTenant(client: WeaviateClientLike, profileId: string, tenantKey: string): Promise<boolean> {
  if (!isCanonicalTenantKey(tenantKey)) throw new Error('[RAG Tenant] malformed tenant key');
  const name = weaviateTenantName(tenantKey);
  const handle = client.collections.use(weaviateCollectionName(profileId));
  try {
    if (await handle.tenants.getByName(name)) return false;
    await handle.tenants.create([{ name }]);
    return true;
  } catch (error) {
    if (/already exists/i.test(error instanceof Error ? error.message : '')) return false;
    throw mapWeaviateError(error, 'create_tenant');
  }
}

export async function countWeaviateTenants(client: WeaviateClientLike, profileId: string): Promise<number> {
  try {
    return Object.keys(await client.collections.use(weaviateCollectionName(profileId)).tenants.get()).length;
  } catch (error) {
    throw mapWeaviateError(error, 'list_tenants');
  }
}
