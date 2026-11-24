import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadCorpus } from './corpus.mts';
import { startFakeEdge, type FakeEdge } from './fake-edge.mts';
import { createEmptyFixtureDatabase, type DeploymentMode, type FixtureDatabase } from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';

/** Repo-relative golden files the ingest mode scores; ingest-only items are added here. */
export function ingestModeGoldenPaths(): string[] {
  return ['eval/fixtures/golden.jsonl'];
}

/** One golden file to score: a single path is returned as it is, several are concatenated in order into `outPath`. */
export function mergeGoldenFiles(paths: string[], outPath: string): string {
  const [first, ...rest] = paths;
  if (first === undefined) throw new Error('[Ingest Mode] no golden file to merge');
  if (rest.length === 0) return first;
  const lines = paths.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== ''));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
  return outPath;
}

/**
 * The corpus hash of an ingest-mode run. The chunks differ from the prechunked ones, so a run must not be gated against the
 * prechunked baseline: the gate compares this value and refuses the pair.
 */
function ingestCorpusSha256(corpusSha256: string): string {
  return crypto.createHash('sha256').update('fixture-mode:ingest').update(Buffer.from([0])).update(corpusSha256).digest('hex');
}

/**
 * The fixture database filled by the real ingest(): every corpus document, with the chunk markers and the fixture-meta line already
 * removed by the corpus loader, goes through the stages as a picked-general config upload of the fixture tenant. The fake edge it
 * ingests through stays up and is handed to the caller together with the database; the app environment points at it.
 */
export async function buildIngestFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  processEnv?: Record<string, string>;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
}): Promise<FixtureDatabase> {
  const { deploymentMode } = options;
  const corpus = loadCorpus(options.corpusDir);
  const empty = await createEmptyFixtureDatabase(options);
  let edge: FakeEdge | undefined;
  let uninstall: (() => Promise<void>) | undefined;
  try {
    edge = await startFakeEdge({ db: empty.db });
    applyFixtureProcessEnv({ edgeUrl: edge.url, deploymentMode, extra: options.processEnv });

    const { fixtureAdminClient, installIngestFakes } = await import('./ingest-fakes.mts');
    const { ingest } = await import('@/lib/rag/ingest');
    const { buildSourceKey } = await import('@/lib/rag/ingest/identity');
    const { mintScope } = await import('@/lib/rag/tenant/scope');

    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url) });
    uninstall = fakes.uninstall;

    const scope = deploymentMode === 'multi-tenant' ? mintScope('personal', empty.fixtureUserId, null) : mintScope('single', null, null);
    for (const doc of corpus.documents) {
      const result = await ingest({
        scope,
        source: 'config_upload',
        sourceKey: buildSourceKey('config_upload', { filename: doc.filename }),
        text: doc.content,
        filename: doc.filename,
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      if (result.status !== 'ready') {
        throw new Error(`[Ingest Mode] ${doc.relpath} ended ${result.status} (${result.reason ?? 'no reason'}; warnings: ${result.warnings.join(', ') || 'none'})`);
      }
    }
    if (edge.errors.length > 0) {
      const sample = edge.errors
        .slice(0, 3)
        .map((error) => `${error.method} ${error.url} -> ${error.status}`)
        .join('; ');
      throw new Error(`[Ingest Mode] the fake edge refused ${edge.errors.length} request(s) while ingesting: ${sample}`);
    }
  } catch (error) {
    await edge?.close().catch(() => undefined);
    await empty.db.close().catch(() => undefined);
    throw error;
  } finally {
    await uninstall?.();
  }

  return { ...empty, corpusSha256: ingestCorpusSha256(corpus.corpusSha256), edge };
}
