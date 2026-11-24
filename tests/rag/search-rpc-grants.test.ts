import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { migrationFiles, type MigrationMode } from '../../eval/harness/migrations.mts';
import { AUTHENTICATED_ALLOW_LIST } from '../helpers/security-definer-allow-list';
import { aclViolation, simulateFunctionAcls } from '../helpers/sql-function-acl';

const SQL = fs.readFileSync(path.resolve(__dirname, '../../supabase/multi-tenant-setup.sql'), 'utf8');
const SINGLE = fs.readFileSync(path.resolve(__dirname, '../../supabase/single-tenant-setup.sql'), 'utf8');

const TENANT_ID_RPCS = [
  'match_documents_by_workspace',
  'match_document_chunks_by_org',
  'get_documents_by_type_slug',
  'get_documents_by_type_slug_workspace',
];

function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement !== '');
}

function aclFor(name: string): string[] {
  return statements(SQL).filter((statement) => /^(GRANT|REVOKE)\b/i.test(statement) && new RegExp(`FUNCTION (public\\.)?${name}\\b`, 'i').test(statement));
}

describe('SECURITY DEFINER search functions that trust caller-supplied tenant ids', () => {
  test.each(TENANT_ID_RPCS)('%s is revoked from PUBLIC, anon and authenticated and granted to service_role only', (name) => {
    const acl = aclFor(name);
    const revoke = acl.find((statement) => /^REVOKE\b/i.test(statement));
    expect(revoke, `${name} has no REVOKE`).toBeDefined();
    expect(revoke).toMatch(/FROM PUBLIC, anon, authenticated$/i);

    const grants = acl.filter((statement) => /^GRANT\b/i.test(statement));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/TO service_role$/i);
    expect(acl.indexOf(revoke as string)).toBeLessThan(acl.indexOf(grants[0]));
  });

  test('no grant of these functions to anon or authenticated survives anywhere in the setup files', () => {
    for (const sql of [SQL, SINGLE]) {
      for (const statement of statements(sql)) {
        if (!/^GRANT\b/i.test(statement)) continue;
        for (const name of TENANT_ID_RPCS) {
          if (new RegExp(`FUNCTION (public\\.)?${name}\\b`, 'i').test(statement)) {
            expect(statement.split(/\sTO\s/i)[1]).not.toMatch(/\b(anon|authenticated|PUBLIC)\b/i);
          }
        }
      }
    }
  });
});

describe('upgrade patch for existing multi-tenant databases', () => {
  const PATCH = fs.readFileSync(path.resolve(__dirname, '../../supabase/patches/2026-11-search-rpc-revoke-multi-tenant.sql'), 'utf8');
  const patchAcl = (name: string) =>
    statements(PATCH).filter((statement) => /^(GRANT|REVOKE)\b/i.test(statement) && new RegExp(`FUNCTION (public\\.)?${name}\\b`, 'i').test(statement));

  test.each(TENANT_ID_RPCS)('%s has the same REVOKE and GRANT as multi-tenant-setup.sql', (name) => {
    expect(patchAcl(name)).toEqual(aclFor(name));
  });

  test('the patch is documented as a post-deploy step in supabase/README.md', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../supabase/README.md'), 'utf8');
    expect(readme).toContain('2026-11-search-rpc-revoke-multi-tenant.sql');
    expect(PATCH).toMatch(/AFTER the Phase 2 application is deployed/);
  });
});

const REPO_ROOT = path.resolve(__dirname, '../..');
const readRepo = (relpath: string) => fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf8');

type Scenario = { label: string; files: string[]; strict: boolean };

function scenarios(): Scenario[] {
  const result: Scenario[] = [];
  for (const mode of ['multi-tenant', 'single-tenant'] as MigrationMode[]) {
    const setup = `supabase/${mode}-setup.sql`;
    const migrations = migrationFiles(mode);
    result.push({ label: `${mode}: folded setup file alone (fresh install)`, files: [setup], strict: true });
    result.push({ label: `${mode}: folded setup file then every migration (fixture and re-apply path)`, files: [setup, ...migrations], strict: true });
    result.push({ label: `${mode}: migrations only (an existing database that never re-runs the setup file)`, files: migrations, strict: false });
  }
  return result;
}

describe('every SECURITY DEFINER function is service_role only unless allow-listed', () => {
  test.each(scenarios().map((scenario) => [scenario.label, scenario] as const))('%s', (_label, scenario) => {
    const acls = simulateFunctionAcls(scenario.files.map(readRepo), { strictTargets: scenario.strict });
    const definers = [...acls.values()].filter((acl) => acl.definer);
    expect(definers.length).toBeGreaterThan(10);
    const violations = definers
      .map((acl) => aclViolation(acl, AUTHENTICATED_ALLOW_LIST[acl.name]))
      .filter((violation): violation is string => violation !== null);
    expect(violations).toEqual([]);
  });

  test('the allow-list names only functions that exist as SECURITY DEFINER in the SQL, each with a reason', () => {
    const names = new Set<string>();
    for (const scenario of scenarios()) {
      for (const acl of simulateFunctionAcls(scenario.files.map(readRepo), { strictTargets: false }).values()) {
        if (acl.definer) names.add(acl.name);
      }
    }
    for (const [name, entry] of Object.entries(AUTHENTICATED_ALLOW_LIST)) {
      expect(names.has(name), `${name} is allow-listed but no SQL defines it as SECURITY DEFINER`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  test('the four tenant search RPCs are never on the allow-list', () => {
    for (const name of TENANT_ID_RPCS) expect(AUTHENTICATED_ALLOW_LIST[name]).toBeUndefined();
  });
});
