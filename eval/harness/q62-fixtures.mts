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
const Q62_MANIFEST_PATH = path.join(Q62_CORPUS_DIR, 'manifest.json');

/** The fixture user that owns the q62 documents and administers their scope vocabulary (a reserved fixture id, never a real account). */
export const Q62_USER_ID = '00000000-0000-4000-8000-0000000006a2';
export const Q62_CATEGORIES = ['scoped_compound', 'glossary', 'version_compare'] as const;
export const Q62_OFF_DOMAIN_TAG = 'off_domain';

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

export interface Q62Tenant {
  db: PGlite;
  tenantKey: string;
  /** The user an eval request names in multi-tenant mode; null in single-tenant mode. */
  userId: string | null;
  /** The golden id of every q62 document (the prechunked derivation from its path) to the id of the document written for it. */
  documentIds: Map<string, string>;
  filenames: string[];
}

export function isQ62Item(item: { category: string; tags?: readonly string[] | null }): boolean {
  return (Q62_CATEGORIES as readonly string[]).includes(item.category) || (item.tags ?? []).includes(Q62_OFF_DOMAIN_TAG);
}

export function loadQ62Manifest(): Q62Manifest {
  return JSON.parse(fs.readFileSync(Q62_MANIFEST_PATH, 'utf8')) as Q62Manifest;
}

export function q62Corpus(): LoadedCorpus {
  return loadCorpus(Q62_CORPUS_DIR);
}

/** What the corpus hash of a run adds when the q62 tenant is loaded. */
export function q62CorpusParts(): string[] {
  const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(Q62_MANIFEST_PATH)).digest('hex');
  return [`q62:${q62Corpus().corpusSha256}`, `q62_manifest:${manifestSha}`];
}

export function q62TenantKey(deploymentMode: DeploymentMode): string {
  return deploymentMode === 'multi-tenant' ? `u:${Q62_USER_ID}` : 's:default';
}

/** The glossary rows (TERM kind translation, with a target language) on the q62 tenant's own layer. */
export function q62GlossarySeed(layer: string): TerminologySeedRow[] {
  return loadQ62Manifest().glossary.map((entry) => ({
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

/** The q62 owner exists in auth.users and admin_users, so it may create the tenant's vocabulary and tag its documents. */
async function addQ62Owner(db: PGlite): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [Q62_USER_ID, 'q62-fixture@example.invalid']);
  await db.query('INSERT INTO public.admin_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [Q62_USER_ID]);
}

/** Scope vocabulary and document tags through the Phase 3.2 writers (rag_scope_vocabulary_create, rag_set_document_scopes). */
async function writeQ62Scopes(db: PGlite, tenantKey: string, documentIdByFilename: ReadonlyMap<string, string>): Promise<void> {
  const manifest = loadQ62Manifest();
  for (const entry of manifest.vocabulary) {
    await db.query('SELECT id FROM public.rag_scope_vocabulary_create($1, $2, $3, $4, $5)', [
      Q62_USER_ID,
      tenantKey,
      entry.dimension,
      entry.value,
      entry.label,
    ]);
  }
  for (const [filename, scopes] of Object.entries(manifest.document_scopes)) {
    const documentId = documentIdByFilename.get(filename);
    if (!documentId) throw new Error(`[Q62 Fixtures] ${filename} has scope tags but was not loaded`);
    await db.query('SELECT document_id FROM public.rag_set_document_scopes($1, $2, $3::text[], $4)', [documentId, tenantKey, scopes, Q62_USER_ID]);
  }
}

async function finishQ62Tenant(
  db: PGlite,
  deploymentMode: DeploymentMode,
  tenantKey: string,
  written: Array<{ doc: CorpusDocument; documentId: string }>,
  seedTerminology: (db: PGlite, rows: readonly TerminologySeedRow[]) => Promise<void>,
): Promise<Q62Tenant> {
  await writeQ62Scopes(db, tenantKey, new Map(written.map(({ doc, documentId }) => [doc.filename, documentId])));
  await seedTerminology(db, q62GlossarySeed(tenantKey));
  return {
    db,
    tenantKey,
    userId: deploymentMode === 'multi-tenant' ? Q62_USER_ID : null,
    documentIds: new Map(written.map(({ doc, documentId }) => [doc.id, documentId])),
    filenames: written.map(({ doc }) => doc.filename),
  };
}

/** Prechunked mode: the q62 documents as pre-cut ready rows of the q62 tenant, then relex, scope tags and the glossary rows. */
export async function loadQ62PrechunkedTenant(deps: {
  deploymentMode: DeploymentMode;
  createDatabase: () => Promise<EmptyFixtureDatabase>;
  prechunkedWriter: (db: PGlite, deploymentMode: DeploymentMode, latestVersions?: ReadonlyMap<string, number>, ownerUserId?: string) => Promise<(doc: CorpusDocument) => Promise<void>>;
  latestLineageVersions: (documents: readonly CorpusDocument[]) => Map<string, number>;
  supersedeFixtureLineages: (db: PGlite, documents: readonly CorpusDocument[]) => Promise<void>;
  runFixtureRelex: (db: PGlite) => Promise<void>;
  seedTerminology: (db: PGlite, rows: readonly TerminologySeedRow[]) => Promise<void>;
}): Promise<Q62Tenant> {
  const corpus = q62Corpus();
  const { db } = await deps.createDatabase();
  try {
    await addQ62Owner(db);
    const writer = await deps.prechunkedWriter(db, deps.deploymentMode, deps.latestLineageVersions(corpus.documents), Q62_USER_ID);
    for (const doc of corpus.documents) await writer(doc);
    await deps.runFixtureRelex(db);
    await deps.supersedeFixtureLineages(db, corpus.documents);
    const tenantKey = q62TenantKey(deps.deploymentMode);
    return await finishQ62Tenant(
      db,
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

/**
 * Ingest mode: points the edge at a new database, ingests the q62 documents through the unified ingest() of the running build as
 * config uploads of the q62 tenant, writes their scope tags and glossary rows and points the edge back at the home database.
 */
export async function loadQ62IngestTenant(deps: {
  edge: FakeEdge;
  homeDb: PGlite;
  deploymentMode: DeploymentMode;
  createDatabase: () => Promise<EmptyFixtureDatabase>;
  ingest: (input: IngestInput) => Promise<IngestResult>;
  buildSourceKey: (source: 'config_upload', parts: { filename: string }) => string;
  mintScope: (kind: 'single' | 'personal', userId: string | null, organizationId: string | null) => TenantScope;
  scopeKey: (scope: TenantScope) => string;
  seedTerminology: (db: PGlite, rows: readonly TerminologySeedRow[]) => Promise<void>;
}): Promise<Q62Tenant> {
  const corpus = q62Corpus();
  if (corpus.documents.some((doc) => doc.lineage)) throw new Error('[Q62 Fixtures] lineage versions are seeded only by the prechunked mode');
  const { db } = await deps.createDatabase();
  deps.edge.useDatabase(db);
  try {
    await addQ62Owner(db);
    const multi = deps.deploymentMode === 'multi-tenant';
    const scope = multi ? deps.mintScope('personal', Q62_USER_ID, null) : deps.mintScope('single', null, null);
    const tenantKey = deps.scopeKey(scope);
    if (tenantKey !== q62TenantKey(deps.deploymentMode)) throw new Error(`[Q62 Fixtures] unexpected tenant key ${tenantKey}`);
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
    return await finishQ62Tenant(db, deps.deploymentMode, tenantKey, written, deps.seedTerminology);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  } finally {
    deps.edge.useDatabase(deps.homeDb);
  }
}

/** Runs `fn` with the edge serving the q62 tenant, then serves the home database again. */
export async function withQ62Tenant<T>(edge: FakeEdge, homeDb: PGlite, tenant: Q62Tenant, fn: () => Promise<T>): Promise<T> {
  edge.useDatabase(tenant.db);
  try {
    return await fn();
  } finally {
    edge.useDatabase(homeDb);
  }
}

export async function closeQ62Tenant(tenant: Q62Tenant | undefined): Promise<void> {
  await tenant?.db.close().catch(() => undefined);
}
