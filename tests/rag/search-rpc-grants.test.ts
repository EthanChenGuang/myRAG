import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { migrationFiles, type MigrationMode } from '../../eval/harness/migrations.mts';
import { AUTHENTICATED_ALLOW_LIST, allowListEntryFor } from '../helpers/security-definer-allow-list';
import { aclViolation, signatureKey, simulateFunctionAcls } from '../helpers/sql-function-acl';

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
      .map((acl) => aclViolation(acl, allowListEntryFor(signatureKey(acl.name, acl.args))))
      .filter((violation): violation is string => violation !== null);
    expect(violations).toEqual([]);
  });

  test('the allow-list names only signatures that exist as SECURITY DEFINER in the SQL, each with a reason', () => {
    const signatures = new Set<string>();
    for (const scenario of scenarios()) {
      for (const acl of simulateFunctionAcls(scenario.files.map(readRepo), { strictTargets: false }).values()) {
        if (acl.definer) signatures.add(signatureKey(acl.name, acl.args));
      }
    }
    for (const [signature, entry] of Object.entries(AUTHENTICATED_ALLOW_LIST)) {
      expect(signatures.has(signature), `${signature} is allow-listed but no SQL defines it as SECURITY DEFINER`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  test('allow-list keys are normalised full signatures, name and argument types', () => {
    for (const key of Object.keys(AUTHENTICATED_ALLOW_LIST)) {
      expect(key).toMatch(/^[a-z0-9_]+\([a-z0-9_ \[\],]*\)$/);
      expect(key).not.toMatch(/,\s/);
    }
  });

  test('a CREATE OR REPLACE that a DO block first requires to exist keeps an ACL the files do not show', () => {
    const replaced = `
      DO $check$ BEGIN
        IF pg_catalog.to_regprocedure('public.legacy_definer(uuid)') IS NULL THEN RAISE EXCEPTION 'missing'; END IF;
      END $check$;
      CREATE OR REPLACE FUNCTION public.legacy_definer(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
      CREATE OR REPLACE FUNCTION public.unguarded_definer(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
    `;
    const acls = simulateFunctionAcls([replaced]);
    expect(acls.has('legacy_definer(uuid)')).toBe(false);
    expect([...(acls.get('unguarded_definer(uuid)')?.exec ?? [])]).toContain('PUBLIC');
  });

  test('a required signature that is dropped and created again is tracked as a new, fully exposed function', () => {
    const recreated = `
      DO $check$ BEGIN
        IF pg_catalog.to_regprocedure('public.legacy_definer(uuid)') IS NULL THEN RAISE EXCEPTION 'missing'; END IF;
        IF pg_catalog.to_regprocedure('public.other_definer(uuid)') IS NULL THEN RAISE EXCEPTION 'missing'; END IF;
      END $check$;
      DROP FUNCTION public.legacy_definer(uuid);
      CREATE FUNCTION public.legacy_definer(p uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
      DROP FUNCTION IF EXISTS public.other_definer(uuid);
      CREATE OR REPLACE FUNCTION public.other_definer(p uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
    `;
    const acls = simulateFunctionAcls([recreated]);
    expect([...(acls.get('legacy_definer(uuid)')?.exec ?? [])]).toContain('PUBLIC');
    expect([...(acls.get('other_definer(uuid)')?.exec ?? [])]).toContain('PUBLIC');
  });

  test('only CREATE OR REPLACE of a required signature keeps an unseen ACL; a plain CREATE is a new function', () => {
    const created = `
      DO $check$ BEGIN
        IF pg_catalog.to_regprocedure('public.legacy_definer(uuid)') IS NULL THEN RAISE EXCEPTION 'missing'; END IF;
      END $check$;
      CREATE FUNCTION public.legacy_definer(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
    `;
    expect([...(simulateFunctionAcls([created]).get('legacy_definer(uuid)')?.exec ?? [])]).toContain('PUBLIC');
  });

  test('a guard that raises when the function exists (IS NOT NULL, or NOT ... IS NULL) does not mark it as required', () => {
    const reversed = `
      DO $check$ BEGIN
        IF pg_catalog.to_regprocedure('public.brand_new(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'already there'; END IF;
        IF NOT (to_regprocedure('public.brand_new_two(uuid)') IS NULL) THEN RAISE EXCEPTION 'already there'; END IF;
      END $check$;
      CREATE OR REPLACE FUNCTION public.brand_new(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
      CREATE OR REPLACE FUNCTION public.brand_new_two(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
    `;
    const acls = simulateFunctionAcls([reversed]);
    expect([...(acls.get('brand_new(uuid)')?.exec ?? [])]).toContain('PUBLIC');
    expect([...(acls.get('brand_new_two(uuid)')?.exec ?? [])]).toContain('PUBLIC');
  });

  test('a list of signatures checked through unnest and to_regprocedure(s.sig) IS NULL, as 0425 does, is required', () => {
    const listed = `
      DO $check$ DECLARE v_missing text[]; BEGIN
        SELECT pg_catalog.array_agg(s.sig) INTO v_missing
        FROM pg_catalog.unnest(ARRAY['public.legacy_definer(uuid)', 'public.match_x(text,public.halfvec)']::text[]) AS s(sig)
        WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
        IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'missing: %', v_missing; END IF;
      END $check$;
      CREATE OR REPLACE FUNCTION public.legacy_definer(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
      CREATE OR REPLACE FUNCTION public.match_x(a text, b public.halfvec) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
    `;
    const acls = simulateFunctionAcls([listed]);
    expect(acls.has('legacy_definer(uuid)')).toBe(false);
    expect(acls.has('match_x(text,halfvec)')).toBe(false);
  });

  test('a new overload that shares an allow-listed name is not approved', () => {
    const overloads = `
      CREATE FUNCTION public.delete_folder(folder_uuid uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT true $$;
      CREATE FUNCTION public.is_org_member(org uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT true $$;
      CREATE FUNCTION public.check_admin_status(who uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT true $$;
      REVOKE ALL ON FUNCTION public.delete_folder(uuid), public.is_org_member(uuid), public.check_admin_status(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.delete_folder(uuid), public.is_org_member(uuid), public.check_admin_status(uuid) TO anon, authenticated, service_role;
    `;
    const acls = simulateFunctionAcls([SQL, overloads], { strictTargets: true });
    const violations = ['delete_folder(uuid)', 'is_org_member(uuid)', 'check_admin_status(uuid)'].map((key) => {
      const acl = acls.get(key);
      expect(acl, `${key} was not parsed`).toBeDefined();
      return aclViolation(acl as NonNullable<typeof acl>, allowListEntryFor(key));
    });
    expect(violations).toEqual([
      'delete_folder(uuid) is executable by anon',
      'is_org_member(uuid) is executable by anon',
      'check_admin_status(uuid) is executable by anon',
    ]);
  });

  test('the four tenant search RPCs are never on the allow-list', () => {
    for (const key of Object.keys(AUTHENTICATED_ALLOW_LIST)) expect(TENANT_ID_RPCS).not.toContain(key.split('(')[0]);
  });
});
