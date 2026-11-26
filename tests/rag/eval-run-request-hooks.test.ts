import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { ConfigGateMode } from '@/lib/rag/monitor/config';

const gate = vi.hoisted(() => ({ mode: 'off' as ConfigGateMode }));

vi.mock('@/lib/rag/monitor/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/monitor/config')>();
  return { ...actual, monitorSettings: () => ({ ...actual.monitorSettings({}), configGate: gate.mode }) };
});

const TENANT_A = 'u:00000000-0000-4000-8000-0000000025a1';
const TENANT_B = 'o:00000000-0000-4000-8000-0000000025b2';
const BATCH_ID = '00000000-0000-4000-8000-0000000025c3';
const RUN_ID = '00000000-0000-4000-8000-0000000025d4';

type Call = { fn: string; args: Record<string, unknown> };

function request(response: () => Promise<RpcResponse>): RpcRequest {
  const req: RpcRequest = {
    abortSignal: () => req,
    then: (onFulfilled, onRejected) => response().then(onFulfilled, onRejected),
  };
  return req;
}

function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => unknown>, enqueue: () => Promise<RpcResponse>) {
  const calls: Call[] = [];
  const rpc: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (fn === 'rag_eval_run_request_enqueue') return request(enqueue);
      const handler = handlers[fn];
      if (!handler) return request(async () => ({ data: null, error: { message: `unexpected ${fn}` } }));
      return request(async () => ({ data: handler(args), error: null }));
    },
  };
  return { rpc, calls, enqueues: () => calls.filter((call) => call.fn === 'rag_eval_run_request_enqueue') };
}

function batchRow(status = 'running') {
  return { id: BATCH_ID, tenant_key: TENANT_A, source_kind: 'folder', source_ref: 'fixtures', budget_usd: 1, spent_usd: 0, concurrency: 1, runner: 'worker', status, dry_run_report: null };
}

function backfillRpc(enqueue: () => Promise<RpcResponse> = async () => ({ data: true, error: null })) {
  const updates: Array<Record<string, unknown>> = [];
  const fake = fakeRpc(
    {
      rag_update_ingestion_batch: (args) => {
        if (args.p_status !== undefined || args.p_totals !== undefined) updates.push(args);
        return [batchRow()];
      },
      rag_list_batch_jobs: () => [],
    },
    enqueue,
  );
  return { ...fake, updates };
}

async function finish(rpc: RpcClient) {
  const { finishBatch } = await import('@/lib/rag/ingest/backfill/orchestrate');
  const { mintScope } = await import('@/lib/rag/tenant/scope');
  const lines: string[] = [];
  const scope = mintScope('personal', TENANT_A.slice(2), null);
  const io = { out: (line: string) => lines.push(line), err: () => {} };
  const end = await finishBatch({ id: BATCH_ID, scope }, { rpc, signal: new AbortController().signal, io: io as never });
  return { end, lines };
}

describe('finishBatch requests the tenant nightly (05.3-25, D-19)', () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    gate.mode = 'off';
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  });
  afterEach(() => {
    for (const spy of logs) spy.mockRestore();
  });

  it('with RAG_CONFIG_GATE off makes no enqueue call and leaves the end report and status write as they are', async () => {
    const off = backfillRpc();
    const offRun = await finish(off.rpc);
    gate.mode = 'warn';
    const on = backfillRpc();
    const onRun = await finish(on.rpc);
    expect(off.enqueues()).toHaveLength(0);
    expect(on.enqueues()).toHaveLength(1);
    expect(offRun.end).toEqual(onRun.end);
    expect(offRun.lines).toEqual(onRun.lines);
    expect(off.updates).toEqual(on.updates);
    expect(off.updates.some((args) => args.p_status === 'completed')).toBe(true);
  });

  it('with warn enqueues once with the batch tenant, backfill_completed and the batch id, after the completed write', async () => {
    gate.mode = 'warn';
    const fake = backfillRpc();
    await finish(fake.rpc);
    expect(fake.enqueues().map((call) => call.args)).toEqual([{ p_tenant_key: TENANT_A, p_reason: 'backfill_completed', p_ref_id: BATCH_ID }]);
    const completedAt = fake.calls.findIndex((call) => call.fn === 'rag_update_ingestion_batch' && call.args.p_status === 'completed');
    const enqueuedAt = fake.calls.findIndex((call) => call.fn === 'rag_eval_run_request_enqueue');
    expect(completedAt).toBeGreaterThanOrEqual(0);
    expect(enqueuedAt).toBeGreaterThan(completedAt);
  });

  it('a repeated finish calls again and the idempotent function stores nothing new', async () => {
    gate.mode = 'enforce';
    let first = true;
    const fake = backfillRpc(async () => {
      const inserted = first;
      first = false;
      return { data: inserted, error: null };
    });
    await finish(fake.rpc);
    await finish(fake.rpc);
    expect(fake.enqueues()).toHaveLength(2);
  });

  it('a rejected enqueue never fails the batch: same end report, one [Config Gate] line with the error name', async () => {
    gate.mode = 'warn';
    const good = backfillRpc();
    const goodRun = await finish(good.rpc);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = backfillRpc(async () => {
      throw new TypeError('network down');
    });
    const badRun = await finish(bad.rpc);
    expect(badRun.end).toEqual(goodRun.end);
    const gateLines = errors.mock.calls.filter((args) => String(args[0]).startsWith('[Config Gate]'));
    expect(gateLines).toHaveLength(1);
    expect(JSON.stringify(gateLines[0])).toContain('TypeError');
    expect(JSON.stringify(gateLines[0])).not.toContain('network down');
  });

  it('an enqueue answered with an error is logged and swallowed', async () => {
    gate.mode = 'warn';
    const fake = backfillRpc(async () => ({ data: null, error: { message: 'boom', code: '22023' } }));
    await expect(finish(fake.rpc)).resolves.toBeDefined();
  });
});

const writerState = vi.hoisted(() => ({
  chunks: [] as Array<Record<string, unknown>>,
  finishStatus: [] as string[],
  derive: false,
  runTenant: null as string | null,
}));

vi.mock('@/lib/rag/ingest/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/writer')>();
  return {
    ...actual,
    createReembedWriter: () => {
      let served = false;
      const run = {
        runId: RUN_ID,
        profileId: 'profile-test',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dims: 4,
        tenantKey: writerState.runTenant,
        derivedFrom: writerState.derive ? 'profile-source' : null,
        cursorChunkId: null,
        profileStatus: 'backfilling',
      };
      return {
        start: async () => run,
        get: async () => run,
        resume: async () => run,
        profileScope: async () => null,
        nextBatch: async () => {
          if (served) return [];
          served = true;
          return writerState.chunks;
        },
        missingBatch: async () => [],
        writeBatch: async (_id: string, rows: unknown[]) => ({ written: rows.length, cursor: null }),
        deriveBatch: async () => ({ derived: 0, cursor: null }),
        remaining: async () => 0,
        finish: async (_id: string, status: string) => {
          writerState.finishStatus.push(status);
          return { missing: 0 };
        },
      };
    },
  };
});

vi.mock('@/lib/rag/embeddings/active-profile', () => ({
  getBackfillingProfiles: async () => [{ id: 'profile-test' }],
  isEmbeddingProfilesEnabled: () => true,
  listEmbeddingProfiles: async () => [],
  refreshAfterOperation: async () => {},
}));

const providerState = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/rag/embeddings/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/embeddings/registry')>();
  return {
    ...actual,
    canonicalModelId: (model: string) => model,
    getEmbeddingProviderFor: () => ({
      model: 'text-embedding-3-small',
      supportedDims: [4],
      embedDocuments: async (texts: string[]) => {
        if (providerState.fail) throw new Error('provider down');
        return { model: 'text-embedding-3-small', vectors: texts.map(() => [0.1, 0.2, 0.3, 0.4]), host: 'test-host', usage: { tokens: 10 } };
      },
    }),
  };
});

function chunk(id: string, tenantKey: string) {
  return { id, tenantKey, documentId: id, content: 'A neutral synthetic sentence.', sectionPath: [], chunkKind: 'text', docType: null, templateRow: {}, hasGap: false };
}

async function reembed(rpc: RpcClient) {
  const { runReembed } = await import('@/lib/rag/ingest/reembed/run');
  return runReembed({ db: rpc, profileId: 'profile-test' });
}

describe('runReembed requests the tenant nightly per tenant (05.3-25, D-19)', () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    gate.mode = 'warn';
    providerState.fail = false;
    writerState.finishStatus = [];
    writerState.derive = false;
    writerState.runTenant = null;
    writerState.chunks = [chunk('00000000-0000-4000-8000-00000000c001', TENANT_A), chunk('00000000-0000-4000-8000-00000000c002', TENANT_B)];
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
  });
  afterEach(() => {
    for (const spy of logs) spy.mockRestore();
  });

  it('a completed run with tenants A and B enqueues twice, reembed_completed with the run id', async () => {
    const fake = fakeRpc({}, async () => ({ data: true, error: null }));
    const report = await reembed(fake.rpc);
    expect(report.status).toBe('completed');
    const args = fake.enqueues().map((call) => call.args);
    expect(args).toHaveLength(2);
    expect(args).toEqual(
      expect.arrayContaining([
        { p_tenant_key: TENANT_A, p_reason: 'reembed_completed', p_ref_id: RUN_ID },
        { p_tenant_key: TENANT_B, p_reason: 'reembed_completed', p_ref_id: RUN_ID },
      ]),
    );
  });

  it('a run that ends failed makes no call', async () => {
    providerState.fail = true;
    const fake = fakeRpc({}, async () => ({ data: true, error: null }));
    const report = await reembed(fake.rpc);
    expect(report.status).toBe('failed');
    expect(fake.enqueues()).toHaveLength(0);
  });

  it('with the gate off makes no call and returns the same report', async () => {
    const on = fakeRpc({}, async () => ({ data: true, error: null }));
    const onReport = await reembed(on.rpc);
    gate.mode = 'off';
    const off = fakeRpc({}, async () => ({ data: true, error: null }));
    const offReport = await reembed(off.rpc);
    expect(off.enqueues()).toHaveLength(0);
    expect(offReport).toEqual(onReport);
  });

  it('a rejected enqueue leaves the completed report unchanged', async () => {
    const good = fakeRpc({}, async () => ({ data: true, error: null }));
    const goodReport = await reembed(good.rpc);
    const bad = fakeRpc({}, async () => {
      throw new Error('down');
    });
    const badReport = await reembed(bad.rpc);
    expect(badReport).toEqual(goodReport);
  });

  it('a derived run for one tenant enqueues for the run tenant', async () => {
    writerState.derive = true;
    writerState.runTenant = TENANT_A;
    const fake = fakeRpc({}, async () => ({ data: true, error: null }));
    const report = await reembed(fake.rpc);
    expect(report.status).toBe('completed');
    expect(fake.enqueues().map((call) => call.args)).toEqual([{ p_tenant_key: TENANT_A, p_reason: 'reembed_completed', p_ref_id: RUN_ID }]);
  });
});

describe('requestTenantNightly (05.3-25)', () => {
  it('refuses a malformed tenant key without a call and never throws', async () => {
    gate.mode = 'warn';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { requestTenantNightly } = await import('@/lib/rag/config-gate/eval-run-requests');
    const fake = fakeRpc({}, async () => ({ data: true, error: null }));
    await expect(requestTenantNightly(fake.rpc, { tenantKey: 'u:not-a-uuid', reason: 'manual', refId: 'x' })).resolves.toEqual({ ok: false, requested: false });
    expect(fake.enqueues()).toHaveLength(0);
    warn.mockRestore();
  });
});
