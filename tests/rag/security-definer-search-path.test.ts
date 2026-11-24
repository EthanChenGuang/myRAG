import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { definersWithoutSearchPath, filesWithNestedDefinerCreate } from '../helpers/sql-function-search-path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function sqlFiles(): { file: string; sql: string }[] {
  const relpaths = ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql'];
  for (const dir of ['supabase/migrations', 'supabase/patches']) {
    for (const name of fs.readdirSync(path.join(REPO_ROOT, dir)).sort()) {
      if (name.endsWith('.sql')) relpaths.push(`${dir}/${name}`);
    }
  }
  return relpaths.map((file) => ({ file, sql: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
}

const MIGRATION = 'supabase/migrations/0411_security_definer_search_path.sql';

const FORMERLY_UNFIXED = [
  'can_view_org_member(uuid, uuid)',
  'check_admin_status()',
  'delete_folder(uuid, boolean)',
  'get_admin_organization_id()',
  'get_folder_stats(uuid)',
  'get_user_current_org()',
  'get_user_org_ids(uuid)',
  'get_user_role_in_org(uuid)',
  'is_admin(uuid)',
  'move_chats_to_folder(uuid[], uuid)',
  'share_chat(uuid, jsonb)',
  'share_personal_organization(uuid)',
  'unshare_chat(uuid)',
];

describe('the search_path scanner', () => {
  test('flags a SECURITY DEFINER function without SET search_path and accepts the three forms the repo uses', () => {
    const sql = (tail: string) => `CREATE OR REPLACE FUNCTION public.f(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER ${tail} AS $$ SELECT 1 $$;`;
    const result = definersWithoutSearchPath([
      { file: 'bad.sql', sql: sql('') },
      { file: 'a.sql', sql: sql('SET search_path = pg_catalog, public') },
      { file: 'b.sql', sql: sql("SET search_path = 'public', 'pg_temp'") },
      { file: 'c.sql', sql: sql("SET search_path TO ''") },
      { file: 'invoker.sql', sql: 'CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' },
    ]);
    expect(result.total).toBe(4);
    expect(result.missing).toEqual([{ file: 'bad.sql', name: 'f' }]);
  });

  test('a SET search_path that appears only inside the function body does not count', () => {
    const sql = "CREATE FUNCTION h() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN SET search_path = public; END $$;";
    expect(definersWithoutSearchPath([{ file: 'body.sql', sql }]).missing).toHaveLength(1);
  });
});

describe('every SECURITY DEFINER function has a fixed search_path', () => {
  test('no CREATE FUNCTION in the setup files, migrations or patches is SECURITY DEFINER without SET search_path', () => {
    const { total, missing } = definersWithoutSearchPath(sqlFiles());
    expect(total).toBeGreaterThan(100);
    expect(missing.map((entry) => `${entry.file}: ${entry.name}`)).toEqual([]);
  });

  test('no DO block creates a SECURITY DEFINER function, where the scanner could not see it', () => {
    expect(filesWithNestedDefinerCreate(sqlFiles())).toEqual([]);
  });
});

describe('0411 repairs databases that already have the 13 functions without a search_path', () => {
  const sql = fs.existsSync(path.join(REPO_ROOT, MIGRATION)) ? fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8') : '';

  test('the migration exists', () => {
    expect(sql).not.toBe('');
  });

  test.each(FORMERLY_UNFIXED)('%s is altered inside a to_regprocedure guard', (signature) => {
    const alter = new RegExp(
      `IF to_regprocedure\\('public\\.${signature.replace(/[()[\]]/g, '\\$&')}'\\) IS NOT NULL THEN\\s+ALTER FUNCTION public\\.${signature.replace(/[()[\]]/g, '\\$&')} SET search_path = pg_catalog, public;`,
    );
    expect(sql).toMatch(alter);
  });

  test('every ALTER FUNCTION sits behind a guard and the migration changes nothing but search_path', () => {
    expect((sql.match(/ALTER FUNCTION/g) ?? []).length).toBe(FORMERLY_UNFIXED.length);
    expect((sql.match(/to_regprocedure\(/g) ?? []).length).toBe(FORMERLY_UNFIXED.length);
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|\bGRANT\s|\bREVOKE\s/i);
  });
});
