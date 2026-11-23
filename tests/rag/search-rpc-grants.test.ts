import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

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

  test('every SECURITY DEFINER function taking a tenant id argument and returning chunks or documents is in the locked list', () => {
    const functions = SQL.split(/CREATE OR REPLACE FUNCTION/i).slice(1);
    const exposed = functions
      .filter((body) => /SECURITY DEFINER/i.test(body.split(/\$\$|\$function\$/)[0] ?? body))
      .filter((body) => /\bp_(org_id|user_id)\b/.test(body.split(/RETURNS/i)[0] ?? ''))
      .filter((body) => /RETURNS TABLE/i.test(body.slice(0, 900)))
      .map((body) => /^\s*(?:public\.)?([a-z_]+)/i.exec(body)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(exposed.sort()).toEqual([...TENANT_ID_RPCS].sort());
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
