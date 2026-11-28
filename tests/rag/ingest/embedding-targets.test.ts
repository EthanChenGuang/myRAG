import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { LEGACY_PROFILE, ProfileUnavailableError, resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { resetBindingsForTests } from '@/lib/rag/embeddings/bindings';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resolveEmbeddingTargets } from '@/lib/rag/ingest/embedding-targets';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { SupabaseClient } from '@supabase/supabase-js';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const QWEN = 'qwen3-8b-1024';
const LAW = 'voyage-law-2-1024';
const TENANT_A = 'o:00000000-0000-4000-8000-00000000000a';
const TENANT_B = 'o:00000000-0000-4000-8000-00000000000b';

interface Run {
  profileId: string;
  runId: string;
  status: string;
}

let mode: string | undefined;
let domainMode: string | undefined;
let listCalls = 0;
let bindingCalls = 0;
let rows: Array<Record<string, unknown>> = [];
let bindingRows: Array<Record<string, unknown>> = [];
let listFailure: RpcResponse | null = null;
let bindingFailure: RpcResponse | null = null;

function lawRow(): Record<string, unknown> {
  return row(LAW, 'available', { provider: 'voyage', model: 'voyage-law-2', storage: 'halfvec', doc_types: ['contract_legal'] });
}

function binding(id: string, status: string, tenantKey: string | null, profileId = LAW, docType = 'contract_legal'): Record<string, unknown> {
  return { id, doc_type: docType, tenant_key: tenantKey, profile_id: profileId, status, has_evidence: false, baseline_global_profile: LEGACY };
}

function row(id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const halfvec = id !== LEGACY;
  return {
    id,
    provider: id.startsWith('qwen') ? 'qwen3' : halfvec ? 'voyage' : 'openai',
    model: id.startsWith('qwen') ? 'Qwen/Qwen3-Embedding-8B' : halfvec ? 'voyage-4-large' : 'text-embedding-3-small',
    dims: Number(id.split('-').pop()),
    storage: halfvec ? 'halfvec' : 'legacy_column',
    status,
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: null,
    has_evidence: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function installRegistry(): void {
  const client: RpcClient = {
    rpc(fn) {
      if (fn === 'rag_list_embedding_profiles') listCalls += 1;
      let response: RpcResponse = listFailure ?? { data: rows, error: null };
      if (fn === 'rag_list_embedding_bindings') {
        bindingCalls += 1;
        response = bindingFailure ?? { data: bindingRows, error: null };
      } else if (fn === 'rag_list_embedding_profile_scopes') {
        const scoped = rows.filter((entry) => Array.isArray(entry.doc_types)).map((entry) => ({ id: entry.id, doc_types: entry.doc_types }));
        response = bindingFailure ?? { data: scoped, error: null };
      }
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  setRagDepsForTests({ adminClient: () => client as unknown as SupabaseClient, now: () => 1_000_000 });
}

function writerWith(runs: Run[] | Error) {
  const findBackfillRuns = vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return runs;
  });
  return { findBackfillRuns };
}

beforeEach(() => {
  mode = 'on';
  domainMode = 'off';
  listCalls = 0;
  bindingCalls = 0;
  listFailure = null;
  bindingFailure = null;
  bindingRows = [];
  rows = [row(LEGACY, 'active'), row(VOYAGE, 'available'), row(QWEN, 'available')];
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: mode, RAG_DOMAIN_EMBEDDINGS: domainMode }) });
  installRegistry();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetActiveProfileForTests();
  resetBindingsForTests();
  vi.restoreAllMocks();
});

const ids = (targets: Array<{ profile: { id: string } }>): string[] => targets.map((target) => target.profile.id);

describe('resolveEmbeddingTargets', () => {
  it('with the switch off returns the legacy profile only and reads nothing', async () => {
    mode = 'off';
    const writer = writerWith([]);
    const targets = await resolveEmbeddingTargets(writer);
    expect(targets).toEqual([{ profile: LEGACY_PROFILE, role: 'active', runId: null }]);
    expect(listCalls).toBe(0);
    expect(writer.findBackfillRuns).not.toHaveBeenCalled();
  });

  it('on with the legacy profile active and voyage backfilling gives legacy then voyage with the open run', async () => {
    rows = [row(LEGACY, 'active'), row(VOYAGE, 'backfilling'), row(QWEN, 'available')];
    const targets = await resolveEmbeddingTargets(writerWith([{ profileId: VOYAGE, runId: 'run-voyage', status: 'running' }]));
    expect(ids(targets)).toEqual([LEGACY, VOYAGE]);
    expect(targets.map((target) => target.role)).toEqual(['active', 'backfilling']);
    expect(targets.map((target) => target.runId)).toEqual([null, 'run-voyage']);
  });

  it('on with voyage active whose previous is legacy and qwen backfilling gives voyage, qwen, legacy', async () => {
    rows = [row(LEGACY, 'available'), row(VOYAGE, 'active', { previous_active_id: LEGACY }), row(QWEN, 'backfilling')];
    const targets = await resolveEmbeddingTargets(
      writerWith([
        { profileId: QWEN, runId: 'run-qwen', status: 'running' },
        { profileId: LEGACY, runId: 'run-legacy', status: 'completed' },
      ]),
    );
    expect(ids(targets)).toEqual([VOYAGE, QWEN, LEGACY]);
    expect(targets.map((target) => target.role)).toEqual(['active', 'backfilling', 'previous']);
    expect(targets.map((target) => target.runId)).toEqual([null, 'run-qwen', 'run-legacy']);
  });

  it('a backfilling profile has an open run only when its newest run is running', async () => {
    rows = [row(LEGACY, 'active'), row(VOYAGE, 'backfilling')];
    const targets = await resolveEmbeddingTargets(writerWith([{ profileId: VOYAGE, runId: 'run-old', status: 'completed' }]));
    expect(targets[1]?.runId).toBeNull();
  });

  it('a retired previous profile is not a target and a previous profile that is also backfilling appears once', async () => {
    rows = [row(LEGACY, 'retired'), row(VOYAGE, 'active', { previous_active_id: LEGACY })];
    expect(ids(await resolveEmbeddingTargets(writerWith([])))).toEqual([VOYAGE]);

    resetActiveProfileForTests();
    rows = [row(LEGACY, 'backfilling'), row(VOYAGE, 'active', { previous_active_id: LEGACY })];
    const targets = await resolveEmbeddingTargets(writerWith([]));
    expect(ids(targets)).toEqual([VOYAGE, LEGACY]);
    expect(targets[1]?.role).toBe('backfilling');
  });

  it('does not look up runs when the active profile is the only target', async () => {
    const writer = writerWith([]);
    expect(ids(await resolveEmbeddingTargets(writer))).toEqual([LEGACY]);
    expect(writer.findBackfillRuns).not.toHaveBeenCalled();
  });

  it('a failed run lookup leaves the runs unknown instead of failing the ingestion', async () => {
    rows = [row(LEGACY, 'active'), row(VOYAGE, 'backfilling')];
    const targets = await resolveEmbeddingTargets(writerWith(new Error('rpc down')));
    expect(ids(targets)).toEqual([LEGACY, VOYAGE]);
    expect(targets[1]?.runId).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('an unreadable registry throws ProfileUnavailableError and never falls back to the legacy profile', async () => {
    listFailure = { data: null, error: { code: '42883', message: 'missing' } };
    await expect(resolveEmbeddingTargets(writerWith([]))).rejects.toBeInstanceOf(ProfileUnavailableError);
  });
});

describe('resolveEmbeddingTargets with domain bindings (D-15)', () => {
  const CONTRACT_A = { docType: 'contract_legal', tenantKey: TENANT_A };

  beforeEach(() => {
    rows = [row(LEGACY, 'active'), row(VOYAGE, 'backfilling'), lawRow()];
    bindingRows = [binding('b-deploy', 'backfilling', null)];
  });

  it('with RAG_DOMAIN_EMBEDDINGS off a scoped call equals the unscoped Phase 3 list and reads no binding', async () => {
    const runs = [{ profileId: VOYAGE, runId: 'run-voyage', status: 'running' }, { profileId: LAW, runId: 'run-law', status: 'running' }];
    const unscoped = await resolveEmbeddingTargets(writerWith(runs));
    resetActiveProfileForTests();
    const scoped = await resolveEmbeddingTargets(writerWith(runs), CONTRACT_A);
    expect(scoped).toEqual(unscoped);
    expect(ids(scoped)).toEqual([LEGACY, VOYAGE]);
    expect(bindingCalls).toBe(0);
  });

  it('with the switch on and no binding for the doc type the list equals the Phase 3 list', async () => {
    domainMode = 'on';
    const runs = [{ profileId: VOYAGE, runId: 'run-voyage', status: 'running' }];
    const targets = await resolveEmbeddingTargets(writerWith(runs), { docType: 'general', tenantKey: TENANT_A });
    expect(targets.map((target) => [target.profile.id, target.role, target.runId])).toEqual([
      [LEGACY, 'active', null],
      [VOYAGE, 'backfilling', 'run-voyage'],
    ]);
  });

  it('a backfilling deployment binding is appended as role binding with its running run', async () => {
    domainMode = 'on';
    const targets = await resolveEmbeddingTargets(
      writerWith([
        { profileId: VOYAGE, runId: 'run-voyage', status: 'running' },
        { profileId: LAW, runId: 'run-law', status: 'running' },
      ]),
      CONTRACT_A,
    );
    expect(targets.map((target) => [target.profile.id, target.role, target.runId])).toEqual([
      [LEGACY, 'active', null],
      [VOYAGE, 'backfilling', 'run-voyage'],
      [LAW, 'binding', 'run-law'],
    ]);
  });

  it('a binding run that is not running leaves the binding target without a run', async () => {
    domainMode = 'on';
    rows = [row(LEGACY, 'active'), lawRow()];
    bindingRows = [binding('b-deploy', 'active', null)];
    const targets = await resolveEmbeddingTargets(writerWith([{ profileId: LAW, runId: 'run-law', status: 'completed' }]), CONTRACT_A);
    expect(targets.map((target) => [target.profile.id, target.role, target.runId])).toEqual([
      [LEGACY, 'active', null],
      [LAW, 'binding', null],
    ]);
  });

  it('a tenant binding applies to its own tenant only', async () => {
    domainMode = 'on';
    rows = [row(LEGACY, 'active'), lawRow()];
    bindingRows = [binding('b-a', 'active', TENANT_A)];
    expect(ids(await resolveEmbeddingTargets(writerWith([]), CONTRACT_A))).toEqual([LEGACY, LAW]);
    expect(ids(await resolveEmbeddingTargets(writerWith([]), { docType: 'contract_legal', tenantKey: TENANT_B }))).toEqual([LEGACY]);
  });

  it('without a scope (the backfill orchestrator call) no binding target is added even with an active binding', async () => {
    domainMode = 'on';
    bindingRows = [binding('b-deploy', 'active', null)];
    const targets = await resolveEmbeddingTargets(writerWith([{ profileId: VOYAGE, runId: 'run-voyage', status: 'running' }]));
    expect(ids(targets)).toEqual([LEGACY, VOYAGE]);
    expect(bindingCalls).toBe(0);
  });

  it('a binding profile that is already a target is not duplicated', async () => {
    domainMode = 'on';
    rows = [row(LEGACY, 'active'), lawRow()];
    bindingRows = [binding('b-deploy', 'active', null), binding('b-a', 'backfilling', TENANT_A)];
    const targets = await resolveEmbeddingTargets(writerWith([]), CONTRACT_A);
    expect(ids(targets)).toEqual([LEGACY, LAW]);
    expect(new Set(ids(targets)).size).toBe(targets.length);
  });

  it('an unreadable binding registry throws ProfileUnavailableError', async () => {
    domainMode = 'on';
    bindingFailure = { data: null, error: { code: '42883', message: 'missing' } };
    await expect(resolveEmbeddingTargets(writerWith([]), CONTRACT_A)).rejects.toBeInstanceOf(ProfileUnavailableError);
  });
});
