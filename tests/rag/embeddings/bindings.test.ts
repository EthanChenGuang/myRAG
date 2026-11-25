import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { ProfileUnavailableError, resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { getBindingTargets, getEffectiveBindings, refreshBindings, resetBindingsForTests } from '@/lib/rag/embeddings/bindings';
import { resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { SupabaseClient } from '@supabase/supabase-js';

interface RecordedRpc {
  fn: string;
}

type Responder = (fn: string) => RpcResponse | Promise<RpcResponse>;

function fakeRpc(respond: Responder): { client: SupabaseClient; calls: RecordedRpc[]; bindingReads: () => number } {
  const calls: RecordedRpc[] = [];
  const client: RpcClient = {
    rpc(fn) {
      calls.push({ fn });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(respond(fn)).then(onFulfilled, onRejected),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  return {
    client: client as unknown as SupabaseClient,
    calls,
    bindingReads: () => calls.filter((call) => call.fn === 'rag_list_embedding_bindings').length,
  };
}

const TENANT_A = 'o:00000000-0000-4000-8000-00000000000a';
const TENANT_B = 'o:00000000-0000-4000-8000-00000000000b';
const GLOBAL = 'voyage-4-large-1024';
const LAW = 'voyage-law-2-1024';
const DOMAIN = 'voyage-4-large-1024-domain';
const FINANCE = 'voyage-finance-2-1024';

function profile(id: string, status: string, model: string): Record<string, unknown> {
  return {
    id,
    provider: 'voyage',
    model,
    dims: 1024,
    storage: 'halfvec',
    status,
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: null,
    has_evidence: false,
  };
}

const PROFILES = [
  profile(GLOBAL, 'active', 'voyage-4-large'),
  profile(LAW, 'available', 'voyage-law-2'),
  profile(DOMAIN, 'available', 'voyage-4-large'),
  profile(FINANCE, 'available', 'voyage-finance-2'),
];

const SCOPES = [
  { id: GLOBAL, doc_types: null },
  { id: LAW, doc_types: ['contract_legal'] },
  { id: DOMAIN, doc_types: ['contract_legal', 'financial_report', 'invoice_receipt'] },
  { id: FINANCE, doc_types: ['financial_report', 'invoice_receipt'] },
];

let seq = 0;
function binding(docType: string, tenantKey: string | null, profileId: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const scope = SCOPES.find((entry) => entry.id === profileId);
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    doc_type: docType,
    tenant_key: tenantKey,
    profile_id: profileId,
    model: 'voyage-law-2',
    doc_types: scope?.doc_types ?? null,
    status,
    previous_binding_id: null,
    has_evidence: status === 'active',
    baseline_global_profile: status === 'active' ? GLOBAL : null,
    activated_at: null,
    activated_by: null,
    created_at: '2026-11-25T00:00:00Z',
    created_by: 'test',
    ...over,
  };
}

let clock = 1_000_000;
let domainSwitch: string | undefined;
let profilesSwitch: string | undefined;

function install(bindings: unknown[] | (() => RpcResponse)) {
  const fake = fakeRpc((fn) => {
    if (fn === 'rag_list_embedding_profiles') return { data: PROFILES, error: null };
    if (fn === 'rag_list_embedding_profile_scopes') return { data: SCOPES, error: null };
    if (fn === 'rag_list_embedding_bindings') return typeof bindings === 'function' ? bindings() : { data: bindings, error: null };
    return { data: null, error: { message: `unexpected ${fn}`, code: 'XX000' } };
  });
  setRagDepsForTests({ adminClient: () => fake.client, now: () => clock });
  return fake;
}

function standardRows(): unknown[] {
  return [
    binding('contract_legal', null, LAW, 'active'),
    binding('contract_legal', TENANT_A, DOMAIN, 'active'),
    binding('financial_report', null, FINANCE, 'backfilling'),
  ];
}

beforeEach(() => {
  clock = 1_000_000;
  domainSwitch = 'on';
  profilesSwitch = 'on';
  resetIngestConfigForTests();
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: profilesSwitch, RAG_DOMAIN_EMBEDDINGS: domainSwitch }) });
});

afterEach(() => {
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetIngestConfigForTests();
  resetActiveProfileForTests();
  resetBindingsForTests();
});

describe('binding reads with the switch off', () => {
  it('returns no bindings and no targets without any database call', async () => {
    domainSwitch = 'off';
    const fake = install(standardRows());
    expect(await getEffectiveBindings(TENANT_A)).toEqual([]);
    expect(await getBindingTargets('contract_legal', TENANT_A)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('stays off when embedding profiles are off even if the domain switch is on', async () => {
    profilesSwitch = 'off';
    const fake = install(standardRows());
    expect(await getEffectiveBindings(TENANT_A)).toEqual([]);
    expect(await getBindingTargets('contract_legal', TENANT_A)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('binding precedence per tenant', () => {
  it('prefers the active tenant binding for its own tenant and the deployment binding for any other tenant', async () => {
    install(standardRows());
    const forA = await getEffectiveBindings(TENANT_A);
    expect(forA.map((entry) => [entry.docType, entry.profile.id, entry.tenantKey])).toEqual([['contract_legal', DOMAIN, TENANT_A]]);
    expect(forA[0].profile.docTypes).toEqual(['contract_legal', 'financial_report', 'invoice_receipt']);
    expect(forA[0].profile.model).toBe('voyage-4-large');
    expect(forA[0].stale).toBe(false);

    const forB = await getEffectiveBindings(TENANT_B);
    expect(forB.map((entry) => [entry.docType, entry.profile.id, entry.tenantKey])).toEqual([['contract_legal', LAW, null]]);
    expect(forB.some((entry) => entry.docType === 'financial_report')).toBe(false);
  });

  it('never applies a tenant binding to another tenant, even one whose key shares a prefix', async () => {
    install(standardRows());
    const effective = await getEffectiveBindings(`${TENANT_A.slice(0, -1)}c`);
    expect(effective.every((entry) => entry.tenantKey === null)).toBe(true);
  });

  it('returns the write targets of the tenant row and the deployment row, deduplicated by profile, with their roles', async () => {
    install([...standardRows(), binding('contract_legal', TENANT_A, LAW, 'backfilling')]);
    const targets = await getBindingTargets('contract_legal', TENANT_A);
    expect(targets.map((entry) => [entry.profile.id, entry.role])).toEqual([
      [DOMAIN, 'active'],
      [LAW, 'active'],
    ]);
    const finance = await getBindingTargets('financial_report', TENANT_B);
    expect(finance.map((entry) => [entry.profile.id, entry.role, entry.tenantKey])).toEqual([[FINANCE, 'backfilling', null]]);
    expect(await getBindingTargets('general', TENANT_B)).toEqual([]);
  });

  it('ignores retired and available rows for targets and effective bindings', async () => {
    install([binding('contract_legal', null, LAW, 'available'), binding('contract_legal', TENANT_A, DOMAIN, 'retired')]);
    expect(await getEffectiveBindings(TENANT_A)).toEqual([]);
    expect(await getBindingTargets('contract_legal', TENANT_A)).toEqual([]);
  });
});

describe('stale baseline', () => {
  it('flags an active binding whose evidence names another global profile', async () => {
    install([binding('contract_legal', null, LAW, 'active', { baseline_global_profile: 'openai-3-small-1536' })]);
    const [entry] = await getEffectiveBindings(TENANT_A);
    expect(entry.profile.id).toBe(LAW);
    expect(entry.stale).toBe(true);
  });
});

describe('binding cache', () => {
  it('reads once within 30 s, again after refreshBindings and again after the TTL', async () => {
    const fake = install(standardRows());
    await getEffectiveBindings(TENANT_A);
    await getBindingTargets('contract_legal', TENANT_A);
    clock += 29_000;
    await getEffectiveBindings(TENANT_B);
    expect(fake.bindingReads()).toBe(1);
    await refreshBindings();
    expect(fake.bindingReads()).toBe(2);
    clock += 30_000;
    await getEffectiveBindings(TENANT_A);
    expect(fake.bindingReads()).toBe(3);
  });

  it('throws ProfileUnavailableError(read_failed) when the registry errors and never returns an empty list', async () => {
    install(() => ({ data: null, error: { message: 'permission denied', code: '42501' } }));
    await expect(getEffectiveBindings(TENANT_A)).rejects.toMatchObject({ name: 'ProfileUnavailable', reason: 'read_failed' });
    await expect(getBindingTargets('contract_legal', TENANT_A)).rejects.toBeInstanceOf(ProfileUnavailableError);
  });

  it('skips a malformed row and refuses a malformed active row', async () => {
    install([binding('memo', null, LAW, 'available'), binding('contract_legal', null, LAW, 'active')]);
    const effective = await getEffectiveBindings(TENANT_A);
    expect(effective.map((entry) => entry.profile.id)).toEqual([LAW]);

    resetBindingsForTests();
    install([binding('memo', null, LAW, 'active')]);
    await expect(getEffectiveBindings(TENANT_A)).rejects.toMatchObject({ reason: 'malformed_active_profile' });
  });
});
