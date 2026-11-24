export type AclRole = 'PUBLIC' | 'anon' | 'authenticated' | 'service_role';

export interface FunctionAcl {
  name: string;
  args: string[];
  definer: boolean;
  /** Roles holding EXECUTE after the statements run. A new function starts with every role, as on Supabase (default privileges plus PUBLIC). */
  exec: Set<AclRole>;
  /** True when a guarded DO block (not a bare statement) changed this function's ACL. */
  guarded: boolean;
}

const ALL_ROLES: AclRole[] = ['PUBLIC', 'anon', 'authenticated', 'service_role'];

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  bool: 'boolean',
  float8: 'double precision',
  timestamptz: 'timestamp with time zone',
};

/** Splits SQL into top-level statements, ignoring `;` inside comments, quotes and dollar-quoted bodies. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === ';') {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/** The statement with string literals and dollar-quoted bodies removed, so header keywords can be matched safely. */
function skeleton(statement: string): string {
  return statement
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, ' ')
    .trim();
}

function balancedParen(text: string, openIndex: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(openIndex + 1, i), end: i };
    }
  }
  throw new Error(`[sql-function-acl] unbalanced parenthesis in: ${text.slice(0, 120)}`);
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function normalizeType(raw: string): string {
  const type = raw
    .toLowerCase()
    .replace(/"/g, '')
    .replace(/\bpublic\./g, '')
    .replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const isArray = type.endsWith('[]');
  const base = isArray ? type.slice(0, -2).trim() : type;
  const mapped = TYPE_ALIASES[base] ?? base;
  return isArray ? `${mapped}[]` : mapped;
}

/** Argument types of a CREATE FUNCTION list: drops modes, names, defaults and OUT parameters. */
function createArgTypes(list: string): string[] {
  const types: string[] = [];
  for (const item of splitTopLevel(list, ',')) {
    let text = item.replace(/\s+(DEFAULT\b|=).*$/is, '').trim();
    if (text === '') continue;
    if (/^OUT\b/i.test(text)) continue;
    text = text.replace(/^(INOUT|IN|VARIADIC)\s+/i, '');
    const tokens = text.split(/\s+/);
    types.push(normalizeType(tokens.length > 1 ? tokens.slice(1).join(' ') : tokens[0] as string));
  }
  return types;
}

function aclArgTypes(list: string): string[] {
  return splitTopLevel(list, ',').map((item) => normalizeType(item.replace(/^(INOUT|IN|VARIADIC)\s+/i, '')));
}

function bareName(raw: string): string {
  return raw.replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
}

export function signatureKey(name: string, args: string[]): string {
  return `${name}(${args.join(',')})`;
}

interface FunctionRef {
  name: string;
  args: string[];
}

function parseFunctionRefs(list: string): FunctionRef[] {
  const refs: FunctionRef[] = [];
  for (const item of splitTopLevel(list, ',')) {
    const open = item.indexOf('(');
    if (open === -1) throw new Error(`[sql-function-acl] function reference without an argument list: ${item}`);
    refs.push({ name: bareName(item.slice(0, open).trim()), args: aclArgTypes(balancedParen(item, open).inner) });
  }
  return refs;
}

function parseRoles(text: string): AclRole[] {
  const roles: AclRole[] = [];
  for (const raw of text.replace(/\bWITH\s+GRANT\s+OPTION\b/i, '').replace(/\bCASCADE\b/i, '').split(',')) {
    const role = raw.trim().replace(/"/g, '');
    if (role === '') continue;
    if (/^public$/i.test(role)) roles.push('PUBLIC');
    else if (role === 'anon' || role === 'authenticated' || role === 'service_role') roles.push(role);
  }
  return roles;
}

const ACL_STATEMENT =
  /^(GRANT|REVOKE)\s+(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+(ALL\s+FUNCTIONS\s+IN\s+SCHEMA|FUNCTION)\s+([\s\S]+?)\s+(TO|FROM)\s+([\s\S]+)$/i;

export interface SimulationOptions {
  /** A GRANT or REVOKE outside a guarded DO block naming a function that was never created throws. */
  strictTargets?: boolean;
}

/**
 * Replays CREATE/DROP FUNCTION, GRANT and REVOKE statements in order and returns the final EXECUTE
 * privileges per function signature. CREATE OR REPLACE keeps the existing ACL (as PostgreSQL does);
 * a function the files never created is treated as new, i.e. fully exposed, which is how an upgraded
 * database that only runs the migrations sees a function a migration replaces.
 */
export function simulateFunctionAcls(files: string[], options: SimulationOptions = {}): Map<string, FunctionAcl> {
  const functions = new Map<string, FunctionAcl>();

  const applyAcl = (statement: string, guarded: boolean): void => {
    const match = ACL_STATEMENT.exec(statement.replace(/\s+/g, ' ').trim());
    if (!match) return;
    const [, verb, target, list, , roleText] = match as unknown as [string, string, string, string, string, string];
    if (/ALL\s+FUNCTIONS/i.test(target)) throw new Error(`[sql-function-acl] ALL FUNCTIONS IN SCHEMA is not modelled: ${statement.slice(0, 120)}`);
    const granting = verb.toUpperCase() === 'GRANT';
    const roles = parseRoles(roleText);
    for (const ref of parseFunctionRefs(list)) {
      const key = signatureKey(ref.name, ref.args);
      const acl = functions.get(key);
      if (!acl) {
        if (options.strictTargets && !guarded) throw new Error(`[sql-function-acl] ${verb} targets a function never created: ${key}`);
        continue;
      }
      if (guarded) acl.guarded = true;
      for (const role of roles) {
        if (granting) acl.exec.add(role);
        else acl.exec.delete(role);
      }
    }
  };

  for (const sql of files) {
    for (const statement of splitStatements(sql)) {
      const flat = skeleton(statement);
      const create = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)\s*\(/i.exec(flat);
      if (create) {
        const open = flat.indexOf('(', create[0].length - 1);
        const { inner } = balancedParen(flat, open);
        const name = bareName(create[1] as string);
        const args = createArgTypes(inner);
        const definer = /\bSECURITY\s+DEFINER\b/i.test(flat);
        const key = signatureKey(name, args);
        const existing = functions.get(key);
        if (existing) existing.definer = definer;
        else functions.set(key, { name, args, definer, exec: new Set(ALL_ROLES), guarded: false });
        continue;
      }
      const drop = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i.exec(flat);
      if (drop) {
        for (const ref of parseFunctionRefs(drop[1] as string)) functions.delete(signatureKey(ref.name, ref.args));
        continue;
      }
      if (/^(GRANT|REVOKE)\b/i.test(flat)) {
        applyAcl(flat, false);
        continue;
      }
      if (/^DO\b/i.test(flat)) {
        for (const inner of statement.match(/\b(?:GRANT|REVOKE)\s+(?:EXECUTE|ALL)[^;]*/gi) ?? []) applyAcl(inner, true);
      }
    }
  }
  return functions;
}

export function canExecute(acl: FunctionAcl, role: Exclude<AclRole, 'PUBLIC'>): boolean {
  return acl.exec.has('PUBLIC') || acl.exec.has(role);
}

export interface AllowListEntry {
  /** Whether anon keeps EXECUTE. Authenticated always does for an allow-listed function. */
  anon: boolean;
  reason: string;
}

/** Returns a violation message, or null when the function's ACL is acceptable. */
export function aclViolation(acl: FunctionAcl, allow: AllowListEntry | undefined): string | null {
  const label = signatureKey(acl.name, acl.args);
  if (acl.exec.has('PUBLIC')) return `${label} is executable by PUBLIC`;
  if (!acl.exec.has('service_role')) return `${label} is not granted to service_role`;
  if (!allow) {
    if (acl.exec.has('anon')) return `${label} is executable by anon`;
    if (acl.exec.has('authenticated')) return `${label} is executable by authenticated and is not on the allow-list`;
    return null;
  }
  if (!acl.exec.has('authenticated')) return `${label} is on the allow-list but authenticated cannot execute it`;
  if (acl.exec.has('anon') !== allow.anon) return `${label} anon EXECUTE is ${acl.exec.has('anon')} but the allow-list says ${allow.anon}`;
  return null;
}
