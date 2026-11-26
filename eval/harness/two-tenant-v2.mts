import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient, RpcRequest, RpcResponse } from '../../src/lib/rag/backend/supabase-rpc';
import { chunkLexicalText } from '../../src/lib/rag/lexical/chunk-text';
import type { TenantScope } from '../../src/lib/rag/tenant/scope';
import { embedText } from './fixture-embedder.mts';
import { runFixtureRelex } from './pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from './two-tenant.mts';

export const V2_CANARY_PROFILE_ID = 'p128-canary';
export const V2_CANARY_DOC_TYPE = 'general';
export const V2_EXACT_CODE = 'CNR-4471-ZX';
export const V2_LEGACY_EMBEDDING_PROFILE = 'openai-3-small-1536';

export const V2_CANARY_QUERY = 'two tenant isolation canary phrase';
export const V2_EXACT_QUERY = `${V2_CANARY_QUERY} ${V2_EXACT_CODE}`;
export const V2_CONTRACT_QUESTION = 'What are the supply contract renewal terms and termination notice?';
export const V2_TRANSLATED_QUESTION = 'Which isolation canary sentence does the Italian handbook hold?';
export const V2_TRANSLATED_TEXT = 'frase canarino isolamento manuale italiano';

export type V2TenantLabel = 'a' | 'b' | 'o';

export interface V2TenantMarkers {
  child: string;
  parent: string;
  exact: string;
  image: string;
  translated: string;
  /** Prefix of every cell value of the tenant's lookup table. */
  tableCell: string;
  /** The tenant's two identifiers: one asked in the identifier path, one a single-edit neighbour that is a suggestion when the first is missing. */
  identifier: string;
  identifierSibling: string;
  /** Superseded and current revision words of the tenant's versioned document. */
  supersededVersion: string;
  currentVersion: string;
  /** Prefix of the per-copy word that makes each pasted copy of the shared passage a near duplicate. */
  dupCopy: string;
}

/** Ids of the rows the Phase 4.2 paths (table lookup, identifiers, versions, duplicate clusters) need, per tenant. */
export interface V2LookupSeed {
  tableDocumentId: string;
  tableChunkId: string;
  identifierDocumentId: string;
  identifierChunkId: string;
  siblingDocumentId: string;
  siblingChunkId: string;
  supersededDocumentId: string;
  supersededChunkId: string;
  currentDocumentId: string;
  currentChunkId: string;
  dupDocumentIds: string[];
  dupChunkIds: string[];
  /** Filled after clustering: the one cluster the tenant's pasted copies form. */
  dupClusterId: string;
}

export interface TwoTenantV2Tenant {
  label: V2TenantLabel;
  scopeKey: string;
  userId: string;
  organizationId: string | null;
  canaryDocumentId: string;
  legacyChunkId: string;
  exactDocumentId: string;
  exactChunkId: string;
  imageDocumentId: string;
  imageChunkId: string;
  imageUrl: string;
  translatedDocumentId: string;
  translatedChunkId: string;
  markers: V2TenantMarkers;
  lookup: V2LookupSeed;
  /** Profile children of the canary document, filled after the profile write. */
  childChunkIds: string[];
  /** Parents of the canary document, filled after the profile write. */
  parentIds: string[];
}

/** A document type only tenant B has, so a request filter naming it from another tenant must return nothing. */
export interface V2TypeOnlyDocument {
  tenant: 'b';
  documentId: string;
  chunkId: string;
  docType: string;
  marker: string;
}

export interface TwoTenantV2Seed {
  tenants: Record<V2TenantLabel, TwoTenantV2Tenant>;
  profileId: string;
  docType: string;
  typeOnly: V2TypeOnlyDocument;
}

export interface TwoTenantV2Database extends TwoTenantDatabase {
  seed: TwoTenantV2Seed;
}

const CREATED_AT = '2025-01-17T00:00:00.000Z';

function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${(0x410000 + n).toString(16).padStart(12, '0')}`;
}

/** The deterministic id rag_write_profile_chunks gives a row: the first 16 bytes of sha256(document id : profile id : kind : index). */
export function profileRowId(documentId: string, profileId: string, kind: 'parent' | 'child', index: number): string {
  const hex = crypto.createHash('sha256').update(`${documentId}:${profileId}:${kind}:${index}`, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

interface TenantSeedSpec {
  label: V2TenantLabel;
  /** Marker tag: the three tags have the same length so the tenants' chunks embed alike and no floor treats one tenant differently. */
  tag: string;
  scopeKey: string;
  userId: string;
  organizationId: string | null;
  canaryDocumentId: string;
  legacyChunkId: string;
  base: number;
  /** Base of the fixture ids of the Phase 4.2 lookup rows. */
  lookupBase: number;
  /** The digits of the tenant's identifier: one shared shape, different characters per tenant. */
  identifierDigits: string;
}

const SPECS: TenantSeedSpec[] = [
  {
    label: 'a',
    tag: 'xalpha',
    scopeKey: `u:${TWO_TENANT_IDS.userA}`,
    userId: TWO_TENANT_IDS.userA,
    organizationId: null,
    canaryDocumentId: TWO_TENANT_IDS.docA,
    legacyChunkId: TWO_TENANT_IDS.chunkA,
    base: 0x10,
    lookupBase: 0x1000,
    identifierDigits: '41071',
  },
  {
    label: 'b',
    tag: 'xbravo',
    scopeKey: `u:${TWO_TENANT_IDS.userB}`,
    userId: TWO_TENANT_IDS.userB,
    organizationId: null,
    canaryDocumentId: TWO_TENANT_IDS.docB,
    legacyChunkId: TWO_TENANT_IDS.chunkB,
    base: 0x20,
    lookupBase: 0x1100,
    identifierDigits: '52683',
  },
  {
    label: 'o',
    tag: 'xorgco',
    scopeKey: `o:${TWO_TENANT_IDS.orgO}`,
    userId: TWO_TENANT_IDS.userA,
    organizationId: TWO_TENANT_IDS.orgO,
    canaryDocumentId: TWO_TENANT_IDS.docO,
    legacyChunkId: TWO_TENANT_IDS.chunkO,
    base: 0x30,
    lookupBase: 0x1200,
    identifierDigits: '73925',
  },
];

function tenantOf(spec: TenantSeedSpec): TwoTenantV2Tenant {
  return {
    label: spec.label,
    scopeKey: spec.scopeKey,
    userId: spec.userId,
    organizationId: spec.organizationId,
    canaryDocumentId: spec.canaryDocumentId,
    legacyChunkId: spec.legacyChunkId,
    exactDocumentId: fixtureId(spec.base + 1),
    exactChunkId: fixtureId(spec.base + 2),
    imageDocumentId: fixtureId(spec.base + 3),
    imageChunkId: fixtureId(spec.base + 4),
    imageUrl: `https://example.invalid/v2-${spec.tag}-mark.png`,
    translatedDocumentId: fixtureId(spec.base + 5),
    translatedChunkId: fixtureId(spec.base + 6),
    markers: {
      child: `v2child${spec.tag}`,
      parent: `v2parent${spec.tag}`,
      exact: `v2exact${spec.tag}`,
      image: `v2image${spec.tag}`,
      translated: `v2italian${spec.tag}`,
      ...lookupMarkers(spec.tag, spec.identifierDigits),
    },
    lookup: lookupIds(spec.lookupBase),
    childChunkIds: [],
    parentIds: [],
  };
}

export const V2_DUP_COPIES = 4;

const DUP_SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'vo', 'ri', 'pe', 'du', 'zo', 'fa', 'gi', 'ho', 'ju', 'be', 'qa', 'wy'];

function inventedWord(seed: number): string {
  let n = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out += DUP_SYLLABLES[n % DUP_SYLLABLES.length];
    n = Math.floor(n / DUP_SYLLABLES.length) + 11 * (i + 1);
  }
  return `${out}${seed % 89}`;
}

/** One passage of invented words that every tenant pastes into several of its own documents. */
const DUP_WORDS = Array.from({ length: 40 }, (_, i) => inventedWord(80_000 + i));
const DUP_COPY_SLOT = 23;

/** The duplicate-cluster question: the same words for every tenant, so a cross-tenant cluster or source list would show. */
export const V2_DUP_QUERY = `${DUP_WORDS.slice(0, 22).join(' ')}?`;

function lookupMarkers(tag: string, digits: string): Pick<
  V2TenantMarkers,
  'tableCell' | 'identifier' | 'identifierSibling' | 'supersededVersion' | 'currentVersion' | 'dupCopy'
> {
  const sibling = `${digits.slice(0, -1)}${(Number(digits.slice(-1)) + 1) % 10}`;
  return {
    tableCell: `v2cell${tag}`,
    identifier: `QX-${digits}`,
    identifierSibling: `QX-${sibling}`,
    supersededVersion: `v2older${tag}`,
    currentVersion: `v2newer${tag}`,
    dupCopy: `v2dup${tag}`,
  };
}

function lookupIds(base: number): V2LookupSeed {
  return {
    tableDocumentId: fixtureId(base + 1),
    tableChunkId: fixtureId(base + 2),
    identifierDocumentId: fixtureId(base + 3),
    identifierChunkId: fixtureId(base + 4),
    siblingDocumentId: fixtureId(base + 5),
    siblingChunkId: fixtureId(base + 6),
    supersededDocumentId: fixtureId(base + 7),
    supersededChunkId: fixtureId(base + 8),
    currentDocumentId: fixtureId(base + 9),
    currentChunkId: fixtureId(base + 10),
    dupDocumentIds: Array.from({ length: V2_DUP_COPIES }, (_, copy) => fixtureId(base + 0x20 + 2 * copy)),
    dupChunkIds: Array.from({ length: V2_DUP_COPIES }, (_, copy) => fixtureId(base + 0x21 + 2 * copy)),
    dupClusterId: '',
  };
}

export function tableText(markers: Pick<V2TenantMarkers, 'tableCell'>): string {
  const cell = markers.tableCell;
  return [
    'Register of synthetic entries.',
    '',
    '| Kolvar | Brisen | Tamuth |',
    '| --- | --- | --- |',
    `| ${cell}k1 | ${cell}k2 | ${cell}k3 |`,
    `| ${cell}k4 | ${cell}k2 | ${cell}k5 |`,
  ].join('\n');
}

/** Names two cell values of the first row of the tenant's table. */
export function tableQuery(markers: Pick<V2TenantMarkers, 'tableCell'>): string {
  return `Which register row pairs ${markers.tableCell}k1 with ${markers.tableCell}k3?`;
}

export function identifierText(identifier: string, wing: string): string {
  return `Plover register entry ${identifier} lists the quandle settings of the ${wing} wing.`;
}

export function identifierQuery(markers: Pick<V2TenantMarkers, 'identifier'>): string {
  return `Plover register entry ${markers.identifier}: which quandle settings does it list for the wing?`;
}

export function versionText(revision: string, count: string): string {
  return `Ledger revision ${revision}: the plimset count is ${count} per cycle.`;
}

/** Names the superseded revision word, which only the lexical and exact-id legs can reach under a widened version scope. */
export function versionQuery(markers: Pick<V2TenantMarkers, 'supersededVersion'>): string {
  return `What plimset count does ledger revision ${markers.supersededVersion} give?`;
}

export function dupPassage(markers: Pick<V2TenantMarkers, 'dupCopy'>, copy: number): string {
  const words = DUP_WORDS.slice();
  words[DUP_COPY_SLOT] = `${markers.dupCopy}c${copy}`;
  return words.join(' ');
}

/** The owner of seeded rows: a two-tenant fixture tenant, or the default tenant of a single-tenant database. */
export interface V2LookupOwner {
  label: string;
  userId: string | null;
  organizationId: string | null;
  markers: V2TenantMarkers;
  lookup: V2LookupSeed;
}

function sqlState(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** Service-role RPC access over PGlite for the product indexers and the dedupe service: named arguments, JSON objects serialised. */
export function serviceRoleRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const values = keys.map((key) => {
        const value = args[key];
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
      });
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Record<string, unknown>>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: sqlState(error) || 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

/** The product modules load the app environment, so they are imported only when a seed runs (after the caller set it). */
async function ownerScope(owner: V2LookupOwner): Promise<TenantScope> {
  const { mintScope } = await import('../../src/lib/rag/tenant/scope');
  if (owner.organizationId) return mintScope('org', owner.userId, owner.organizationId);
  if (owner.userId) return mintScope('personal', owner.userId, null);
  return mintScope('single', null, null);
}

async function insertOwnedDocument(db: PGlite, owner: V2LookupOwner, documentId: string, filename: string, content: string): Promise<void> {
  await db.query(
    'INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)',
    [documentId, filename, content, JSON.stringify({ relpath: `two-tenant-v2/${filename}` }), owner.userId, owner.organizationId, CREATED_AT, V2_CANARY_DOC_TYPE],
  );
}

async function insertOwnedChunk(db: PGlite, owner: V2LookupOwner, documentId: string, chunkId: string, content: string, filename: string, chunkKind = 'text'): Promise<void> {
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, organization_id, created_at, chunk_kind, content_hash)
     VALUES ($1, $2, $3, $4::vector, $5, 0, $6::jsonb, $7, $8, $9, $10)`,
    [
      chunkId,
      documentId,
      content,
      vectorLiteral(embedText(content)),
      chunkLexicalText({ sectionPath: [], content }),
      JSON.stringify({ name: filename }),
      owner.organizationId,
      CREATED_AT,
      chunkKind,
      crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    ],
  );
}

/** A lineage with a superseded version 1 (no vector: publish deletes it) and a current version 2. */
async function insertVersions(db: PGlite, owner: V2LookupOwner): Promise<void> {
  const { lookup, markers } = owner;
  const lineage = lookup.currentDocumentId;
  const filename = `v2-ledger-${owner.label}.md`;
  const versions = [
    { doc: lookup.currentDocumentId, chunk: lookup.currentChunkId, text: versionText(markers.currentVersion, 'nine'), version: 2, current: true, supersededBy: null },
    { doc: lookup.supersededDocumentId, chunk: lookup.supersededChunkId, text: versionText(markers.supersededVersion, 'seven'), version: 1, current: false, supersededBy: lookup.currentDocumentId },
  ];
  for (const v of versions) {
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at, doc_type, lineage_id, version, is_current, status, superseded_by, provisional, content_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, 'ready', $12, false, $13)`,
      [
        v.doc,
        filename,
        v.text,
        JSON.stringify({ relpath: `two-tenant-v2/${filename}` }),
        owner.userId,
        owner.organizationId,
        CREATED_AT,
        V2_CANARY_DOC_TYPE,
        lineage,
        v.version,
        v.current,
        v.supersededBy,
        crypto.createHash('sha256').update(v.text, 'utf8').digest('hex'),
      ],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, organization_id, created_at, chunk_kind, is_current, status, provisional)
       VALUES ($1, $2, $3, $4::vector, $5, 0, $6::jsonb, $7, $8, 'text', $9, 'ready', false)`,
      [
        v.chunk,
        v.doc,
        v.text,
        v.current ? vectorLiteral(embedText(v.text)) : null,
        chunkLexicalText({ sectionPath: [], content: v.text }),
        JSON.stringify({ name: filename }),
        owner.organizationId,
        CREATED_AT,
        v.current,
      ],
    );
  }
}

/**
 * Seeds for one owner the rows of the four Phase 4.2 paths: a Markdown table indexed into rag_table_rows by the write-time indexer,
 * two identifier documents indexed by the same indexer, a superseded and a current version of one lineage, and copies of the shared
 * passage. Clustering runs separately ({@link clusterLookupCopies}) once every owner is seeded, so a cross-tenant pair would be a candidate.
 */
export async function seedLookupRows(db: PGlite, owner: V2LookupOwner): Promise<void> {
  const { lookup, markers } = owner;
  const tableName = `v2-register-${owner.label}.md`;
  await insertOwnedDocument(db, owner, lookup.tableDocumentId, tableName, tableText(markers));
  await insertOwnedChunk(db, owner, lookup.tableDocumentId, lookup.tableChunkId, tableText(markers), tableName, 'table');

  const identifierName = `v2-plover-${owner.label}.md`;
  await insertOwnedDocument(db, owner, lookup.identifierDocumentId, identifierName, identifierText(markers.identifier, 'north'));
  await insertOwnedChunk(db, owner, lookup.identifierDocumentId, lookup.identifierChunkId, identifierText(markers.identifier, 'north'), identifierName);
  const siblingName = `v2-plover-${owner.label}-2.md`;
  await insertOwnedDocument(db, owner, lookup.siblingDocumentId, siblingName, identifierText(markers.identifierSibling, 'south'));
  await insertOwnedChunk(db, owner, lookup.siblingDocumentId, lookup.siblingChunkId, identifierText(markers.identifierSibling, 'south'), siblingName);

  await insertVersions(db, owner);

  for (let copy = 0; copy < V2_DUP_COPIES; copy += 1) {
    const name = `v2-pasted-${owner.label}-${copy}.md`;
    const text = dupPassage(markers, copy);
    await insertOwnedDocument(db, owner, lookup.dupDocumentIds[copy] as string, name, text);
    await insertOwnedChunk(db, owner, lookup.dupDocumentIds[copy] as string, lookup.dupChunkIds[copy] as string, text, name);
  }

  const { createIngestWriter } = await import('../../src/lib/rag/ingest/writer');
  const { indexDocumentForLookup } = await import('../../src/lib/rag/ingest/write-indexers');
  const scope = await ownerScope(owner);
  const rpc = serviceRoleRpc(db);
  const signal = new AbortController().signal;
  const noPatterns = async () => ({ expressions: Object.freeze([]) as readonly RegExp[], patternIds: Object.freeze([]) as readonly string[], loadFailed: false });
  const writer = createIngestWriter({ db: rpc, scope, signal });
  const indexed = [
    { documentId: lookup.tableDocumentId, tables: true, identifiers: false },
    { documentId: lookup.identifierDocumentId, tables: false, identifiers: true },
    { documentId: lookup.siblingDocumentId, tables: false, identifiers: true },
  ];
  for (const entry of indexed) {
    const report = await indexDocumentForLookup({ writer, scope, signal, loadPatterns: noPatterns, ...entry });
    if (report.warnings.length > 0) throw new Error(`[Two-tenant v2] indexing ${owner.label} warned: ${report.warnings.join(',')}`);
  }
}

/** Clusters each owner's pasted copies with the product dedupe service; every owner must end with exactly one cluster of its own copies. */
export async function clusterLookupCopies(db: PGlite, owners: V2LookupOwner[]): Promise<void> {
  const { clusterChunks } = await import('../../src/lib/rag/dedupe/cluster');
  const rpc = serviceRoleRpc(db);
  for (const owner of owners) {
    const report = await clusterChunks(await ownerScope(owner), owner.lookup.dupChunkIds, { db: rpc, threshold: 0.95 });
    if (report.clusters !== 1) throw new Error(`[Two-tenant v2] ${owner.label}: expected one duplicate cluster, got ${report.clusters}`);
    const rows = await db.query<{ cluster: string | null }>('SELECT DISTINCT dup_cluster_id::text AS cluster FROM document_chunks WHERE id = ANY($1::uuid[])', [
      owner.lookup.dupChunkIds,
    ]);
    const clusters = rows.rows.map((row) => row.cluster);
    if (clusters.length !== 1 || !clusters[0]) throw new Error(`[Two-tenant v2] ${owner.label}: copies are not in one cluster (${clusters.join(',')})`);
    owner.lookup.dupClusterId = clusters[0];
  }
}

/** The single-tenant owner of the four Phase 4.2 paths, for a single-tenant fixture database. */
export function singleTenantLookupOwner(): V2LookupOwner {
  const tag = 'xsolo1';
  return {
    label: 's',
    userId: null,
    organizationId: null,
    markers: {
      child: `v2child${tag}`,
      parent: `v2parent${tag}`,
      exact: `v2exact${tag}`,
      image: `v2image${tag}`,
      translated: `v2italian${tag}`,
      ...lookupMarkers(tag, '86214'),
    },
    lookup: lookupIds(0x1300),
  };
}

export function parentText(tenant: TwoTenantV2Tenant): string {
  return `Section of the canary handbook ${tenant.markers.parent}. ${childText(tenant, 0)} ${childText(tenant, 1)}`;
}

export function childText(tenant: TwoTenantV2Tenant, index: number): string {
  return `Two tenant isolation canary phrase: ${tenant.markers.child} clause ${index + 1} of the handbook`;
}

async function insertDocument(
  db: PGlite,
  tenant: TwoTenantV2Tenant,
  documentId: string,
  filename: string,
  content: string,
  language: string | null,
  docType: string = V2_CANARY_DOC_TYPE,
): Promise<void> {
  await db.query(
    'INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at, language, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)',
    [documentId, filename, content, JSON.stringify({ relpath: `two-tenant-v2/${filename}` }), tenant.userId, tenant.organizationId, CREATED_AT, language, docType],
  );
}

async function seedTypeOnlyDocument(db: PGlite, tenant: TwoTenantV2Tenant): Promise<V2TypeOnlyDocument> {
  const typeOnly: V2TypeOnlyDocument = {
    tenant: 'b',
    documentId: fixtureId(0x41),
    chunkId: fixtureId(0x42),
    docType: 'contract_legal',
    marker: 'v2contractbravo',
  };
  const content = `Supply contract renewal terms: ${typeOnly.marker} termination notice sixty days`;
  await insertDocument(db, tenant, typeOnly.documentId, 'v2-contract-b.md', content, null, typeOnly.docType);
  await insertLegacyChunk(db, tenant, typeOnly.documentId, typeOnly.chunkId, content, { name: 'v2-contract-b.md' }, 'text');
  return typeOnly;
}

async function insertLegacyChunk(
  db: PGlite,
  tenant: TwoTenantV2Tenant,
  documentId: string,
  chunkId: string,
  content: string,
  metadata: Record<string, unknown>,
  chunkKind: string,
): Promise<void> {
  await db.query(
    'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, organization_id, created_at, chunk_kind) VALUES ($1, $2, $3, $4::vector, 0, $5::jsonb, $6, $7, $8)',
    [chunkId, documentId, content, vectorLiteral(embedText(content)), JSON.stringify(metadata), tenant.organizationId, CREATED_AT, chunkKind],
  );
}

async function seedExtraDocuments(db: PGlite, tenant: TwoTenantV2Tenant): Promise<void> {
  const exactName = `v2-exact-${tenant.label}.md`;
  const exactContent = `Two tenant isolation canary phrase: catalogue item ${V2_EXACT_CODE} ${tenant.markers.exact}`;
  await insertDocument(db, tenant, tenant.exactDocumentId, exactName, exactContent, null);
  await insertLegacyChunk(db, tenant, tenant.exactDocumentId, tenant.exactChunkId, exactContent, { name: exactName }, 'text');

  const imageName = `v2-image-${tenant.label}.png`;
  const imageContent = `Two tenant isolation canary phrase: brand mark ${tenant.markers.image}`;
  await insertDocument(db, tenant, tenant.imageDocumentId, imageName, imageContent, null);
  await insertLegacyChunk(
    db,
    tenant,
    tenant.imageDocumentId,
    tenant.imageChunkId,
    imageContent,
    { name: imageName, image_context: 'brand logo mark', image_url: tenant.imageUrl },
    'image',
  );

  const translatedName = `v2-italian-${tenant.label}.md`;
  const translatedContent = `Frase canarino di isolamento nel manuale italiano ${tenant.markers.translated}`;
  await insertDocument(db, tenant, tenant.translatedDocumentId, translatedName, translatedContent, 'it');
  await insertLegacyChunk(db, tenant, tenant.translatedDocumentId, tenant.translatedChunkId, translatedContent, { name: translatedName }, 'text');
}

async function writeProfile(db: PGlite, tenant: TwoTenantV2Tenant): Promise<void> {
  const parents = [{ parent_index: 0, section_path: ['Handbook', 'Canary'], content: parentText(tenant), token_count: 120 }];
  const children = [0, 1].map((index) => {
    const content = childText(tenant, index);
    return {
      chunk_index: index,
      parent_index: 0,
      content,
      section_path: ['Handbook', 'Canary'],
      chunk_kind: 'text',
      embedding_text_version: 1,
      content_hash: `v2-${tenant.label}-${index}`,
      lexical_text: chunkLexicalText({ sectionPath: ['Handbook', 'Canary'], content }),
      metadata: { name: `v2-canary-${tenant.label}` },
    };
  });
  const embeddings = { [V2_LEGACY_EMBEDDING_PROFILE]: children.map((child) => embedText(child.content)) };
  await db.query(
    `SELECT * FROM rag_write_profile_chunks(
       p_document_id => $1, p_tenant_key => $2, p_profile_id => $3, p_parents => $4::jsonb, p_children => $5::jsonb, p_embeddings => $6::jsonb,
       p_final => true, p_total => $7)`,
    [
      tenant.canaryDocumentId,
      tenant.scopeKey,
      V2_CANARY_PROFILE_ID,
      JSON.stringify(parents),
      JSON.stringify(children),
      JSON.stringify(embeddings),
      children.length,
    ],
  );
  tenant.parentIds = [profileRowId(tenant.canaryDocumentId, V2_CANARY_PROFILE_ID, 'parent', 0)];
  tenant.childChunkIds = children.map((child) => profileRowId(tenant.canaryDocumentId, V2_CANARY_PROFILE_ID, 'child', child.chunk_index));
}

/**
 * Adds to a two-tenant database (personal A, personal B, organization O, one canary document each) the rows every Phase 4 retrieval path needs:
 * per tenant an exact-id chunk carrying the same code, an image chunk, an Italian chunk for translated variants, and the canary document's
 * parents and children under a non-legacy chunking profile that is made the active profile of its doc type with a direct UPDATE (the gated
 * activation function is not needed for a fixture pointer). All chunks are relexed. Tenants differ only by their marker words.
 */
export async function seedTwoTenantV2(db: PGlite): Promise<TwoTenantV2Seed> {
  const tenants = Object.fromEntries(SPECS.map((spec) => [spec.label, tenantOf(spec)])) as Record<V2TenantLabel, TwoTenantV2Tenant>;

  await db.exec(`
    INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
    VALUES ('${V2_CANARY_PROFILE_ID}', '${V2_CANARY_DOC_TYPE}', 128, 'structure', 512, 'building', '128/512')
    ON CONFLICT (id, doc_type) DO NOTHING`);

  for (const tenant of Object.values(tenants)) {
    await seedExtraDocuments(db, tenant);
  }
  const typeOnly = await seedTypeOnlyDocument(db, tenants.b);
  await runFixtureRelex(db);

  for (const tenant of Object.values(tenants)) {
    await writeProfile(db, tenant);
  }

  await db.query(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'legacy' AND doc_type = $1`, [V2_CANARY_DOC_TYPE]);
  await db.query(
    `UPDATE chunking_profiles SET status = 'active', activated_at = now(), activated_by = 'fixture', previous_active_id = 'legacy'
     WHERE id = $1 AND doc_type = $2`,
    [V2_CANARY_PROFILE_ID, V2_CANARY_DOC_TYPE],
  );

  return { tenants, profileId: V2_CANARY_PROFILE_ID, docType: V2_CANARY_DOC_TYPE, typeOnly };
}

/**
 * Adds the Phase 4.2 lookup rows (table, identifiers, versions, pasted copies; seedLookupRows) for the three tenants, then clusters the
 * copies. It runs the product indexer and dedupe service, which load the app environment, so the caller runs it after setting that.
 */
export async function seedTwoTenantV2Lookups(fixture: TwoTenantV2Database): Promise<void> {
  const owners = Object.values(fixture.seed.tenants);
  for (const owner of owners) await seedLookupRows(fixture.db, owner);
  await clusterLookupCopies(fixture.db, owners);
}

export async function createTwoTenantV2Database(options: { corpusDir?: string } = {}): Promise<TwoTenantV2Database> {
  const fixture = await createTwoTenantDatabase(options);
  try {
    const seed = await seedTwoTenantV2(fixture.db);
    return Object.assign(fixture, { seed });
  } catch (error) {
    await fixture.db.close().catch(() => undefined);
    throw error;
  }
}

/** Every marker word and canary phrase of the tenants other than the given one: none of these may appear in a caller's results. */
export function foreignMarkers(seed: TwoTenantV2Seed, own: V2TenantLabel): string[] {
  const foreign: string[] = [];
  for (const tenant of Object.values(seed.tenants)) {
    if (tenant.label === own) continue;
    foreign.push(...Object.values(tenant.markers));
  }
  if (own !== 'b') foreign.push(seed.typeOnly.marker);
  const phrases: Record<V2TenantLabel, string> = { a: 'alpha personal notes', b: 'bravo personal notes', o: 'organization shared handbook' };
  for (const label of Object.keys(phrases) as V2TenantLabel[]) {
    if (label !== own) foreign.push(phrases[label]);
  }
  return foreign;
}

/** One question both tenants ask the semantic cache: the same text, the same vector and the same key parts. */
export const V2_CACHE_QUESTION = 'which clause of the canary handbook describes tenant isolation';

export interface V2CacheSource {
  documentId: string;
  lineageId: string;
  version: number;
}

/**
 * A current, ready document of the tenant that a cached answer cites. Each call makes a new lineage, so a test can soft
 * delete or replace it without touching the canary rows. Inserting it deletes the tenant's cache rows (0603 trigger),
 * so callers store after seeding.
 */
export async function insertV2CacheSource(db: PGlite, tenant: TwoTenantV2Tenant): Promise<V2CacheSource> {
  const documentId = crypto.randomUUID();
  const filename = `v2-cache-source-${tenant.label}-${documentId.slice(0, 8)}.md`;
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at, lineage_id, source_key, status, is_current, version)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $1, $8, 'ready', true, 1)`,
    [
      documentId,
      filename,
      `Cache source of the canary handbook ${tenant.markers.child}`,
      JSON.stringify({ relpath: `two-tenant-v2/${filename}` }),
      tenant.userId,
      tenant.organizationId,
      CREATED_AT,
      `upload:${documentId}`,
    ],
  );
  return { documentId, lineageId: documentId, version: 1 };
}

/** A processing, not yet current next version of a cache source, for rag_publish_document_version. */
export async function insertV2CacheSourceVersion(db: PGlite, tenant: TwoTenantV2Tenant, source: V2CacheSource): Promise<string> {
  const documentId = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at, lineage_id, source_key, status, is_current, version)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7, $8, 'processing', false, $9)`,
    [
      documentId,
      `v2-cache-source-${tenant.label}-${documentId.slice(0, 8)}.md`,
      `Replaced cache source ${tenant.markers.child}`,
      tenant.userId,
      tenant.organizationId,
      CREATED_AT,
      source.lineageId,
      `upload:${source.lineageId}`,
      source.version + 1,
    ],
  );
  return documentId;
}

const CACHE_RPC_CASTS: Record<string, string> = {
  p_embedding: 'public.halfvec',
  p_answer: 'jsonb',
  p_source_versions: 'jsonb',
  p_document_ids: 'uuid[]',
};
const CACHE_RPC_SETOF = new Set(['rag_cache_check', 'rag_cache_resolve_sources']);

/** PostgREST-shaped service_role access to the cache RPCs over PGlite: a SETOF function answers rows, any other its single value. */
export function v2CacheServiceRoleRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const names = Object.keys(args);
      const values = names.map((name) => {
        const value = args[name];
        return CACHE_RPC_CASTS[name] === 'jsonb' && value !== null ? JSON.stringify(value) : value;
      });
      const params = names.map((name, index) => `${name} => $${index + 1}${CACHE_RPC_CASTS[name] ? `::${CACHE_RPC_CASTS[name]}` : ''}`).join(', ');
      const setof = CACHE_RPC_SETOF.has(fn);
      const sql = setof ? `SELECT * FROM public.${fn}(${params})` : `SELECT public.${fn}(${params}) AS value`;
      const pending: Promise<RpcResponse> = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Record<string, unknown>>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: setof ? rows : (rows[0]?.value ?? null), error: null }))
        .catch((error: unknown): RpcResponse => ({
          data: null,
          error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code },
        }));
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}
