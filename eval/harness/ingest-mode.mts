import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './corpus.mts';
import { startFakeEdge } from './fake-edge.mts';
import { createEmptyFixtureDatabase, type DeploymentMode, type FixtureDatabase } from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function ingestModeGoldenPaths(): string[] {
  return ['eval/fixtures/golden.jsonl'];
}

export function mergeGoldenFiles(paths: string[], _outPath: string): string {
  return paths[0] as string;
}

export async function buildIngestFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
}): Promise<FixtureDatabase> {
  const corpus = loadCorpus(options.corpusDir);
  const empty = await createEmptyFixtureDatabase(options);
  const edge = await startFakeEdge({ db: empty.db });
  applyFixtureProcessEnv({ edgeUrl: edge.url, deploymentMode: options.deploymentMode });
  void fs;
  void REPO_ROOT;
  return { ...empty, corpusSha256: corpus.corpusSha256, edge };
}
