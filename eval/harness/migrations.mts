import type { PGlite } from '@electric-sql/pglite';

export type MigrationMode = 'single-tenant' | 'multi-tenant';

export function migrationFiles(_mode: MigrationMode): string[] {
  return [];
}

export async function applyMigrationFiles(_db: PGlite, _files: string[]): Promise<void> {}

export async function applyMigrations(_db: PGlite, _mode: MigrationMode): Promise<void> {}
