import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import {
  LEGACY_PROFILE,
  ProfileUnavailableError,
  getActiveProfile,
  getBackfillingProfiles,
  refreshActiveProfile,
  resetActiveProfileForTests,
} from '@/lib/rag/embeddings/active-profile';
import {
  activateEmbeddingProfile,
  getEmbeddingProfileStatus,
  rollbackEmbeddingProfile,
  setEmbeddingProfileStatus,
} from '@/lib/rag/embeddings/profile-ops';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { SupabaseClient } from '@supabase/supabase-js';

interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

type Responder = (fn: string, args: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>;

function fakeRpc(respond: Responder): { client: SupabaseClient; calls: RecordedRpc[]; listCalls: () => number } {
  const calls: RecordedRpc[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(respond(fn, args)).then(onFulfilled, onRejected),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  return {
    client: client as unknown as SupabaseClient,
    calls,
    listCalls: () => calls.filter((call) => call.fn === 'rag_list_embedding_profiles').length,
  };
}

function row(id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    provider: 'voyage',
    model: 'voyage-4-large',
    dims: 1024,
    storage: 'halfvec',
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

const LEGACY_ROW = row('openai-3-small-1536', 'active', {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dims: 1536,
  storage: 'legacy_column',
  score_calibration: { retrieval_threshold: 0.7, context_threshold: 0.65, fallback_threshold: 0.28, context_image_threshold: 0.25 },
});

let clock = 1_000_000;
let mode: string | undefined;

function install(respond: Responder) {
  const fake = fakeRpc(respond);
  setRagDepsForTests({ adminClient: () => fake.client, now: () => clock });
  return fake;
}

function ok(data: unknown[]): RpcResponse {
  return { data, error: null };
}

beforeEach(() => {
  clock = 1_000_000;
  mode = 'on';
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: mode }) });
});

afterEach(() => {
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetActiveProfileForTests();
});

describe('getActiveProfile with the switch off', () => {
  it('returns the legacy constant and makes no database call', async () => {
    mode = 'off';
    const fake = install(() => ok([row('voyage-4-large-1024', 'active')]));
    const profile = await getActiveProfile();
    expect(profile).toEqual(LEGACY_PROFILE);
    expect(profile.id).toBe('openai-3-small-1536');
    expect(profile.provider).toBe('openai');
    expect(profile.model).toBe('text-embedding-3-small');
    expect(profile.dims).toBe(1536);
    expect(profile.storage).toBe('legacy_column');
    expect(fake.calls).toHaveLength(0);
  });

  it('treats an unset switch as off and returns no backfilling profiles without a read', async () => {
    mode = undefined;
    const fake = install(() => ok([LEGACY_ROW, row('voyage-4-large-1024', 'backfilling')]));
    expect(await getActiveProfile()).toEqual(LEGACY_PROFILE);
    expect(await getBackfillingProfiles()).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('getActiveProfile with the switch on', () => {
  it('reads rag_list_embedding_profiles on the admin client and maps the active row', async () => {
    const fake = install(() => ok([row('voyage-4-large-1024', 'active', { activated_by: 'operator-1' })]));
    const profile = await getActiveProfile();
    expect(fake.calls).toEqual([{ fn: 'rag_list_embedding_profiles', args: {} }]);
    expect(profile).toMatchObject({
      id: 'voyage-4-large-1024',
      provider: 'voyage',
      model: 'voyage-4-large',
      dims: 1024,
      storage: 'halfvec',
      status: 'active',
      queryInstruction: null,
      activatedBy: 'operator-1',
    });
  });

  it('reuses the read inside 30 seconds and reads again from 30 seconds on', async () => {
    const fake = install(() => ok([LEGACY_ROW]));
    await getActiveProfile();
    clock += 29_999;
    await getActiveProfile();
    expect(fake.listCalls()).toBe(1);
    clock += 1;
    await getActiveProfile();
    expect(fake.listCalls()).toBe(2);
  });

  it('shares one read between concurrent callers', async () => {
    const fake = install(() => ok([LEGACY_ROW]));
    const [a, b, c] = await Promise.all([getActiveProfile(), getActiveProfile(), getActiveProfile()]);
    expect(a.id).toBe('openai-3-small-1536');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(fake.listCalls()).toBe(1);
  });

  it('refreshActiveProfile forces a read inside the cache window and returns the new pointer', async () => {
    let active = 'openai-3-small-1536';
    const fake = install(() => ok(active === 'openai-3-small-1536' ? [LEGACY_ROW] : [row('voyage-4-large-1024', 'active')]));
    expect((await getActiveProfile()).id).toBe('openai-3-small-1536');
    active = 'voyage-4-large-1024';
    clock += 1000;
    expect((await getActiveProfile()).id).toBe('openai-3-small-1536');
    const refreshed = await refreshActiveProfile();
    expect(refreshed.id).toBe('voyage-4-large-1024');
    expect((await getActiveProfile()).id).toBe('voyage-4-large-1024');
    expect(fake.listCalls()).toBe(2);
  });

  it('getBackfillingProfiles returns only backfilling rows from the same read', async () => {
    const fake = install(() => ok([LEGACY_ROW, row('voyage-4-large-1024', 'backfilling'), row('qwen3-8b-1024', 'available'), row('qwen3-8b-2048', 'retired')]));
    await getActiveProfile();
    const backfilling = await getBackfillingProfiles();
    expect(backfilling.map((profile) => profile.id)).toEqual(['voyage-4-large-1024']);
    expect(fake.listCalls()).toBe(1);
  });
});

describe('a registry read that cannot give a pointer', () => {
  it('throws ProfileUnavailable on a read error and never falls back to the legacy profile', async () => {
    install(() => ({ data: null, error: { message: 'connection refused', code: '08006' } }));
    const error = await getActiveProfile().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProfileUnavailableError);
    expect((error as ProfileUnavailableError).reason).toBe('read_failed');
    expect((error as ProfileUnavailableError).code).toBe('08006');
  });

  it('throws ProfileUnavailable when no row is active', async () => {
    install(() => ok([row('voyage-4-large-1024', 'available')]));
    const error = await getActiveProfile().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProfileUnavailableError);
    expect((error as ProfileUnavailableError).reason).toBe('no_active_profile');
  });

  it('throws ProfileUnavailable when the admin client is missing', async () => {
    setRagDepsForTests({ adminClient: () => null, now: () => clock });
    const error = await getActiveProfile().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProfileUnavailableError);
    expect((error as ProfileUnavailableError).reason).toBe('no_admin_client');
  });

  it('does not cache a failed read', async () => {
    let fail = true;
    const fake = install(() => (fail ? { data: null, error: { message: 'boom' } } : ok([LEGACY_ROW])));
    await expect(getActiveProfile()).rejects.toBeInstanceOf(ProfileUnavailableError);
    fail = false;
    expect((await getActiveProfile()).id).toBe('openai-3-small-1536');
    expect(fake.listCalls()).toBe(2);
  });
});

describe('profile operations', () => {
  it('activate calls the gate function, returns the flip and refreshes the pointer', async () => {
    let flipped = false;
    const fake = install((fn) => {
      if (fn === 'rag_activate_embedding_profile') {
        flipped = true;
        return ok([{ activated_profile: 'voyage-4-large-1024', previous_profile: 'openai-3-small-1536' }]);
      }
      return ok(flipped ? [row('voyage-4-large-1024', 'active')] : [LEGACY_ROW]);
    });
    expect((await getActiveProfile()).id).toBe('openai-3-small-1536');
    const result = await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1');
    expect(result).toEqual({ ok: true, activated: 'voyage-4-large-1024', previous: 'openai-3-small-1536' });
    expect(fake.calls.find((call) => call.fn === 'rag_activate_embedding_profile')?.args).toEqual({
      p_target: 'voyage-4-large-1024',
      p_actor: 'operator-1',
    });
    expect((await getActiveProfile()).id).toBe('voyage-4-large-1024');
    expect(fake.listCalls()).toBe(2);
  });

  it('activate returns the distinct refusal reason and the full message, and leaves the pointer alone', async () => {
    const message = 'activation_refused: incomplete (3 current ready chunks have no vector for profile voyage-4-large-1024)';
    const fake = install((fn) => (fn === 'rag_activate_embedding_profile' ? { data: null, error: { message, code: '55000' } } : ok([LEGACY_ROW])));
    await getActiveProfile();
    const result = await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1');
    expect(result).toEqual({ ok: false, reason: 'activation_refused: incomplete', detail: message });
    expect(fake.listCalls()).toBe(1);
  });

  it.each([
    ['activation_refused: eval_stale (evidence recorded x, data embedded y)', 'activation_refused: eval_stale'],
    ['activation_refused: already_active', 'activation_refused: already_active'],
    ['activation_refused: actor_required', 'activation_refused: actor_required'],
  ])('activate passes the gate refusal %s through unchanged', async (message, reason) => {
    install(() => ({ data: null, error: { message, code: '55000' } }));
    expect(await activateEmbeddingProfile('voyage-4-large-1024', '')).toEqual({ ok: false, reason, detail: message });
  });

  it('a failure that is not a gate refusal throws ProfileUnavailable instead of reading as a refusal', async () => {
    install(() => ({ data: null, error: { message: 'permission denied for function', code: '42501' } }));
    const error = await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProfileUnavailableError);
    expect((error as ProfileUnavailableError).reason).toBe('rpc_failed');
    expect((error as ProfileUnavailableError).code).toBe('42501');
  });

  it('rollback restores the previous profile and refreshes the pointer', async () => {
    let rolledBack = false;
    const fake = install((fn) => {
      if (fn === 'rag_rollback_embedding_profile') {
        rolledBack = true;
        return ok([{ restored_profile: 'openai-3-small-1536', rolled_back_profile: 'voyage-4-large-1024' }]);
      }
      return ok(rolledBack ? [LEGACY_ROW] : [row('voyage-4-large-1024', 'active', { previous_active_id: 'openai-3-small-1536' })]);
    });
    expect((await getActiveProfile()).id).toBe('voyage-4-large-1024');
    const result = await rollbackEmbeddingProfile('operator-1');
    expect(result).toEqual({ ok: true, restored: 'openai-3-small-1536', rolledBack: 'voyage-4-large-1024' });
    expect(fake.calls.find((call) => call.fn === 'rag_rollback_embedding_profile')?.args).toEqual({ p_actor: 'operator-1' });
    expect((await getActiveProfile()).id).toBe('openai-3-small-1536');
  });

  it('rollback returns the refusal reason unchanged', async () => {
    const message = 'rollback_refused: no_previous';
    install(() => ({ data: null, error: { message, code: '55000' } }));
    expect(await rollbackEmbeddingProfile('operator-1')).toEqual({ ok: false, reason: 'rollback_refused: no_previous', detail: message });
  });

  it('set-status calls the status function and drops the cached pointer so dual-write sees the change', async () => {
    let backfilling = false;
    const fake = install((fn) => {
      if (fn === 'rag_set_embedding_profile_status') {
        backfilling = true;
        return ok([{ profile_id: 'voyage-4-large-1024', profile_status: 'backfilling' }]);
      }
      return ok(backfilling ? [LEGACY_ROW, row('voyage-4-large-1024', 'backfilling')] : [LEGACY_ROW]);
    });
    expect(await getBackfillingProfiles()).toEqual([]);
    const result = await setEmbeddingProfileStatus('voyage-4-large-1024', 'backfilling', 'operator-1');
    expect(result).toEqual({ ok: true, profileId: 'voyage-4-large-1024', status: 'backfilling' });
    expect(fake.calls.find((call) => call.fn === 'rag_set_embedding_profile_status')?.args).toEqual({
      p_profile_id: 'voyage-4-large-1024',
      p_status: 'backfilling',
      p_actor: 'operator-1',
    });
    expect((await getBackfillingProfiles()).map((profile) => profile.id)).toEqual(['voyage-4-large-1024']);
  });

  it('set-status returns the refusal for activating through it', async () => {
    const message = 'profile_status_refused: use_activation_gate';
    install(() => ({ data: null, error: { message, code: '22023' } }));
    expect(await setEmbeddingProfileStatus('voyage-4-large-1024', 'active', 'operator-1')).toEqual({
      ok: false,
      reason: 'profile_status_refused: use_activation_gate',
      detail: message,
    });
  });

  it('status lists the registry, the switch, the effective active profile and the startup verdict', async () => {
    install(() => ok([LEGACY_ROW, row('voyage-4-large-1024', 'backfilling')]));
    const status = await getEmbeddingProfileStatus();
    expect(status.switch).toBe('on');
    expect(status.active.id).toBe('openai-3-small-1536');
    expect(status.profiles.map((profile) => profile.id)).toEqual(['openai-3-small-1536', 'voyage-4-large-1024']);
    expect(status.startup.status).toBe('unknown');
  });

  it('status with the switch off reports the legacy profile as effective while still listing the registry', async () => {
    mode = 'off';
    install(() => ok([row('voyage-4-large-1024', 'active')]));
    const status = await getEmbeddingProfileStatus();
    expect(status.switch).toBe('off');
    expect(status.active).toEqual(LEGACY_PROFILE);
    expect(status.profiles.map((profile) => profile.id)).toEqual(['voyage-4-large-1024']);
  });
});
