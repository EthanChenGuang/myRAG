/**
 * Plan 03.3-23 (D-11, D-36, TPL-09): the Phase 3.3 state of the fixture tenant. `phase33BuildEnv` picks the Phase 3.3 switches a run
 * config sets to a value other than its default; only those are layered into the fixture build and hashed. `seedTemplatedTenant`
 * then writes what a deployment holds after its documented steps (attribute schema, section rules, boilerplate rules, header template,
 * attribute values) through the product services and the import function, before the first document is ingested. Patterns are data
 * here: they are checked by the services at save time and run only inside the pattern worker. Logs carry ids and counts only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { TenantScope } from '../../src/lib/rag/tenant/scope.ts';
import { loadTemplatedData, type TemplatedDataKey } from './templated-fixtures.mts';

const LOG = '[Eval Harness]';
const DATA_DIR = 'eval/fixtures/ingest/templated';

/** The Phase 3.3 ingestion-side switches and their defaults (src/lib/env.ts). RAG_IDENTIFIER_INDEX joins only with RAG_DOC_ATTRIBUTES. */
export const PHASE33_BUILD_DEFAULTS = {
  RAG_SECTION_RULES: 'off',
  RAG_PAGE_BOILERPLATE: 'off',
  RAG_DOC_ATTRIBUTES: 'false',
  RAG_ATTRIBUTE_HEADER: 'false',
  RAG_LEXICAL_QUANTITY: 'false',
  RAG_IDENTIFIER_INDEX: 'false',
} as const;

type Phase33Switch = keyof typeof PHASE33_BUILD_DEFAULTS;

/** Switches the app reads from the process environment (the typed RAG configuration), not from the ingest configuration. */
export const PHASE33_PROCESS_SWITCHES: readonly Phase33Switch[] = ['RAG_LEXICAL_QUANTITY', 'RAG_IDENTIFIER_INDEX'];

const DATA_FILE_NAMES: Record<TemplatedDataKey, string> = {
  attribute_schema: 'attribute-schema.json',
  attributes: 'attributes.json',
  section_rules: 'section-rules.json',
  boilerplate_rules: 'boilerplate-rules.json',
  header_template: 'header-template.json',
};

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function differs(env: Record<string, string | undefined>, name: Phase33Switch): boolean {
  const value = normalized(env[name]);
  return value !== '' && value !== PHASE33_BUILD_DEFAULTS[name];
}

/**
 * The Phase 3.3 switches of a run config that differ from their defaults, as written. A config that only restates the defaults
 * (tpl-all-off) gives an empty object, so its build, database and corpus hash equal a build without the option.
 */
export function phase33BuildEnv(runEnv: Record<string, string | undefined> | undefined): Record<string, string> {
  const env = runEnv ?? {};
  const out: Record<string, string> = {};
  for (const name of Object.keys(PHASE33_BUILD_DEFAULTS) as Phase33Switch[]) {
    if (name === 'RAG_IDENTIFIER_INDEX') continue;
    if (differs(env, name)) out[name] = (env[name] as string).trim();
  }
  if (out.RAG_DOC_ATTRIBUTES !== undefined && differs(env, 'RAG_IDENTIFIER_INDEX')) {
    out.RAG_IDENTIFIER_INDEX = (env.RAG_IDENTIFIER_INDEX as string).trim();
  }
  return out;
}

/** The layered switches the app reads from the process environment; they must be set while the build ingests. */
export function phase33ProcessEnv(buildEnv: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PHASE33_PROCESS_SWITCHES) if (buildEnv?.[name] !== undefined) out[name] = buildEnv[name];
  return out;
}

interface SeedPlan {
  schema: boolean;
  sectionRules: boolean;
  boilerplate: boolean;
  header: boolean;
  values: boolean;
}

function seedPlanOf(buildEnv: Record<string, string> | undefined): SeedPlan {
  const env = buildEnv ?? {};
  const attributes = normalized(env.RAG_DOC_ATTRIBUTES) === 'true';
  const boilerplate = normalized(env.RAG_PAGE_BOILERPLATE);
  return {
    schema: attributes,
    sectionRules: normalized(env.RAG_SECTION_RULES) === 'on',
    boilerplate: boilerplate === 'rules' || boilerplate === 'both',
    header: attributes && normalized(env.RAG_ATTRIBUTE_HEADER) === 'true',
    values: attributes,
  };
}

function seededFiles(plan: SeedPlan): TemplatedDataKey[] {
  const files: TemplatedDataKey[] = [];
  if (plan.schema) files.push('attribute_schema');
  if (plan.values) files.push('attributes');
  if (plan.sectionRules) files.push('section_rules');
  if (plan.boilerplate) files.push('boilerplate_rules');
  if (plan.header) files.push('header_template');
  return files;
}

/** Corpus-hash parts of a seeding build: one `phase33_seed:<file>:<sha256>` per data file it writes; empty when nothing is seeded. */
export function phase33SeedParts(buildEnv: Record<string, string> | undefined, root = process.cwd()): string[] {
  return seededFiles(seedPlanOf(buildEnv))
    .map((key) => DATA_FILE_NAMES[key])
    .sort()
    .map((name) => {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, DATA_DIR, name))).digest('hex');
      return `phase33_seed:${name}:${sha}`;
    });
}

export interface TemplatedSeedReport {
  /** Data files written, by name. */
  files: string[];
  definitions: number;
  sectionRuleSets: number;
  boilerplateRules: number;
  headerTemplateVersion: number | null;
  attributeRows: number;
}

function fail(step: string, detail: string): never {
  throw new Error(`${LOG} templated seeding failed at ${step}: ${detail}`);
}

/**
 * Writes the fixture tenant's Phase 3.3 data for the switches the build layers, through the services an admin uses (each pattern
 * passes the save-time check) and runAttributesImport in apply mode, which stages the values because the documents do not exist yet.
 * Call after the ingest fakes are installed (the services use the ingest deps' client) and before the first document. Seeds nothing
 * and makes nobody an admin when no layered switch needs data.
 */
export async function seedTemplatedTenant(options: {
  db: PGlite;
  scope: TenantScope;
  fixtureUserId: string;
  deploymentMode: 'single-tenant' | 'multi-tenant';
  buildEnv: Record<string, string> | undefined;
  signal?: AbortSignal;
}): Promise<TemplatedSeedReport> {
  const plan = seedPlanOf(options.buildEnv);
  const report: TemplatedSeedReport = {
    files: seededFiles(plan).map((key) => DATA_FILE_NAMES[key]),
    definitions: 0,
    sectionRuleSets: 0,
    boilerplateRules: 0,
    headerTemplateVersion: null,
    attributeRows: 0,
  };
  if (report.files.length === 0) return report;
  const signal = options.signal ?? new AbortController().signal;

  // The fixture user becomes the tenant's admin the way the two-tenant tests do it: an admin_users row (rag_admin_tenant_keys admits
  // s:default in single-tenant mode and the admin's personal key u:<id> in multi-tenant mode); multi-tenant builds already hold the user.
  if (options.deploymentMode === 'single-tenant') {
    await options.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      options.fixtureUserId,
      'fixture-user@example.invalid',
    ]);
  }
  await options.db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [options.fixtureUserId]);

  const { scopeKey } = await import('../../src/lib/rag/tenant/scope.ts');
  const tenantKey = scopeKey(options.scope).toLowerCase();
  const admin = { actorUserId: options.fixtureUserId, tenantKey, signal };
  const data = loadTemplatedData();

  if (plan.schema) {
    const { upsertAttributeDefinition } = await import('../../src/lib/rag/ingest/attributes/schema.ts');
    const definitions = (data.attribute_schema as { definitions: Array<Parameters<typeof upsertAttributeDefinition>[1]> }).definitions;
    for (const definition of definitions) {
      const saved = await upsertAttributeDefinition(admin, definition);
      if (!saved.ok) fail('attribute_schema', saved.reason);
      report.definitions += 1;
    }
  }

  if (plan.sectionRules || plan.boilerplate) {
    const service = await import('../../src/lib/rag/ingest/rules/service.ts');
    if (plan.sectionRules) {
      for (const ruleSet of (data.section_rules as { section_rule_sets: unknown[] }).section_rule_sets) {
        const saved = await service.saveSectionRuleSet(admin, ruleSet);
        if (!saved.ok) fail('section_rules', saved.reason);
        report.sectionRuleSets += 1;
      }
    }
    if (plan.boilerplate) {
      for (const rule of (data.boilerplate_rules as { boilerplate_rules: unknown[] }).boilerplate_rules) {
        const saved = await service.saveBoilerplateRule(admin, rule);
        if (!saved.ok) fail('boilerplate_rules', saved.reason);
        report.boilerplateRules += 1;
      }
    }
  }

  if (plan.header) {
    const { setHeaderTemplate } = await import('../../src/lib/rag/ingest/attributes/header.ts');
    const saved = await setHeaderTemplate(admin, (data.header_template as { template: string }).template);
    if (!saved.ok) fail('header_template', saved.reason);
    report.headerTemplateVersion = saved.version;
  }

  if (plan.values) {
    const { runAttributesImport } = await import('../../src/lib/rag/ingest/attributes/import.ts');
    const rows = (data.attributes as { rows: unknown[] }).rows;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase33-seed-'));
    const file = path.join(dir, 'attributes.jsonl');
    try {
      fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      const outcome = await runAttributesImport(
        { scope: options.scope, file, apply: true },
        { signal, io: { out: () => undefined, err: () => undefined } },
      );
      if (outcome.exitCode !== 0) fail('attributes', `${outcome.status} (exit ${outcome.exitCode}, ${outcome.errors.length} line errors)`);
      report.attributeRows = rows.length;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`${LOG} phase33_seeded`, {
    files: report.files.length,
    definitions: report.definitions,
    section_rule_sets: report.sectionRuleSets,
    boilerplate_rules: report.boilerplateRules,
    header_template_version: report.headerTemplateVersion,
    attribute_rows: report.attributeRows,
  });
  return report;
}
