import { splitStatements } from './sql-function-acl';

export interface DefinerSearchPathFinding {
  file: string;
  name: string;
}

function skeleton(statement: string): string {
  return statement
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, ' ')
    .trim();
}

const CREATE_FUNCTION = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)\s*\(/i;
const FIXED_SEARCH_PATH = /\bSET\s+search_path\s*(?:=|TO)\s*\S+/i;

/** SECURITY DEFINER functions whose CREATE statement carries no `SET search_path = ...` (Supabase linter 0011). */
export function definersWithoutSearchPath(files: { file: string; sql: string }[]): { total: number; missing: DefinerSearchPathFinding[] } {
  let total = 0;
  const missing: DefinerSearchPathFinding[] = [];
  for (const { file, sql } of files) {
    for (const statement of splitStatements(sql)) {
      const flat = skeleton(statement);
      const create = CREATE_FUNCTION.exec(flat);
      if (!create || !/\bSECURITY\s+DEFINER\b/i.test(flat)) continue;
      total += 1;
      if (!FIXED_SEARCH_PATH.test(flat)) missing.push({ file, name: (create[1] as string).replace(/"/g, '').replace(/^public\./i, '') });
    }
  }
  return { total, missing };
}

/** Files whose DO blocks create a SECURITY DEFINER function; the scanner above cannot see those, so they must not exist. */
export function filesWithNestedDefinerCreate(files: { file: string; sql: string }[]): string[] {
  const found: string[] = [];
  for (const { file, sql } of files) {
    for (const statement of splitStatements(sql)) {
      if (!/^DO\b/i.test(statement)) continue;
      if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*SECURITY\s+DEFINER/i.test(statement)) found.push(file);
    }
  }
  return found;
}
