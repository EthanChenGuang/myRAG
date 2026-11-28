import { describe, expect, it, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { main as rolloutCli } from '@/lib/rag/rollout/cli';
import {
  compareRolloutLanguages,
  listRollouts,
  promoteRollout,
  rolloutPolicy,
  type PromoteDeps,
  type RolloutActivators,
} from '@/lib/rag/rollout/promote';

const DAY = 86_400_000;
const START = Date.parse('2026-11-01T00:00:00.000Z');
const ROLLOUT_ID = '00000000-0000-4000-8000-0000000000aa';
const SALT = 'SaltValueNeverShown01';
const A = 'o:00000000-0000-4000-8000-000000000001';
const B = 'o:00000000-0000-4000-8000-000000000002';
const C = 'o:00000000-0000-4000-8000-000000000003';

interface CellSpec {
  tenant: string;
  language: string;
  retrievals: number;
  refused: number;
  up?: number;
  down?: number;
}

type Rows = Array<Record<string, unknown>>;

function row(spec: CellSpec): Record<string, unknown> {
  return {
    tenant_key: spec.tenant,
    language: spec.language,
    retrievals: spec.retrievals,
    refused: spec.refused,
    kb_unavailable: 0,
    votes_up: spec.up ?? 0,
    votes_down: spec.down ?? 0,
    low_confidence: 0,
  };
}

function activeRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROLLOUT_ID,
    kind: 'embedding_profile',
    candidate_ref: { embedding_profile_id: 'profile-b' },
    incumbent_ref: { embedding_profile_id: 'profile-a' },
    mode: 'tenants',
    share_percent: null,
    salt: SALT,
    included_tenants: [A],
    excluded_tenants: [],
    chunking_map: null,
    created_at: new Date(START).toISOString(),
    ...partial,
  };
}

/** A fake service-role client: rag_rollout_active, both cell windows (current when p_since >= start) and rag_rollout_finish. */
function fakeRpc(input: { active?: Rows; current: CellSpec[]; baseline: CellSpec[] }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      let data: unknown = null;
      if (fn === 'rag_rollout_active') data = input.active ?? [activeRow()];
      else if (fn === 'rag_language_quality_cells') {
        const since = Date.parse(String(args.p_since));
        data = (since >= START ? input.current : input.baseline).map(row);
      } else if (fn === 'rag_rollout_finish') data = 'promoted';
      const response = { data, error: null };
      const request = {
        abortSignal: () => request,
        then: (resolve: (value: typeof response) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
      };
      return request;
    },
  } as unknown as RpcClient;
  return { rpc, calls };
}

function activators(overrides: Partial<RolloutActivators> = {}): RolloutActivators & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    embeddingProfile: vi.fn(async (id: string) => {
      calls.push(`embedding:${id}`);
      return { ok: true as const };
    }),
    chunkingProfile: vi.fn(async (entry) => {
      calls.push(`chunking:${entry.docType ?? ''}:${entry.profileId}`);
      return { ok: true as const, docType: entry.docType ?? 'general', changed: true };
    }),
    chunkingRollback: vi.fn(async (docType: string) => {
      calls.push(`chunking-rollback:${docType}`);
    }),
    rebuildRun: vi.fn(async (id: string) => {
      calls.push(`rebuild:${id}`);
      return { ok: true as const };
    }),
    ...overrides,
  };
}

const healthy = (tenant: string, factor = 1): CellSpec[] => [
  { tenant, language: 'zh', retrievals: 100 * factor, refused: 10 * factor, up: 40, down: 4 },
  { tenant, language: 'en', retrievals: 100 * factor, refused: 10 * factor, up: 40, down: 4 },
  { tenant, language: 'it', retrievals: 60 * factor, refused: 6 * factor, up: 40, down: 4 },
];

function deps(rpc: RpcClient, activate: RolloutActivators, days = 8, extra: Partial<PromoteDeps> = {}): PromoteDeps {
  return { rpc, now: () => START + days * DAY, languages: () => ['zh', 'en', 'it'], activate, ...extra };
}

describe('promoteRollout (LANG-11 with LANG-10)', () => {
  it('promotes when zh, en and it all hold after 7 days with 30 samples each, then finishes as promoted', async () => {
    const fake = fakeRpc({ current: [...healthy(A), ...healthy(B)], baseline: [...healthy(A), ...healthy(B)] });
    const act = activators();
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act));
    expect(result.ok).toBe(true);
    expect(act.calls).toEqual(['embedding:profile-b']);
    const finish = fake.calls.find((call) => call.fn === 'rag_rollout_finish');
    expect(finish?.args).toMatchObject({ p_rollout_id: ROLLOUT_ID, p_state: 'promoted' });
    if (!result.ok) return;
    expect(result.arms).toEqual({ candidate: 1, incumbent: 1 });
    expect(result.languages.map((entry) => entry.language)).toEqual(['en', 'it', 'zh']);
    const zhRefusal = result.languages.find((entry) => entry.language === 'zh')!.measures.find((m) => m.measure === 'refusal_rate')!;
    expect(zhRefusal).toEqual({
      measure: 'refusal_rate',
      candidate: { value: 0.1, n: 100 },
      before: { value: 0.1, n: 100 },
      others: { value: 0.1, n: 100 },
      verdict: 'holds',
    });
    expect(JSON.stringify(result)).not.toContain(SALT);
  });

  it('rollout_language_drop: it worse on the refusal rate while zh and en improve refuses and activates nothing', async () => {
    const current: CellSpec[] = [
      { tenant: A, language: 'zh', retrievals: 100, refused: 2, up: 40, down: 4 },
      { tenant: A, language: 'en', retrievals: 100, refused: 2, up: 40, down: 4 },
      { tenant: A, language: 'it', retrievals: 60, refused: 18, up: 40, down: 4 },
    ];
    const fake = fakeRpc({ current, baseline: healthy(A) });
    const act = activators();
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act));
    expect(result).toMatchObject({ ok: false, code: 'rollout_language_drop:it:refusal_rate' });
    expect(act.calls).toEqual([]);
    expect(fake.calls.some((call) => call.fn === 'rag_rollout_finish')).toBe(false);
  });

  it('rollout_language_drop compares per language, not the overall average', () => {
    // Overall refusal falls from 10 % to 7.4 %, yet one language doubles.
    const cells = (specs: CellSpec[]) =>
      specs.map((spec) => ({ ...row(spec), window: { since: '2026-11-01', until: '2026-11-09' } })) as never;
    const comparison = compareRolloutLanguages({
      languages: ['en', 'it'],
      cells: {
        candidateNow: cells([
          { tenant: A, language: 'en', retrievals: 400, refused: 20 },
          { tenant: A, language: 'it', retrievals: 100, refused: 17 },
        ]),
        candidateBefore: cells([
          { tenant: A, language: 'en', retrievals: 400, refused: 40 },
          { tenant: A, language: 'it', retrievals: 100, refused: 10 },
        ]),
        othersNow: [],
      },
      judge: null,
      policy: rolloutPolicy(),
    });
    expect(comparison.refusal).toBe('rollout_language_drop:it:refusal_rate');
  });

  it('rollout_monitoring_insufficient: en with 12 samples refuses', async () => {
    const current: CellSpec[] = [
      { tenant: A, language: 'zh', retrievals: 100, refused: 10 },
      { tenant: A, language: 'en', retrievals: 12, refused: 1 },
      { tenant: A, language: 'it', retrievals: 60, refused: 6 },
    ];
    const fake = fakeRpc({ current, baseline: healthy(A) });
    const act = activators();
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act));
    expect(result).toMatchObject({ ok: false, code: 'rollout_monitoring_insufficient:en' });
    expect(act.calls).toEqual([]);
  });

  it('an enabled language with no data at all blocks promotion', async () => {
    const fake = fakeRpc({ current: healthy(A).filter((c) => c.language !== 'it'), baseline: healthy(A) });
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, activators()));
    expect(result).toMatchObject({ ok: false, code: 'rollout_monitoring_insufficient:it' });
  });

  it('rollout_observation_too_short after 3 days, before any cell is read', async () => {
    const fake = fakeRpc({ current: healthy(A), baseline: healthy(A) });
    const act = activators();
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act, 3));
    expect(result).toEqual({ ok: false, code: 'rollout_observation_too_short' });
    expect(act.calls).toEqual([]);
    expect(fake.calls.map((call) => call.fn)).toEqual(['rag_rollout_active']);
  });

  it('returns the activation refusal external_not_ready:qdrant unchanged and leaves the rollout active', async () => {
    const fake = fakeRpc({ current: healthy(A), baseline: healthy(A) });
    const act = activators({ embeddingProfile: async () => ({ ok: false, code: 'external_not_ready:qdrant' }) });
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act));
    expect(result).toMatchObject({ ok: false, code: 'external_not_ready:qdrant' });
    expect(fake.calls.some((call) => call.fn === 'rag_rollout_finish')).toBe(false);
  });

  it('a rollout that is not active is refused', async () => {
    const fake = fakeRpc({ active: [], current: [], baseline: [] });
    expect(await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, activators()))).toEqual({ ok: false, code: 'rollout_not_active' });
  });

  it('share mode: the arm comes from the bucket, so cells are read for every tenant (never a client list)', async () => {
    const share = activeRow({ mode: 'share', share_percent: 100, included_tenants: [], excluded_tenants: [C] });
    const fake = fakeRpc({ active: [share], current: [...healthy(A), ...healthy(C)], baseline: [...healthy(A), ...healthy(C)] });
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, activators()));
    expect(result).toMatchObject({ ok: true, arms: { candidate: 1, incumbent: 1 } });
    for (const call of fake.calls.filter((c) => c.fn === 'rag_language_quality_cells')) expect(call.args.p_tenant_keys).toBeNull();
  });

  it('chunking_profile goes through the chunking activation; a refusal undoes the profiles already flipped', async () => {
    const chunk = activeRow({
      kind: 'chunking_profile',
      candidate_ref: { chunking_profile_ids: ['general:cp-b', 'faq:cp-c'] },
      chunking_map: { general: 'cp-b', faq: 'cp-c' },
    });
    const fake = fakeRpc({ active: [chunk], current: healthy(A), baseline: healthy(A) });
    const act = activators({
      chunkingProfile: async (entry) =>
        entry.profileId === 'cp-c' ? { ok: false, code: 'activation_refused: not_ready' } : { ok: true, docType: entry.docType!, changed: true },
    });
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act));
    expect(result).toMatchObject({ ok: false, code: 'activation_refused: not_ready' });
    expect(act.calls).toEqual(['chunking-rollback:general']);
  });

  it('rebuild_run goes through the rebuild activation and keeps its refusal', async () => {
    const rebuild = activeRow({ kind: 'rebuild_run', candidate_ref: { rebuild_run_id: '00000000-0000-4000-8000-0000000000bb' }, incumbent_ref: null });
    const fake = fakeRpc({ active: [rebuild], current: healthy(A), baseline: healthy(A) });
    const act = activators({ rebuildRun: async () => ({ ok: false, code: 'activation_refused:eval_failed' }) });
    expect(await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, act))).toMatchObject({ ok: false, code: 'activation_refused:eval_failed' });
  });

  it('judge score: worse by more than the band refuses; no judged answers leave it unmeasured', async () => {
    const judgeCells = (mean: number) => [{ tenant_key: A, language: 'en', judged: 40, score_sums: { faithfulness: mean * 40 } }];
    const fake = fakeRpc({ current: healthy(A), baseline: healthy(A) });
    const readJudge = vi.fn(async (window: { since: string }) => (window.since >= '2026-11-01' ? judgeCells(0.6) : judgeCells(0.9)));
    const result = await promoteRollout(ROLLOUT_ID, null, deps(fake.rpc, activators(), 8, { readJudge }));
    expect(result).toMatchObject({ ok: false, code: 'rollout_language_drop:en:judge_score' });

    const none = await promoteRollout(ROLLOUT_ID, null, deps(fakeRpc({ current: healthy(A), baseline: healthy(A) }).rpc, activators()));
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.languages[0]!.measures.find((m) => m.measure === 'judge_score')!.verdict).toBe('unmeasured');
  });

  it('list carries arms, keys and comparison but never the salt', async () => {
    const fake = fakeRpc({ current: [...healthy(A), ...healthy(B)], baseline: healthy(A) });
    const list = await listRollouts({ rpc: fake.rpc, now: () => START + 2 * DAY, languages: () => ['en'] });
    expect(list.policy).toEqual({ observationDays: 7, minSamples: 30 });
    expect(list.active[0]).toMatchObject({ id: ROLLOUT_ID, candidate: ['profile-b'], incumbent: ['profile-a'], included: [A], arms: { candidate: 1, incumbent: 1 } });
    expect(JSON.stringify(list)).not.toContain(SALT);
  });
});

describe('rag:rollout promote', () => {
  it('exits 0 on success and 2 with the refusal code otherwise', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    const ok = fakeRpc({ current: healthy(A), baseline: healthy(A) });
    const now = () => START + 8 * DAY;
    expect(await rolloutCli(['promote', ROLLOUT_ID], io, { rpc: ok.rpc, promote: { now, languages: () => ['en'], activate: activators() } })).toBe(0);
    expect(out.join('\n')).toContain('promoted');
    const short = fakeRpc({ current: healthy(A), baseline: healthy(A) });
    expect(await rolloutCli(['promote', ROLLOUT_ID], io, { rpc: short.rpc, promote: { now: () => START + DAY, activate: activators() } })).toBe(2);
    expect(err.join('\n')).toContain('rollout_observation_too_short');
    expect([...out, ...err].join('\n')).not.toContain(SALT);
  });
});
