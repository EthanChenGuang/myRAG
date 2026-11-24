import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getIngestDeps } from '@/lib/rag/ingest/deps';
import { INGEST_STAGES, runIngestStages } from '@/lib/rag/ingest/runner';
import { createLedgerStateStore } from '@/lib/rag/ingest/state-store';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { emptyIngestState, type IngestResult, type StageContext, type StageName, type StageSpec } from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_DOCUMENT_ID, FAKE_LINEAGE_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';

const scope = mintScope('single', null, null);
const JOB_ID = '10000000-0000-4000-8000-000000000001';
const WORKER = 'worker-under-test';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

function jobRow(stage: string, status: string): Record<string, unknown> {
  return {
    id: JOB_ID,
    kind: 'ingest',
    status,
    stage,
    tenant_key: 's:default',
    source: 'config_upload',
    source_key: 'doc.md',
    settings: buildJobSettings({
      queueConfig: loadQueueConfig({}),
      profile: getProcessingProfile('general'),
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig: loadRoutingConfig(),
    }),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function ledgerDb(): { db: RpcClient; advances: Array<Record<string, unknown>>; others: string[] } {
  const advances: Array<Record<string, unknown>> = [];
  const others: string[] = [];
  const db: RpcClient = {
    rpc(fn, args) {
      if (fn === 'rag_advance_ingestion_job') advances.push(args);
      else others.push(fn);
      const response: RpcResponse = {
        data: fn === 'rag_advance_ingestion_job' ? [jobRow(String(args.p_stage), String(args.p_status))] : [],
        error: null,
      };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { db, advances, others };
}

function makeCtx(store: StageContext['store'] | undefined, now: () => number): StageContext {
  const deps = getIngestDeps();
  const signal = new AbortController().signal;
  const db = deps.db();
  if (!db) throw new Error('fake db missing');
  return {
    input: { scope, source: 'config_upload', sourceKey: 'root/doc.md', text: 'x', filename: 'doc.md', mimeType: 'text/markdown', signal },
    deps,
    writer: createIngestWriter({ db, scope, signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal,
    deadline: now() + 50_000,
    state: emptyIngestState(),
    ...(store ? { store } : {}),
    warnings: [],
    identity: null,
    document: { id: FAKE_DOCUMENT_ID, version: 1, lineageId: FAKE_LINEAGE_ID, resumed: false },
    parserUsed: null,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  };
}

function stagesAfter(first: StageName, clock: { t: number }, stepMs: number): StageSpec[] {
  const from = INGEST_STAGES.indexOf(first);
  return INGEST_STAGES.slice(from).map((name) => ({
    name,
    minMsNeeded: 0,
    async run() {
      clock.t += stepMs;
      if (name === 'publish') {
        const result: IngestResult = { status: 'ready', documentId: FAKE_DOCUMENT_ID, version: 1, parserUsed: null, chunkCount: 0, warnings: [] };
        return { kind: 'done' as const, result };
      }
      return { kind: 'next' as const };
    },
  }));
}

describe('state store: the ledger is the only state authority of a queued run', () => {
  test('without a store the state goes to the document row, as before', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });
    const clock = { t: 1_000 };
    const ctx = makeCtx(undefined, () => clock.t);
    await runIngestStages(ctx, stagesAfter('content_hash_dedup', clock, 5));
    expect(callsOf(calls, 'rag_save_ingest_state').length).toBeGreaterThan(0);
  });

  test('a ledger store writes stage, status, cursor and per-stage timing through advance and never the document row', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });
    const clock = { t: 1_000 };
    const ledger = ledgerDb();
    const store = createLedgerStateStore({
      jobId: JOB_ID,
      worker: WORKER,
      signal: new AbortController().signal,
      now: () => clock.t,
      ledgerDeps: { db: () => ledger.db },
    });
    const ctx = makeCtx(store, () => clock.t);
    ctx.state.lastCompleted = 'parse';

    const result = await runIngestStages(ctx, stagesAfter('content_hash_dedup', clock, 7));

    expect(result.status).toBe('ready');
    expect(callsOf(calls, 'rag_save_ingest_state')).toHaveLength(0);
    expect(ledger.others).toEqual([]);

    const stages = ledger.advances.map((args) => args.p_stage);
    expect(stages).toEqual(['content_hash_dedup', 'scan_injection', 'chunk', 'enrich', 'extract', 'images', 'embed', 'write', 'publish']);
    const first = ledger.advances[0] as Record<string, unknown>;
    expect(first.p_worker).toBe(WORKER);
    expect(first.p_job_id).toBe(JOB_ID);
    expect(first.p_status).toBe('chunking');
    expect(first.p_timing_ms).toBe(7);
    expect((first.p_stage_state as Record<string, unknown>).cursor).toBe('content_hash_dedup');
    expect((first.p_stage_state as Record<string, unknown>).lastCompleted).toBe('content_hash_dedup');
    const embed = ledger.advances.find((args) => args.p_stage === 'embed') as Record<string, unknown>;
    expect(embed.p_status).toBe('embedding');
    const last = ledger.advances.at(-1) as Record<string, unknown>;
    expect(last.p_stage).toBe('publish');
    expect(last.p_status).toBe('embedding');
    expect(last.p_timing_ms).toBe(7);
    for (const args of ledger.advances) expect(Object.keys((args.p_stage_state as Record<string, unknown>).artifacts as object)).toEqual([]);
  });

  test('a yield before any new stage completed writes the state again without counting time twice', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });
    const clock = { t: 5_000 };
    const ledger = ledgerDb();
    const store = createLedgerStateStore({
      jobId: JOB_ID,
      worker: WORKER,
      signal: new AbortController().signal,
      now: () => clock.t,
      ledgerDeps: { db: () => ledger.db },
    });
    const ctx = makeCtx(store, () => clock.t);
    ctx.state.lastCompleted = 'parse';
    const stages = stagesAfter('content_hash_dedup', clock, 3).map((stage) => (stage.name === 'chunk' ? { ...stage, minMsNeeded: 100_000 } : stage));

    const result = await runIngestStages(ctx, stages);

    expect(result.status).toBe('processing');
    const timed = ledger.advances.filter((args) => args.p_timing_ms !== null && args.p_timing_ms !== undefined);
    expect(timed.map((args) => args.p_stage)).toEqual(['content_hash_dedup', 'scan_injection']);
    expect((ledger.advances.at(-1)?.p_stage_state as Record<string, unknown>).cursor).toBe('scan_injection');
  });
});
