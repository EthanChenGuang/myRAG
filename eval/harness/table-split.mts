import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { FakeEdge } from './fake-edge.mts';
import type { DeploymentMode, EmptyFixtureDatabase } from './pglite-supabase.mts';
import type { IngestInput, IngestResult } from '@/lib/rag/ingest/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';

/**
 * table_split items (D-45, EVAL-18) ask for one cell of a long table whose row lies beyond the first chunk. Their six documents
 * (eval/fixtures/ingest/manifest.json long_table_fixtures) would act as distractors for the old ingest items (research Pitfall 10),
 * so they are loaded into isolated fixture tenants: each its own database, served by the same fake edge when a table_split item
 * runs, and in multi-tenant mode also its own tenant key. The plain tables and their page-continued twins hold the same rows, so
 * each variant gets its own tenant and a gold quote names one document only.
 */
export const TABLE_SPLIT_CATEGORY = 'table_split';
/** The fixture user that owns the table_split documents in multi-tenant mode (a reserved fixture id, never a real account). */
export const TABLE_SPLIT_USER_ID = '00000000-0000-4000-8000-0000000003a1';
export const TABLE_SPLIT_GROUPS = ['plain', 'continued'] as const;
export type TableSplitGroup = (typeof TABLE_SPLIT_GROUPS)[number];

const MANIFEST_PATH = path.join('eval/fixtures/ingest/manifest.json');
const CONTINUED_SUFFIX = '-continued';

export interface LongTableFixture {
  id: string;
  doc_type: string;
  mime: string;
  path: string;
  file_sha256: string;
}

export interface TableSplitTenant {
  group: TableSplitGroup;
  db: PGlite;
  scope: TenantScope;
  tenantKey: string;
  /** The user an eval request names in multi-tenant mode; null in single-tenant mode. */
  userId: string | null;
  filenames: string[];
}

export function isTableSplitItem(item: { category: string }): boolean {
  return item.category === TABLE_SPLIT_CATEGORY;
}

/** The long-table fixtures in manifest order. */
export function longTableFixtures(): LongTableFixture[] {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { long_table_fixtures?: LongTableFixture[] };
  return manifest.long_table_fixtures ?? [];
}

export function tableSplitGroupOf(filename: string): TableSplitGroup {
  return path.posix.basename(filename, path.posix.extname(filename)).endsWith(CONTINUED_SUFFIX) ? 'continued' : 'plain';
}

/** The tenant an item runs against: every gold span must name a long-table document of one group. */
export function tableSplitGroupOfItem(item: { id: string; gold_evidence?: Array<{ document: string }> }): TableSplitGroup {
  const known = new Set(longTableFixtures().map((entry) => path.posix.basename(entry.path)));
  const groups = new Set<TableSplitGroup>();
  for (const span of item.gold_evidence ?? []) {
    if (!known.has(span.document)) throw new Error(`[Table Split] item ${item.id} cites ${span.document}, which is not a long-table fixture`);
    groups.add(tableSplitGroupOf(span.document));
  }
  const [group, ...rest] = [...groups];
  if (group === undefined || rest.length > 0) throw new Error(`[Table Split] item ${item.id} must cite documents of exactly one table tenant`);
  return group;
}

/** What the corpus hash of an ingest run adds when the table_split tenants are loaded. */
export function tableSplitCorpusParts(): string[] {
  return longTableFixtures().map((entry) => `table_split:${path.posix.basename(entry.path)}:${entry.file_sha256}`);
}

/**
 * Golden lines without the table_split items, for runs that cannot load their tenants (the prechunked mode and queued --routing
 * builds). Returns the input path unchanged when it has none.
 */
export function dropTableSplitItems(goldenPath: string, outPath: string): string {
  const lines = fs.readFileSync(goldenPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const kept = lines.filter((line) => !isTableSplitItem(JSON.parse(line) as { category: string }));
  if (kept.length === lines.length) return goldenPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${kept.join('\n')}\n`);
  return outPath;
}

/**
 * Creates one database per group, points the edge at it, ingests that group's documents through the unified ingest() of the running
 * build and points the edge back at the home database. Runs inside the ingest build, so the documents see the build's environment
 * and fakes.
 */
export async function loadTableSplitTenants(deps: {
  edge: FakeEdge;
  homeDb: PGlite;
  deploymentMode: DeploymentMode;
  createDatabase: () => Promise<EmptyFixtureDatabase>;
  ingest: (input: IngestInput) => Promise<IngestResult>;
  buildSourceKey: (source: 'config_upload', parts: { filename: string }) => string;
  mintScope: (kind: 'single' | 'personal', userId: string | null, organizationId: string | null) => TenantScope;
  scopeKey: (scope: TenantScope) => string;
}): Promise<TableSplitTenant[]> {
  const fixtures = longTableFixtures();
  const tenants: TableSplitTenant[] = [];
  try {
    for (const group of TABLE_SPLIT_GROUPS) {
      const members = fixtures.filter((entry) => tableSplitGroupOf(entry.path) === group);
      if (members.length === 0) continue;
      const created = await deps.createDatabase();
      deps.edge.useDatabase(created.db);
      try {
        const multi = deps.deploymentMode === 'multi-tenant';
        if (multi) {
          await created.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [TABLE_SPLIT_USER_ID, 'table-split-fixture@example.invalid']);
        }
        const scope = multi ? deps.mintScope('personal', TABLE_SPLIT_USER_ID, null) : deps.mintScope('single', null, null);
        tenants.push({
          group,
          db: created.db,
          scope,
          tenantKey: deps.scopeKey(scope),
          userId: multi ? TABLE_SPLIT_USER_ID : null,
          filenames: members.map((entry) => path.posix.basename(entry.path)),
        });
        for (const entry of members) {
          const filename = path.posix.basename(entry.path);
          const result = await deps.ingest({
            scope,
            source: 'config_upload',
            sourceKey: deps.buildSourceKey('config_upload', { filename }),
            file: new Uint8Array(fs.readFileSync(path.join('eval/fixtures/ingest', entry.path))),
            filename,
            mimeType: entry.mime,
            docType: entry.doc_type as IngestInput['docType'],
            signal: new AbortController().signal,
          });
          if (result.status !== 'ready') {
            throw new Error(`[Table Split] ${filename} ended ${result.status} (${result.reason ?? 'no reason'})`);
          }
        }
      } finally {
        deps.edge.useDatabase(deps.homeDb);
      }
    }
  } catch (error) {
    for (const tenant of tenants) await tenant.db.close().catch(() => undefined);
    throw error;
  }
  return tenants;
}

/** Runs `fn` with the edge serving the tenant of a table_split item, then serves the home database again. */
export async function withTableSplitTenant<T>(
  edge: FakeEdge,
  homeDb: PGlite,
  tenants: TableSplitTenant[],
  item: { id: string; gold_evidence?: Array<{ document: string }> },
  fn: (tenant: TableSplitTenant) => Promise<T>,
): Promise<T> {
  const group = tableSplitGroupOfItem(item);
  const tenant = tenants.find((candidate) => candidate.group === group);
  if (!tenant) throw new Error(`[Table Split] no ${group} tenant is loaded for item ${item.id}`);
  edge.useDatabase(tenant.db);
  try {
    return await fn(tenant);
  } finally {
    edge.useDatabase(homeDb);
  }
}

export async function closeTableSplitTenants(tenants: TableSplitTenant[] | undefined): Promise<void> {
  for (const tenant of tenants ?? []) await tenant.db.close().catch(() => undefined);
}
