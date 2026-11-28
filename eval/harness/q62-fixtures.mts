import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { loadCorpus, type CorpusDocument, type LoadedCorpus } from './corpus.mts';
import type { FakeEdge } from './fake-edge.mts';
import type { DeploymentMode, EmptyFixtureDatabase, TerminologySeedRow } from './pglite-supabase.mts';
import type { IngestInput, IngestResult } from '@/lib/rag/ingest/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';

/**
 * Phase 6.2 fixture documents (D-09, D-15, D-27, P-25): scope-tagged documents for scoped_compound items, documents whose answers
 * depend on an invented term with a seeded glossary row, and passages adjacent to an off-domain topic. They would act as distractors
 * for the existing items, so they load into an isolated fixture tenant: its own database, served by the same fake edge only while a
 * q62 item runs, and in multi-tenant mode also its own tenant key. Every other item runs against the main fixture tenant unchanged.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const Q62_CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/q62-corpus');

/** The fixture user that owns the q62 documents and administers their scope vocabulary (a reserved fixture id, never a real account). */
export const Q62_USER_ID = '00000000-0000-4000-8000-0000000006a2';
export const Q62_CATEGORIES = ['scoped_compound', 'glossary', 'version_compare'] as const;
export const Q62_OFF_DOMAIN_TAG = 'off_domain';

/**
 * Plan 06.2-41 (XLG-07, 06.2-VERIFICATION.md R-3): a tenant dominated by one language (zh at least 80%, en and it at most 20% each),
 * so XLG-01's share rule raises R8 and enables translate for en and it questions. Same isolation as the q62 tenant, its own corpus
 * and its own reserved fixture user; items reach it only through the tag.
 */
export const DOMINANT_LANGUAGE_CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/q62-dominant-corpus');
export const DOMINANT_LANGUAGE_USER_ID = '00000000-0000-4000-8000-0000000006c2';
export const DOMINANT_LANGUAGE_TAG = 'dominant_language';

/** What sets an isolated fixture tenant apart: its corpus (with a manifest.json beside it) and the reserved fixture user that owns it. */
export interface IsolatedTenantDescriptor {
  name: string;
  corpusDir: string;
  userId: string;
  email: string;
  /**
   * Prechunked mode: also write each document's corpus language to documents.language, which rag_tenant_language_shares counts (the
   * prechunked writer keeps it in metadata only, so without this step a prechunked tenant has no KB language shares at all).
   */
  recordDocumentLanguage?: boolean;
}

export const Q62_TENANT: IsolatedTenantDescriptor = {
  name: 'q62',
  corpusDir: Q62_CORPUS_DIR,
  userId: Q62_USER_ID,
  email: 'q62-fixture@example.invalid',
};

export const DOMINANT_LANGUAGE_TENANT: IsolatedTenantDescriptor = {
  name: 'dominant_language',
  corpusDir: DOMINANT_LANGUAGE_CORPUS_DIR,
  userId: DOMINANT_LANGUAGE_USER_ID,
  email: 'dominant-language-fixture@example.invalid',
  recordDocumentLanguage: true,
};

const manifestPath = (descriptor: IsolatedTenantDescriptor): string => path.join(descriptor.corpusDir, 'manifest.json');

export interface Q62VocabularyEntry {
  dimension: 'region' | 'legal_entity' | 'department';
  value: string;
  label: string;
}

export interface Q62GlossaryEntry {
  canonical: string;
  variants: string[];
  language: string;
  target_language: string;
}

export interface Q62Manifest {
  vocabulary: Q62VocabularyEntry[];
  /** Document filename to its scope tags, `dimension:value`. */
  document_scopes: Record<string, string[]>;
  glossary: Q62GlossaryEntry[];
}

export interface IsolatedFixtureTenant {
  db: PGlite;
  tenantKey: string;
  /** The user an eval request names in multi-tenant mode; null in single-tenant mode. */
  userId: string | null;
  /** The golden id of every q62 document (the prechunked derivation from its path) to the id of the document written for it. */
  documentIds: Map<string, string>;
  filenames: string[];
}

export type Q62Tenant = IsolatedFixtureTenant;

export function isQ62Item(item: { category: string; tags?: readonly string[] | null }): boolean {
  return (Q62_CATEGORIES as readonly string[]).includes(item.category) || (item.tags ?? []).includes(Q62_OFF_DOMAIN_TAG);
}

/** An item tagged dominant_language runs against the dominant-language tenant and no other. */
export function isDominantLanguageItem(item: { tags?: readonly string[] | null }): boolean {
  return (item.tags ?? []).includes(DOMINANT_LANGUAGE_TAG);
}

/** Every item served by an isolated Phase 6.2 tenant (q62 or dominant-language): older checks on the main tenant leave them out. */
export function isIsolatedQ62Item(item: { category: string; tags?: readonly string[] | null }): boolean {
  return isQ62Item(item) || isDominantLanguageItem(item);
}

export function loadIsolatedManifest(descriptor: IsolatedTenantDescriptor): Q62Manifest {
  return JSON.parse(fs.readFileSync(manifestPath(descriptor), 'utf8')) as Q62Manifest;
}

export function loadQ62Manifest(): Q62Manifest {
  return loadIsolatedManifest(Q62_TENANT);
}

export function isolatedCorpus(descriptor: IsolatedTenantDescriptor): LoadedCorpus {
  return loadCorpus(descriptor.corpusDir);
}

export function q62Corpus(): LoadedCorpus {
  return isolatedCorpus(Q62_TENANT);
}

/** What the corpus hash of a run adds when an isolated tenant is loaded. */
export function isolatedCorpusParts(descriptor: IsolatedTenantDescriptor): string[] {
  const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(manifestPath(descriptor))).digest('hex');
  return [`${descriptor.name}:${isolatedCorpus(descriptor).corpusSha256}`, `${descriptor.name}_manifest:${manifestSha}`];
}

export function q62CorpusParts(): string[] {
  return isolatedCorpusParts(Q62_TENANT);
}

export function dominantLanguageCorpusParts(): string[] {
  return isolatedCorpusParts(DOMINANT_LANGUAGE_TENANT);
}

export function isolatedTenantKey(descriptor: IsolatedTenantDescriptor, deploymentMode: DeploymentMode): string {
  return deploymentMode === 'multi-tenant' ? `u:${descriptor.userId}` : 's:default';
}

export function q62TenantKey(deploymentMode: DeploymentMode): string {
  return isolatedTenantKey(Q62_TENANT, deploymentMode);
}

/** The glossary rows (TERM kind translation, with a target language) on the tenant's own layer. */
export function isolatedGlossarySeed(descriptor: IsolatedTenantDescriptor, layer: string): TerminologySeedRow[] {
  return loadIsolatedManifest(descriptor).glossary.map((entry) => ({
    layer,
    canonical: entry.canonical,
    variants: entry.variants,
    language: entry.language,
    kind: 'translation',
    mode: 'one_way',
    source_language: entry.language,
    target_language: entry.target_language,
  }));
}

export function q62GlossarySeed(layer: string): TerminologySeedRow[] {
  return isolatedGlossarySeed(Q62_TENANT, layer);
}

/**
 * The owner exists in auth.users; a tenant with a scope vocabulary also has it in admin_users, so it may create the vocabulary and tag
 * its documents.
 */
async function addOwner(db: PGlite, descriptor: IsolatedTenantDescriptor): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [descriptor.userId, descriptor.email]);
  if (loadIsolatedManifest(descriptor).vocabulary.length === 0) return;
  await db.query('INSERT INTO public.admin_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [descriptor.userId]);
}

/** Scope vocabulary and document tags through the Phase 3.2 writers (rag_scope_vocabulary_create, rag_set_document_scopes). */
async function writeScopes(
  db: PGlite,
  descriptor: IsolatedTenantDescriptor,
  tenantKey: string,
  documentIdByFilename: ReadonlyMap<string, string>,
): Promise<void> {
  const manifest = loadIsolatedManifest(descriptor);
  for (const entry of manifest.vocabulary) {
    await db.query('SELECT id FROM public.rag_scope_vocabulary_create($1, $2, $3, $4, $5)', [
      descriptor.userId,
      tenantKey,
      entry.dimension,
      entry.value,
      entry.label,
    ]);
  }
  for (const [filename, scopes] of Object.entries(manifest.document_scopes)) {
    const documentId = documentIdByFilename.get(filename);
    if (!documentId) throw new Error(`[Q62 Fixtures] ${filename} has scope tags but was not loaded`);
    await db.query('SELECT document_id FROM public.rag_set_document_scopes($1, $2, $3::text[], $4)', [documentId, tenantKey, scopes, descriptor.userId]);
  }
}

async function finishTenant(
  db: PGlite,
  descriptor: IsolatedTenantDescriptor,
  deploymentMode: DeploymentMode,
  tenantKey: string,
  written: Array<{ doc: CorpusDocument; documentId: string }>,
  seedTerminology: (db: PGlite, rows: readonly TerminologySeedRow[]) => Promise<void>,
): Promise<IsolatedFixtureTenant> {
  await writeScopes(db, descriptor, tenantKey, new Map(written.map(({ doc, documentId }) => [doc.filename, documentId])));
  await seedTerminology(db, isolatedGlossarySeed(descriptor, tenantKey));
  return {
    db,
    tenantKey,
    userId: deploymentMode === 'multi-tenant' ? descriptor.userId : null,
    documentIds: new Map(written.map(({ doc, documentId }) => [doc.id, documentId])),
    filenames: written.map(({ doc }) => doc.filename),
  };
}

export interface PrechunkedTenantDeps {
  deploymentMode: DeploymentMode;
  createDatabase: () => Promise<EmptyFixtureDatabase>;
  prechunkedWriter: (db: PGlite, deploymentMode: DeploymentMode, latestVersions?: ReadonlyMap<string, number>, ownerUserId?: string) => Promise<(doc: CorpusDocument) => Promise<void>>;
  latestLineageVersions: (documents: readonly CorpusDocument[]) => Map<string, number>;
  supersedeFixtureLineages: (db: PGlite, documents: readonly CorpusDocument[]) => Promise<void>;
  runFixtureRelex: (db: PGlite) => Promise<void>;
  seedTerminology: (db: PGlite, rows: readonly TerminologySeedRow[]) => Promise<void>;
}

/** Prechunked mode: the tenant's documents as pre-cut ready rows of its tenant, then relex, scope tags and the glossary rows. */
export async function loadIsolatedPrechunkedTenant(descriptor: IsolatedTenantDescriptor, deps: PrechunkedTenantDeps): Promise<IsolatedFixtureTenant> {
  const corpus = isolatedCorpus(descriptor);
  const { db } = await deps.createDatabase();
  try {
    await addOwner(db, descriptor);
    const writer = await deps.prechunkedWriter(db, deps.deploymentMode, deps.latestLineageVersions(corpus.documents), descriptor.userId);
    for (const doc of corpus.documents) await writer(doc);
    if (descriptor.recordDocumentLanguage) {
      for (const doc of corpus.documents) await db.query('UPDATE public.documents SET language = $2 WHERE id = $1', [doc.id, doc.language]);
    }
    await deps.runFixtureRelex(db);
    await deps.supersedeFixtureLineages(db, corpus.documents);
    const tenantKey = isolatedTenantKey(descriptor, deps.deploymentMode);
    return await finishTenant(
      db,
      descriptor,
      deps.deploymentMode,
      tenantKey,
      corpus.documents.map((doc) => ({ doc, documentId: doc.id })),
      deps.seedTerminology,
    );
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

/** Prechunked mode, q62 tenant. */
export async function loadQ62PrechunkedTenant(deps: PrechunkedTenantDeps): Promise<Q62Tenant> {
  return loadIsolatedPrechunkedTenant(Q62_TENANT, deps);
}

export interface IngestTenantDeps {
  edge: FakeEdge;
  homeDb: PGlite;
  deploymentMode: DeploymentMode;
  createDatabase: () => Promise<EmptyFixtureDatabase>;
  ingest: (input: IngestInput) => Promise<IngestResult>;
  buildSourceKey: (source: 'config_upload', parts: { filename: string }) => string;
  mintScope: (kind: 'single' | 'personal', userId: string | null, organizationId: string | null) => TenantScope;
  scopeKey: (scope: TenantScope) => string;
  seedTerminology: (db: PGlite, rows: readonly TerminologySeedRow[]) => Promise<void>;
}

/**
 * Ingest mode: points the edge at a new database, ingests the tenant's documents through the unified ingest() of the running build as
 * config uploads of that tenant, writes their scope tags and glossary rows and points the edge back at the home database.
 */
export async function loadIsolatedIngestTenant(descriptor: IsolatedTenantDescriptor, deps: IngestTenantDeps): Promise<IsolatedFixtureTenant> {
  const corpus = isolatedCorpus(descriptor);
  if (corpus.documents.some((doc) => doc.lineage)) throw new Error('[Q62 Fixtures] lineage versions are seeded only by the prechunked mode');
  const { db } = await deps.createDatabase();
  deps.edge.useDatabase(db);
  try {
    await addOwner(db, descriptor);
    const multi = deps.deploymentMode === 'multi-tenant';
    const scope = multi ? deps.mintScope('personal', descriptor.userId, null) : deps.mintScope('single', null, null);
    const tenantKey = deps.scopeKey(scope);
    if (tenantKey !== isolatedTenantKey(descriptor, deps.deploymentMode)) throw new Error(`[Q62 Fixtures] unexpected tenant key ${tenantKey}`);
    const written: Array<{ doc: CorpusDocument; documentId: string }> = [];
    for (const doc of corpus.documents) {
      const result = await deps.ingest({
        scope,
        source: 'config_upload',
        sourceKey: deps.buildSourceKey('config_upload', { filename: doc.filename }),
        text: doc.content,
        filename: doc.filename,
        mimeType: 'text/markdown',
        docType: doc.docType as IngestInput['docType'],
        signal: new AbortController().signal,
      });
      if (result.status !== 'ready' || !result.documentId) {
        throw new Error(`[Q62 Fixtures] ${doc.filename} ended ${result.status} (${result.reason ?? 'no reason'})`);
      }
      written.push({ doc, documentId: result.documentId });
    }
    return await finishTenant(db, descriptor, deps.deploymentMode, tenantKey, written, deps.seedTerminology);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  } finally {
    deps.edge.useDatabase(deps.homeDb);
  }
}

/** Ingest mode, q62 tenant. */
export async function loadQ62IngestTenant(deps: IngestTenantDeps): Promise<Q62Tenant> {
  return loadIsolatedIngestTenant(Q62_TENANT, deps);
}

/**
 * Runs `fn` with the edge serving the tenant's database, then serves the home database again. The optional `onSwitch` runs after each
 * switch (the harness drops per-tenant-key caches there: in single-tenant mode every fixture database answers to `s:default`).
 */
export async function withIsolatedTenant<T>(
  edge: FakeEdge,
  homeDb: PGlite,
  tenant: IsolatedFixtureTenant,
  fn: () => Promise<T>,
  onSwitch?: () => void,
): Promise<T> {
  edge.useDatabase(tenant.db);
  onSwitch?.();
  try {
    return await fn();
  } finally {
    edge.useDatabase(homeDb);
    onSwitch?.();
  }
}

/** Runs `fn` with the edge serving the q62 tenant, then serves the home database again. */
export async function withQ62Tenant<T>(edge: FakeEdge, homeDb: PGlite, tenant: Q62Tenant, fn: () => Promise<T>): Promise<T> {
  return withIsolatedTenant(edge, homeDb, tenant, fn);
}

export async function closeIsolatedTenant(tenant: IsolatedFixtureTenant | undefined): Promise<void> {
  await tenant?.db.close().catch(() => undefined);
}

export async function closeQ62Tenant(tenant: Q62Tenant | undefined): Promise<void> {
  await closeIsolatedTenant(tenant);
}
