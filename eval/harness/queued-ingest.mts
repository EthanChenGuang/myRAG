// Cross-language harness for the queued ingestion path (plan 03.1-22): one PGlite database behind the fake edge, the app's
// internal callback routes behind a local HTTP server, and the sidecar's one-shot runner launched as a real Python process.
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, fixtureProcessEnv, type FakeEdge } from './fake-edge.mts';
import { startIngestAppServer, type IngestAppServer, type IngestRouteHandler } from './ingest-app-server.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';
import { spawnSidecarModule, type SpawnSidecarResult } from './sidecar-worker.mts';
import { THREE_PAGES, startFakeLlamaParse, type FakeLlamaJobSpec, type FakeLlamaParse } from '../../tests/helpers/fake-llamaparse.ts';
import type { IngestFakes } from './ingest-fakes.mts';
import type { TenantScope } from '@/lib/rag/tenant/scope';

export const QUEUED_IDS = {
  userA: '00000000-0000-4000-8000-0000000000a1',
  userB: '00000000-0000-4000-8000-0000000000b1',
  orgB: '00000000-0000-4000-8000-0000000000c2',
} as const;

export const SIDECAR_SECRET = 'queued-harness-sidecar-secret-000000';

export interface CallbackReply {
  status: number;
  body: Record<string, unknown>;
}

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
  /** Claims one job for a worker id the way the one-shot runner does, so a test can play the worker itself. */
  claim(jobId: string, worker: string): Promise<void>;
  /** Extends the lease like the worker's heartbeat does, so a slow run under load keeps its job. */
  heartbeat(jobId: string, worker: string): Promise<void>;
  /** Runs `work` while a background heartbeat keeps the lease of the job alive, as the worker's per-job heartbeat task does. */
  withHeartbeat<T>(jobId: string, worker: string, work: () => Promise<T>): Promise<T>;
  /** Posts to an internal callback route with the right secret unless `headers` says otherwise (a header set to null is left out). */
  callback(jobId: string, action: 'parse-external' | 'advance', body: unknown, headers?: Record<string, string | null>): Promise<CallbackReply>;
  runWorker(jobId: string, extraEnv?: Record<string, string>): Promise<SpawnSidecarResult>;
  close(): Promise<void>;
}

export interface QueuedHarnessOptions {
  deploymentMode?: DeploymentMode;
  /** Extra process environment applied before the app modules are imported. */
  env?: Record<string, string>;
  /** Job specs of the fake LlamaParse, one per upload (the last repeats). Default: three plain pages. */
  llamaSpecs?: FakeLlamaJobSpec[];
  /** Sleep of the LlamaParse client between polls. Default: none. */
  llamaSleep?: (ms: number) => Promise<void>;
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
    setLlamaParseParserForTests(createLlamaParseParser({ baseUrl: llama.url, apiKey: llama.apiKey, tier: 'cost_effective', sleep: async (ms) => options.llamaSleep?.(ms) }));
    const { setTierBoundsDepsForTests } = await import('@/lib/rag/ingest/routing/tier-bounds');
    setTierBoundsDepsForTests({ admin: () => null });
    llama.enqueue(...(options.llamaSpecs ?? [{ pages: THREE_PAGES }]));

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
      async claim(jobId, worker) {
        const rows = (await db.query<{ id: string | null }>('SELECT id FROM rag_claim_ingestion_job($1, $2)', [jobId, worker])).rows;
        if (rows[0]?.id !== jobId) throw new Error(`[Queued Harness] job ${jobId} could not be claimed`);
      },
      async heartbeat(jobId, worker) {
        await db.query('SELECT rag_heartbeat_ingestion_job($1, $2)', [jobId, worker]);
      },
      async withHeartbeat(jobId, worker, work) {
        const beat = setInterval(() => {
          db.query('SELECT rag_heartbeat_ingestion_job($1, $2)', [jobId, worker]).catch(() => undefined);
        }, 4000);
        try {
          return await work();
        } finally {
          clearInterval(beat);
        }
      },
      async callback(jobId, action, body, headers = {}) {
        const merged: Record<string, string | null> = { 'content-type': 'application/json', 'x-sidecar-secret': SIDECAR_SECRET, ...headers };
        const outgoing: Record<string, string> = {};
        for (const [name, value] of Object.entries(merged)) if (value !== null) outgoing[name] = value;
        const response = await fetch(`${startedApp.url}/api/internal/rag/ingest/jobs/${jobId}/${action}`, {
          method: 'POST',
          headers: outgoing,
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { raw: text };
        }
        return { status: response.status, body: parsed };
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

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface ChunkFingerprint {
  doc: Record<string, unknown>;
  chunks: Array<Record<string, unknown>>;
}

/**
 * What two runs of the same upload must agree on: the chunk content and hashes, the section paths, the page numbers, the kind, the
 * metadata (with every UUID masked) and the parser fields. Chunk ids, timestamps and the tenant are left out; `embeddings` adds the vectors.
 */
export async function chunkFingerprint(harness: QueuedHarness, documentId: string, options: { embeddings?: boolean } = {}): Promise<ChunkFingerprint> {
  const [doc] = await harness.rows(
    'SELECT parser_used, parser_version, doc_type, doc_type_origin, content_hash, status, is_current FROM documents WHERE id = $1',
    [documentId],
  );
  const rows = await harness.rows(
    `SELECT chunk_index, content, content_hash, section_path, page_start, page_end, chunk_kind, metadata${options.embeddings ? ', embedding::text AS embedding' : ''}
       FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId],
  );
  return {
    doc: doc ?? {},
    chunks: rows.map((row) => ({
      chunk_index: row.chunk_index,
      content: row.content,
      content_hash: row.content_hash,
      section_path: row.section_path,
      page_start: row.page_start,
      page_end: row.page_end,
      chunk_kind: row.chunk_kind,
      metadata: JSON.parse(JSON.stringify(row.metadata ?? {}).replace(UUID_IN_TEXT, '<uuid>')) as unknown,
      ...(options.embeddings ? { embedding: row.embedding } : {}),
    })),
  };
}
