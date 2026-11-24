// Cross-language harness for the queued ingestion path (plan 03.1-22): one PGlite database behind the fake edge, the app's
// internal callback routes behind a local HTTP server, and the sidecar's one-shot runner launched as a real Python process.
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, fixtureProcessEnv, type FakeEdge } from './fake-edge.mts';
import { startIngestAppServer, type IngestAppServer, type IngestRouteHandler } from './ingest-app-server.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';
import { spawnSidecarModule, type SpawnSidecarResult } from './sidecar-worker.mts';
import { THREE_PAGES, startFakeLlamaParse, type FakeLlamaParse } from '../../tests/helpers/fake-llamaparse.ts';
import type { IngestFakes } from './ingest-fakes.mts';
import type { TenantScope } from '@/lib/rag/tenant/scope';

export const QUEUED_IDS = {
  userA: '00000000-0000-4000-8000-0000000000a1',
  userB: '00000000-0000-4000-8000-0000000000b1',
  orgB: '00000000-0000-4000-8000-0000000000c2',
} as const;

export const SIDECAR_SECRET = 'queued-harness-sidecar-secret-000000';

export interface QueuedHarness {
  db: PGlite;
  edge: FakeEdge;
  app: IngestAppServer;
  fakes: IngestFakes;
  llama: FakeLlamaParse;
  /** u:A, a personal tenant. */
  scopeA: TenantScope;
  /** o:B, an organization of another user. */
  scopeB: TenantScope;
  rows(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  runWorker(jobId: string, extraEnv?: Record<string, string>): Promise<SpawnSidecarResult>;
  close(): Promise<void>;
}

export interface QueuedHarnessOptions {
  deploymentMode?: DeploymentMode;
  /** Extra process environment applied before the app modules are imported. */
  env?: Record<string, string>;
}

/** A pdf-shaped byte string; the fake parsers answer by their own scripts, not by reading it. */
export function pdfBytes(label: string): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n`, 'utf8'));
}

export async function startQueuedHarness(options: QueuedHarnessOptions = {}): Promise<QueuedHarness> {
  const deploymentMode = options.deploymentMode ?? 'multi-tenant';
  const empty = await createEmptyFixtureDatabase({ deploymentMode });
  const { db } = empty;
  let edge: FakeEdge | undefined;
  let app: IngestAppServer | undefined;
  let llama: FakeLlamaParse | undefined;
  let fakes: IngestFakes | undefined;
  try {
    if (deploymentMode === 'multi-tenant') {
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
        QUEUED_IDS.userA,
        'tenant-a@example.invalid',
        QUEUED_IDS.userB,
        'tenant-b@example.invalid',
      ]);
      await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
        QUEUED_IDS.orgB,
        'Tenant B',
        'tenant-b',
        QUEUED_IDS.userB,
      ]);
      await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [QUEUED_IDS.orgB, QUEUED_IDS.userB]);
    }

    edge = await startFakeEdge({ db });
    llama = await startFakeLlamaParse();
    applyFixtureProcessEnv({
      edgeUrl: edge.url,
      deploymentMode,
      extra: {
        RAG_INGEST_PIPELINE: 'unified',
        RAG_INGEST_ASYNC: 'on',
        RAG_PARSE_ROUTING: 'fixed',
        RAG_PARSER: 'llamaparse',
        RAG_SIDECAR_SECRET: SIDECAR_SECRET,
        LLAMA_CLOUD_API_KEY: llama.apiKey,
        ...options.env,
      },
    });

    const { fixtureAdminClient, installIngestFakes, INGEST_MODE_ENV } = await import('./ingest-fakes.mts');
    fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: { ...INGEST_MODE_ENV, RAG_INGEST_PIPELINE: 'unified' } });

    const { createLlamaParseParser, setLlamaParseParserForTests } = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
    setLlamaParseParserForTests(createLlamaParseParser({ baseUrl: llama.url, apiKey: llama.apiKey, tier: 'cost_effective', sleep: async () => undefined }));
    const { setTierBoundsDepsForTests } = await import('@/lib/rag/ingest/routing/tier-bounds');
    setTierBoundsDepsForTests({ admin: () => null });
    llama.enqueue({ pages: THREE_PAGES });

    const parseExternal = (await import('@/app/api/internal/rag/ingest/jobs/[id]/parse-external/route')) as { POST: IngestRouteHandler };
    const advance = (await import('@/app/api/internal/rag/ingest/jobs/[id]/advance/route')) as { POST: IngestRouteHandler };
    app = await startIngestAppServer({ 'parse-external': parseExternal.POST, advance: advance.POST });

    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const scopeA = deploymentMode === 'multi-tenant' ? mintScope('personal', QUEUED_IDS.userA, null) : mintScope('single', null, null);
    const scopeB = deploymentMode === 'multi-tenant' ? mintScope('org', QUEUED_IDS.userB, QUEUED_IDS.orgB) : scopeA;

    const serviceKey = fixtureProcessEnv(edge.url).SUPABASE_SERVICE_ROLE_KEY as string;
    const startedEdge = edge;
    const startedApp = app;
    const startedFakes = fakes;
    const startedLlama = llama;
    return {
      db,
      edge: startedEdge,
      app: startedApp,
      fakes: startedFakes,
      llama: startedLlama,
      scopeA,
      scopeB,
      async rows(sql, params = []) {
        return (await db.query<Record<string, unknown>>(sql, params)).rows;
      },
      runWorker(jobId, extraEnv = {}) {
        return spawnSidecarModule(
          'rag_sidecar.ingest.run_once',
          ['--job', jobId],
          {
            NEXT_PUBLIC_SUPABASE_URL: startedEdge.url,
            SUPABASE_SERVICE_ROLE_KEY: serviceKey,
            RAG_APP_INTERNAL_URL: startedApp.url,
            RAG_SIDECAR_SECRET: SIDECAR_SECRET,
            UV_OFFLINE: '1',
            UV_FROZEN: '1',
            ...extraEnv,
          },
          { timeoutMs: 180_000 },
        ).done;
      },
      async close() {
        await startedFakes.uninstall();
        const { resetLlamaParseParserForTests } = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
        resetLlamaParseParserForTests();
        const { resetTierBoundsDepsForTests } = await import('@/lib/rag/ingest/routing/tier-bounds');
        resetTierBoundsDepsForTests();
        await startedApp.close();
        await startedLlama.close();
        await startedEdge.close();
        await db.close();
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await fakes?.uninstall().catch(() => undefined);
    await llama?.close().catch(() => undefined);
    await edge?.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    throw error;
  }
}
