import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';

export type MigrationMode = 'single-tenant' | 'multi-tenant';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_RELDIR = 'supabase/migrations';
const MIGRATION_FILE = /^(\d{4}_[a-z0-9_]+)(?:\.(single-tenant|multi-tenant))?\.sql$/;

/**
 * Migrations apply in the order of their name without the mode suffix; a common file runs before its
 * mode-specific variant. scripts/setup-database.sh --list-migrations prints the same order.
 */
export function migrationFiles(mode: MigrationMode): string[] {
  const entries: { stem: string; rank: number; relpath: string }[] = [];
  for (const name of fs.readdirSync(path.join(REPO_ROOT, MIGRATIONS_RELDIR))) {
    if (!name.endsWith('.sql')) continue;
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new Error(`[Migrations] unexpected file name: ${name}`);
    const variant = match[2];
    if (variant !== undefined && variant !== mode) continue;
    entries.push({ stem: match[1] as string, rank: variant === undefined ? 0 : 1, relpath: `${MIGRATIONS_RELDIR}/${name}` });
  }
  entries.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : a.rank - b.rank));
  return entries.map((entry) => entry.relpath);
}

export async function applyMigrationFiles(db: PGlite, files: string[]): Promise<void> {
  for (const relpath of files) {
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf8'));
  }
}

export async function applyMigrations(db: PGlite, mode: MigrationMode): Promise<void> {
  await applyMigrationFiles(db, migrationFiles(mode));
}
