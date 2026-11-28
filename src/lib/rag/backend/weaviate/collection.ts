import { isCanonicalTenantKey, weaviateCollectionName, weaviateTenantName } from '../tenant-key';
import { weaviateConfigure as configure } from './client';
import { mapWeaviateError } from './errors';
import { WEAVIATE_INDEX } from '../index-params';
import type { WeaviateClientLike } from './types';
import {
  LEXICAL_BM25_KEY,
  LexicalParamsMismatchError,
  defaultLexicalParams,
  lexicalParamsRecord,
  recordedLexicalParams,
  sameLexicalParams,
  type LexicalParams,
} from '../lexical-params';

export const WEAVIATE_LEXICAL_MODE = WEAVIATE_INDEX.lexicalMode;
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
  /** LEX-05: lexical_bm25, the BM25 pair the inverted index was built with; absent on a collection created before it (the defaults). */
  [LEXICAL_BM25_KEY]?: { k1: number; b: number };
}

export interface WeaviateCollectionState {
  exists: boolean;
  dims: number | null;
  lexicalMode: string | null;
  /** The recorded pair (defaults when the description has none); null when the collection does not exist. */
  lexicalParams: LexicalParams | null;
}

export const WEAVIATE_ACCESS_GROUPS_PROPERTY = 'access_groups';

/** SEC-12: the Phase 4.3 access keys as an exact-match, filterable text array; filtered only while RAG_DOC_ACCESS_GROUPS is on. */
export function weaviateAccessGroupsProperty(): Record<string, unknown> {
  return {
    name: WEAVIATE_ACCESS_GROUPS_PROPERTY,
    dataType: configure.dataType.TEXT_ARRAY,
    tokenization: configure.tokenization.FIELD,
    indexFilterable: true,
    indexSearchable: false,
  };
}

/**
 * D-06, D-13, A-4, RET-10: one multi-tenant collection per embedding profile, tenants created only by the worker, one
 * self-provided vector with the pgvector HNSW parameters, no quantization, no stopwords, BM25 over the shared tokenizer output.
 */
export function weaviateCollectionSpec(profileId: string, dims: number, params: LexicalParams = defaultLexicalParams()): Record<string, unknown> {
  if (!Number.isInteger(dims) || dims <= 0) throw new Error('[Vector Sync] weaviate collection dims must be a positive integer');
  const description: WeaviateCollectionDescription = {
    profile_id: profileId,
    dims,
    lexical_mode: WEAVIATE_LEXICAL_MODE,
    [LEXICAL_BM25_KEY]: lexicalParamsRecord(params),
  };
  return {
    name: weaviateCollectionName(profileId),
    description: JSON.stringify(description),
    multiTenancy: configure.multiTenancy({ enabled: true, autoTenantCreation: false, autoTenantActivation: false }),
    vectorizers: configure.vectors.selfProvided({
      vectorIndexConfig: configure.vectorIndex.hnsw({
        maxConnections: WEAVIATE_INDEX.m,
        efConstruction: WEAVIATE_INDEX.efConstruction,
        distanceMetric: 'cosine',
        filterStrategy: 'acorn',
        quantizer: configure.vectorIndex.quantizer.none(),
      }),
    }),
    invertedIndex: configure.invertedIndex({
      indexNullState: true,
      stopwordsPreset: 'none',
      bm25k1: params.k1,
      bm25b: params.b,
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
      weaviateAccessGroupsProperty(),
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
    if (!(await client.collections.exists(name))) return { exists: false, dims: null, lexicalMode: null, lexicalParams: null };
    const description = parseDescription((await client.collections.export(name)).description);
    return {
      exists: true,
      dims: typeof description.dims === 'number' ? description.dims : null,
      lexicalMode: typeof description.lexical_mode === 'string' ? description.lexical_mode : null,
      lexicalParams: recordedLexicalParams(description[LEXICAL_BM25_KEY]),
    };
  } catch (error) {
    throw mapWeaviateError(error, 'describe_collection');
  }
}

/**
 * Creates the collection when absent (write client); an existing one with other dims, another lexical mode or another BM25 pair is
 * refused. k1 and b live in the inverted index, so a changed pair needs rebuild-lexical, never an in-place update.
 */
export async function ensureWeaviateCollection(
  client: WeaviateClientLike,
  profileId: string,
  dims: number,
  params: LexicalParams = defaultLexicalParams(),
  raced = false,
): Promise<void> {
  const spec = weaviateCollectionSpec(profileId, dims, params);
  const state = await describeWeaviateCollection(client, profileId);
  if (!state.exists) {
    try {
      await client.collections.create(spec);
      return;
    } catch (error) {
      if (raced || !/already exists/i.test(error instanceof Error ? error.message : '')) throw mapWeaviateError(error, 'create_collection');
    }
    return ensureWeaviateCollection(client, profileId, dims, params, true);
  }
  if (state.dims !== dims) throw new Error('[Vector Sync] weaviate collection dims differ');
  if (state.lexicalMode !== WEAVIATE_LEXICAL_MODE) throw new Error('[Vector Sync] weaviate collection lexical mode differs');
  const recorded = state.lexicalParams ?? defaultLexicalParams();
  if (!sameLexicalParams(recorded, params)) throw new LexicalParamsMismatchError('weaviate', profileId, recorded, params);
  await ensureWeaviateAccessGroupsProperty(client, profileId);
}

/** A collection created before SEC-12 gets the access_groups property added in place, once; it is never recreated. */
async function ensureWeaviateAccessGroupsProperty(client: WeaviateClientLike, profileId: string): Promise<void> {
  const name = weaviateCollectionName(profileId);
  let properties: Array<{ name: string }> | null | undefined;
  try {
    properties = (await client.collections.export(name)).properties;
  } catch (error) {
    throw mapWeaviateError(error, 'describe_collection');
  }
  if (Array.isArray(properties) && properties.some((property) => property?.name === WEAVIATE_ACCESS_GROUPS_PROPERTY)) return;
  try {
    await client.collections.use(name).config.addProperty(weaviateAccessGroupsProperty());
  } catch (error) {
    if (/already exists/i.test(error instanceof Error ? error.message : '')) return;
    throw mapWeaviateError(error, 'add_property');
  }
}

/** rebuild-lexical: drops the profile's collection (every tenant shard) and creates it again with the given pair. */
export async function recreateWeaviateCollection(client: WeaviateClientLike, profileId: string, dims: number, params: LexicalParams): Promise<void> {
  const name = weaviateCollectionName(profileId);
  try {
    if (await client.collections.exists(name)) await client.collections.delete(name);
  } catch (error) {
    throw mapWeaviateError(error, 'delete_collection');
  }
  await ensureWeaviateCollection(client, profileId, dims, params);
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
