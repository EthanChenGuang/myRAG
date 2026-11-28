import { qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import type { CollectionInfo, CollectionSpec } from '@/lib/rag/sync/stores/types';
import type { QdrantApi } from './client';
import { qdrantErrorStatus } from './errors';
import {
  LEXICAL_BM25_KEY,
  defaultLexicalParams,
  lexicalParamsRecord,
  recordedLexicalParams,
  sameLexicalParams,
  type LexicalParams,
} from '../lexical-params';

export const QDRANT_DENSE_VECTOR = 'dense';
export const QDRANT_LEXICAL_FIELD = 'lexical_text';
export const QDRANT_LEXICAL_MODE = 'text_bm25';
export const QDRANT_HNSW = { m: 64, ef_construct: 200 } as const;

type FieldSchema = Parameters<QdrantApi['createPayloadIndex']>[1]['field_schema'];

/**
 * Payload indexes in creation order (D-06, RET-10): the tenant index first with is_tenant, then every filter field, then the BM25
 * text index over the shared-tokenizer output (whitespace, no lowercasing: the tokenizer already normalised it).
 */
export const QDRANT_PAYLOAD_INDEXES: ReadonlyArray<{ field: string; schema: FieldSchema }> = [
  { field: 'tenant_key', schema: { type: 'keyword', is_tenant: true } },
  { field: 'document_id', schema: { type: 'keyword' } },
  { field: 'doc_type', schema: { type: 'keyword' } },
  { field: 'language', schema: { type: 'keyword' } },
  { field: 'source', schema: { type: 'keyword' } },
  { field: 'chunking_profile_id', schema: { type: 'keyword' } },
  { field: 'parent_id', schema: { type: 'keyword' } },
  { field: 'doc_date', schema: { type: 'datetime' } },
  {
    field: QDRANT_LEXICAL_FIELD,
    schema: { type: 'text', tokenizer: 'whitespace', lowercase: false, scoring: { type: 'bm25' } } as FieldSchema,
  },
];

export interface QdrantCollectionInfo extends CollectionInfo {
  lexicalMode: string | null;
  /** LEX-05: the pair recorded in the metadata as lexical_bm25 (defaults when absent). Qdrant takes k1 and b per query, so it is a record only. */
  lexicalParams: LexicalParams;
}

/** The creation body: one named cosine vector, no quantization, strict mode refusing filters on unindexed fields. */
export function qdrantCollectionSpec(
  spec: CollectionSpec,
  params: LexicalParams = defaultLexicalParams(),
): Parameters<QdrantApi['createCollection']>[1] {
  if (!Number.isInteger(spec.dims) || spec.dims <= 0) throw new Error('[Vector Sync] qdrant: invalid collection dims');
  return {
    vectors: { [QDRANT_DENSE_VECTOR]: { size: spec.dims, distance: 'Cosine' } },
    hnsw_config: { m: QDRANT_HNSW.m, ef_construct: QDRANT_HNSW.ef_construct },
    strict_mode_config: { enabled: true, unindexed_filtering_retrieve: false, unindexed_filtering_update: false },
    metadata: {
      profile_id: spec.profileId,
      dims: spec.dims,
      lexical_mode: QDRANT_LEXICAL_MODE,
      hnsw: { m: QDRANT_HNSW.m, ef_construct: QDRANT_HNSW.ef_construct },
      [LEXICAL_BM25_KEY]: lexicalParamsRecord(params),
    },
  };
}

async function readCollection(client: QdrantApi, name: string): Promise<Awaited<ReturnType<QdrantApi['getCollection']>> | null> {
  try {
    return await client.getCollection(name);
  } catch (error) {
    if (qdrantErrorStatus(error) === 404) return null;
    throw new Error(`[Vector Sync] qdrant: collection lookup failed (${qdrantErrorStatus(error) ?? 'unreachable'})`);
  }
}

function infoFrom(profileId: string, collection: NonNullable<Awaited<ReturnType<typeof readCollection>>>): QdrantCollectionInfo {
  const metadata = (collection.config as { metadata?: Record<string, unknown> | null }).metadata ?? {};
  const vectors = collection.config.params.vectors as Record<string, { size?: number }> | { size?: number } | undefined;
  const named = vectors && QDRANT_DENSE_VECTOR in vectors ? (vectors as Record<string, { size?: number }>)[QDRANT_DENSE_VECTOR] : null;
  const dims = typeof named?.size === 'number' ? named.size : typeof metadata.dims === 'number' ? metadata.dims : 0;
  return {
    profileId,
    dims,
    tenants: null,
    lexicalMode: typeof metadata.lexical_mode === 'string' ? metadata.lexical_mode : null,
    lexicalParams: recordedLexicalParams(metadata[LEXICAL_BM25_KEY]),
  };
}

export async function describeQdrantCollection(client: QdrantApi, profileId: string): Promise<QdrantCollectionInfo | null> {
  const found = await readCollection(client, qdrantCollectionName(profileId));
  return found ? infoFrom(profileId, found) : null;
}

export interface QdrantLexicalOptions {
  params?: LexicalParams;
  log?: (line: string) => void;
}

/** Query-bound: a differing recorded pair is refreshed in place (metadata merge), with one [Vector Sync] line; nothing is rebuilt. */
export async function refreshQdrantLexicalParams(
  client: QdrantApi,
  profileId: string,
  recorded: LexicalParams,
  params: LexicalParams,
  log: (line: string) => void = (line) => console.log(line),
): Promise<boolean> {
  if (sameLexicalParams(recorded, params)) return false;
  try {
    await client.updateCollection(qdrantCollectionName(profileId), { metadata: { [LEXICAL_BM25_KEY]: lexicalParamsRecord(params) } });
  } catch (error) {
    throw new Error(`[Vector Sync] qdrant: collection metadata update failed (${qdrantErrorStatus(error) ?? 'unreachable'})`);
  }
  log(
    `[Vector Sync] qdrant collection for profile ${profileId}: recorded BM25 pair refreshed from k1 ${recorded.k1}, b ${recorded.b} ` +
      `to k1 ${params.k1}, b ${params.b} (k1 and b are sent per query; no rebuild)`,
  );
  return true;
}

/**
 * Collection admin is the only tenant-less call (write client). Creates the collection and every payload index before any point is
 * written; an existing collection must have the profile's dims. ensured caches per process, so a second call sends nothing.
 */
export async function ensureQdrantCollection(
  client: QdrantApi,
  spec: CollectionSpec,
  ensured: Map<string, number>,
  lexical: QdrantLexicalOptions = {},
): Promise<void> {
  const params = lexical.params ?? defaultLexicalParams();
  const name = qdrantCollectionName(spec.profileId);
  const known = ensured.get(spec.profileId);
  if (known !== undefined) {
    if (known !== spec.dims) throw new Error('[Vector Sync] qdrant: collection dims differ from the profile');
    return;
  }
  const found = await readCollection(client, name);
  if (found) {
    const info = infoFrom(spec.profileId, found);
    if (info.dims !== spec.dims) throw new Error('[Vector Sync] qdrant: collection dims differ from the profile');
    const present = new Set(Object.keys(found.payload_schema ?? {}));
    await createIndexes(client, name, (field) => !present.has(field));
    await refreshQdrantLexicalParams(client, spec.profileId, info.lexicalParams, params, lexical.log);
    ensured.set(spec.profileId, spec.dims);
    return;
  }
  await client.createCollection(name, qdrantCollectionSpec(spec, params));
  await createIndexes(client, name, () => true);
  ensured.set(spec.profileId, spec.dims);
}

/** A collection left without some index by an interrupted setup gets the missing ones, in the same order. */
async function createIndexes(client: QdrantApi, name: string, missing: (field: string) => boolean): Promise<void> {
  for (const index of QDRANT_PAYLOAD_INDEXES) {
    if (!missing(index.field)) continue;
    await client.createPayloadIndex(name, { field_name: index.field, field_schema: index.schema, wait: true });
  }
}
