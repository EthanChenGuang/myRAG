import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { chunkLexicalText } from '../../src/lib/rag/lexical/chunk-text';
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
    },
    childChunkIds: [],
    parentIds: [],
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
