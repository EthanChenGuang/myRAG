import type { PGlite } from '@electric-sql/pglite';

export interface FakeEdge {
  url: string;
  errors: Array<{ method: string; url: string; status: number; message: string }>;
  calls: Array<{ method: string; path: string; model?: string }>;
  close(): Promise<void>;
}

export async function startFakeEdge(_options: { db: PGlite }): Promise<FakeEdge> {
  throw new Error('not implemented');
}

export function fixtureProcessEnv(_edgeUrl: string): Record<string, string> {
  throw new Error('not implemented');
}
