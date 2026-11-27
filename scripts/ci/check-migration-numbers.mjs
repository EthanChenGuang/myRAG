import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Train 40: two branches must never ship different migrations under one number. A common file and its .single-tenant /
// .multi-tenant mode files are one migration. Shipped collisions that predate this check are listed once in KNOWN_SHARED and may
// not grow; a new file that joins one of them still fails.

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = 'supabase/migrations';
const FILE_RE = /^(\d{4})_([a-z0-9_]+?)(?:\.(?:single|multi)-tenant)?\.sql$/;

/** Already shipped before this check; renaming a shipped migration is not allowed. */
export const KNOWN_SHARED = new Map([['0316', ['quarantine_access', 'quarantine_admin']]]);

export function migrationNumberProblems(fileNames, knownShared = KNOWN_SHARED) {
  const problems = [];
  const byNumber = new Map();
  for (const name of fileNames) {
    if (!name.endsWith('.sql')) continue;
    const match = FILE_RE.exec(name);
    if (!match) {
      problems.push(`${name}: name must be NNNN_slug.sql, optionally with .single-tenant or .multi-tenant before .sql`);
      continue;
    }
    const [, number, slug] = match;
    if (!byNumber.has(number)) byNumber.set(number, new Set());
    byNumber.get(number).add(slug);
  }
  for (const [number, slugs] of [...byNumber.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (slugs.size < 2) continue;
    const allowed = knownShared.get(number);
    const sorted = [...slugs].sort();
    if (allowed && sorted.length === allowed.length && sorted.every((slug, i) => slug === [...allowed].sort()[i])) continue;
    problems.push(`${number}: shared by ${sorted.map((slug) => `${number}_${slug}`).join(', ')}; give each migration its own number`);
  }
  return problems;
}

export function checkMigrationNumbers(root = DEFAULT_ROOT) {
  const dir = path.join(root, MIGRATIONS_DIR);
  return migrationNumberProblems(fs.readdirSync(dir));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkMigrationNumbers();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[check-migration-numbers] ${problem}`);
    console.error(`[check-migration-numbers] ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('[check-migration-numbers] ok: every migration number is used by one migration');
}
