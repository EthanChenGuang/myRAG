import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MiningRunResultSchema } from '@/lib/rag-eval/contracts.generated';
import { loadFeedbackMiningConfig } from '@/lib/rag/feedback-loop/config';
import {
  MAX_MINING_WINDOW_DAYS,
  MINING_RPC,
  MiningError,
  miningDisabledReason,
  parseMiningDate,
  runMining,
  tenantHash,
} from '@/lib/rag/feedback-loop/mining';
import { main as cliMain } from '@/lib/rag/feedback-loop/cli';

const TENANT_A = 'o:11111111-1111-4111-8111-111111111111';
const TENANT_B = 'u:22222222-2222-4222-8222-222222222222';
const ENABLED = { RAG_DOMAIN_EXPERT_REVIEW: 'true', RAG_RETRIEVAL_LOG: 'masked_query' };
const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const SECRET = 'placeholder-service-role-value-never-printed';

interface MineRow {
  tenant_key: string;
  reason: string;
  inserted: number;
  tenant_inserted: number;
}

interface Fake {
  client: SupabaseClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  deletes: string[];
}

/** rag_purge_retrieval_log answers 0, the mining function answers the given rows; every call is recorded in order. */
function fakeClient(rows: MineRow[] | { error: unknown } = []): Fake {
  const state: Fake = { client: null as unknown as SupabaseClient, calls: [], deletes: [] };
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      state.calls.push({ name, args });
      if (name === 'rag_purge_retrieval_log') return Promise.resolve({ data: 0, error: null });
      if (!Array.isArray(rows)) return Promise.resolve({ data: null, error: rows.error });
      return Promise.resolve({ data: rows, error: null });
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ['delete', 'eq', 'lt']) builder[method] = () => builder;
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        state.deletes.push(table);
        state.calls.push({ name: `delete:${table}`, args: {} });
        return Promise.resolve({ error: null, count: 2 }).then(onFulfilled, onRejected);
      };
      return builder;
    },
  };
  state.client = client as unknown as SupabaseClient;
  return state;
}

const ROWS: MineRow[] = [
  { tenant_key: TENANT_A, reason: 'feedback_negative', inserted: 2, tenant_inserted: 3 },
  { tenant_key: TENANT_A, reason: 'low_score', inserted: 2, tenant_inserted: 3 },
  { tenant_key: TENANT_A, reason: 'no_source_opened', inserted: 1, tenant_inserted: 3 },
  { tenant_key: TENANT_B, reason: 'zero_results', inserted: 1, tenant_inserted: 1 },
];

describe('runMining (D-13, D-15)', () => {
  it('is disabled unless RAG_DOMAIN_EXPERT_REVIEW is true and RAG_RETRIEVAL_LOG is masked_query, and then makes no call', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, 'domain_expert_review_off'],
      [{ RAG_RETRIEVAL_LOG: 'masked_query' }, 'domain_expert_review_off'],
      [{ RAG_DOMAIN_EXPERT_REVIEW: 'true' }, 'retrieval_log_not_masked_query'],
      [{ RAG_DOMAIN_EXPERT_REVIEW: 'true', RAG_RETRIEVAL_LOG: 'ids' }, 'retrieval_log_not_masked_query'],
    ];
    for (const [env, reason] of cases) {
      const fake = fakeClient(ROWS);
      let loaded = false;
      const result = await runMining(
        {},
        {
          client: fake.client,
          env,
          now: () => NOW,
          log: () => undefined,
          loadConfig: () => {
            loaded = true;
            return loadFeedbackMiningConfig();
          },
        },
      );
      expect(result.status).toBe('disabled');
      expect(result.disabled_reason).toBe(reason);
      expect(result.tenants ?? []).toEqual([]);
      expect(result.total_inserted).toBe(0);
      expect(fake.calls).toEqual([]);
      expect(loaded).toBe(false);
      expect(MiningRunResultSchema.safeParse(result).success).toBe(true);
      expect(miningDisabledReason(env)).toBe(reason);
    }
    expect(miningDisabledReason(ENABLED)).toBeNull();
  });

  it('purges first, then calls the mining function with the parsed config and the source-open switch', async () => {
    const fake = fakeClient(ROWS);
    const since = new Date('2026-11-16T00:00:00.000Z');
    const until = new Date('2026-11-23T00:00:00.000Z');
    await runMining({ since, until }, { client: fake.client, env: { ...ENABLED, RAG_SOURCE_OPEN_SIGNAL: 'true', RAG_RETRIEVAL_LOG_RETENTION_DAYS: '14' }, log: () => undefined });
    expect(fake.calls.map((call) => call.name)).toEqual(['rag_purge_retrieval_log', 'delete:rag_review_items', MINING_RPC]);
    expect(fake.calls[0]!.args).toMatchObject({ p_retention_days: 14 });
    const { config } = loadFeedbackMiningConfig();
    expect(fake.calls[2]!.args).toEqual({
      p_since: '2026-11-16T00:00:00.000Z',
      p_until: '2026-11-23T00:00:00.000Z',
      p_config: { ...config, source_open_signal: true },
    });
  });

  it('maps the rows into a MiningRunResult with tenant hashes, per-reason counts, the config sha256 and the window', async () => {
    const fake = fakeClient(ROWS);
    const lines: string[] = [];
    const since = new Date('2026-11-16T00:00:00.000Z');
    const until = new Date('2026-11-23T00:00:00.000Z');
    const result = await runMining({ since, until }, { client: fake.client, env: ENABLED, log: (line) => lines.push(line) });
    expect(MiningRunResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.disabled_reason).toBeNull();
    expect(result.since).toBe('2026-11-16T00:00:00.000Z');
    expect(result.until).toBe('2026-11-23T00:00:00.000Z');
    expect(result.config_sha256).toBe(loadFeedbackMiningConfig().sha256);
    expect(result.purged_log_rows).toBe(0);
    expect(result.purged_review_items).toBe(2);
    expect(result.total_inserted).toBe(4);
    const byHash = new Map((result.tenants ?? []).map((tenant) => [tenant.tenant_hash, tenant]));
    expect(byHash.get(tenantHash(TENANT_A))).toEqual({
      tenant_hash: tenantHash(TENANT_A),
      inserted: 3,
      by_reason: {
        feedback_negative: 2,
        refusal_disputed: 0,
        groundedness_flagged: 0,
        refused_high_score: 0,
        zero_results: 0,
        low_score: 2,
        no_source_opened: 1,
      },
    });
    expect(byHash.get(tenantHash(TENANT_B))?.inserted).toBe(1);
    expect(byHash.get(tenantHash(TENANT_B))?.by_reason.zero_results).toBe(1);

    const text = JSON.stringify(result) + lines.join('\n');
    for (const key of [TENANT_A, TENANT_B]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.slice(2));
    }
    expect(lines.filter((line) => line.startsWith('[Feedback Loop] mining'))).toHaveLength(1);
  });

  it('hashes a tenant key to a sha256 prefix', () => {
    const full = createHash('sha256').update(TENANT_A).digest('hex');
    expect(tenantHash(TENANT_A)).toMatch(/^[a-f0-9]{16}$/);
    expect(full.startsWith(tenantHash(TENANT_A))).toBe(true);
    expect(tenantHash(TENANT_A)).not.toBe(tenantHash(TENANT_B));
  });

  it('defaults until to now and since to until minus window_days', async () => {
    const fake = fakeClient([]);
    const result = await runMining({}, { client: fake.client, env: ENABLED, now: () => NOW, log: () => undefined });
    const windowDays = loadFeedbackMiningConfig().config.window_days;
    expect(result.until).toBe(new Date(NOW).toISOString());
    expect(result.since).toBe(new Date(NOW - windowDays * 86_400_000).toISOString());
    expect(result.tenants).toEqual([]);
    expect(result.total_inserted).toBe(0);
  });

  it('refuses an empty, reversed or over-long window before any call', async () => {
    const until = new Date('2026-11-23T00:00:00.000Z');
    for (const since of [until, new Date('2026-11-24T00:00:00.000Z'), new Date(until.getTime() - (MAX_MINING_WINDOW_DAYS + 1) * 86_400_000)]) {
      const fake = fakeClient(ROWS);
      await expect(runMining({ since, until }, { client: fake.client, env: ENABLED, log: () => undefined })).rejects.toBeInstanceOf(MiningError);
      expect(fake.calls).toEqual([]);
    }
  });

  it('throws a MiningError with the code only when the function fails or answers rows of the wrong shape', async () => {
    const failing = fakeClient({ error: { code: '42501', message: 'secret detail' } });
    const error = await runMining({}, { client: failing.client, env: ENABLED, log: () => undefined }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MiningError);
    expect((error as MiningError).code).toBe('42501');
    expect(String((error as Error).message)).not.toContain('secret detail');

    const odd = fakeClient([{ tenant_key: TENANT_A, reason: 'made_up', inserted: 1, tenant_inserted: 1 }]);
    await expect(runMining({}, { client: odd.client, env: ENABLED, log: () => undefined })).rejects.toMatchObject({ code: 'unexpected_result' });
  });

  it('parses YYYY-MM-DD as UTC midnight and rejects anything else', () => {
    expect(parseMiningDate('2026-11-01')?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    for (const text of ['tomorrow', '2026-13-01', '2026-02-30', '2026-1-1', '', '01/11/2026']) expect(parseMiningDate(text)).toBeNull();
  });
});

describe('rag:feedback-loop mine', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
  }
  const BASE_ENV = { NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: SECRET, ...ENABLED };

  it('prints the MiningRunResult as JSON with tenant hashes and no tenant key, and exits 0', async () => {
    const fake = fakeClient(ROWS);
    const { io: sink, out, err } = io();
    const code = await cliMain(['mine', '--since', '2026-11-01', '--until', '2026-11-08'], sink, { env: BASE_ENV, createClient: () => fake.client });
    expect(code).toBe(0);
    const parsed = MiningRunResultSchema.parse(JSON.parse(out.join('\n')));
    expect(parsed.status).toBe('completed');
    expect(parsed.since).toBe('2026-11-01T00:00:00.000Z');
    expect(parsed.until).toBe('2026-11-08T00:00:00.000Z');
    expect(parsed.total_inserted).toBe(4);
    const text = [...out, ...err].join('\n');
    for (const key of [TENANT_A, TENANT_B]) expect(text).not.toContain(key.slice(2));
    expect(text).not.toContain(SECRET);
  });

  it('accepts --since alone with until defaulting to now', async () => {
    const fake = fakeClient([]);
    const { io: sink, out } = io();
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    expect(await cliMain(['mine', '--since', since], sink, { env: BASE_ENV, createClient: () => fake.client })).toBe(0);
    expect(JSON.parse(out.join('\n')).since).toBe(`${since}T00:00:00.000Z`);
  });

  it('exits 2 for an invalid date, a missing value, an unknown flag, a reversed or an over-long window', async () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    for (const argv of [
      ['mine', '--since', 'tomorrow'],
      ['mine', '--since'],
      ['mine', '--since', '2026-11-01', '--extra'],
      ['mine', '--since', '2026-11-08', '--until', '2026-11-01'],
      ['mine', '--since', '2026-01-01', '--until', '2026-11-01'],
      ['mine', '--since', future],
    ]) {
      const fake = fakeClient(ROWS);
      const { io: sink } = io();
      expect(await cliMain(argv, sink, { env: BASE_ENV, createClient: () => fake.client })).toBe(2);
      expect(fake.calls).toEqual([]);
    }
  });

  it('prints a disabled result and calls nothing when review is off', async () => {
    const fake = fakeClient(ROWS);
    const { io: sink, out } = io();
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: SECRET };
    expect(await cliMain(['mine', '--since', '2026-11-01'], sink, { env, createClient: () => fake.client })).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'disabled', disabled_reason: 'domain_expert_review_off' });
    expect(fake.calls).toEqual([]);
  });

  it('exits 1 with the code only when mining fails', async () => {
    const fake = fakeClient({ error: { code: 'PGRST202', message: 'secret detail' } });
    const { io: sink, out, err } = io();
    expect(await cliMain(['mine', '--since', '2026-11-01', '--until', '2026-11-08'], sink, { env: BASE_ENV, createClient: () => fake.client })).toBe(1);
    expect(err.join('\n')).toContain('PGRST202');
    expect([...out, ...err].join('\n')).not.toContain('secret detail');
  });
});
