import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BRIDGE_REASONS,
  MISS_RECORDER_RPC,
  bridgeToTerminologyMisses,
  miningWindowStart,
} from '@/lib/rag/feedback-loop/terminology-bridge';
import { runMining } from '@/lib/rag/feedback-loop/mining';

const TENANT_A = 'o:11111111-1111-4111-8111-111111111111';
const TENANT_B = 'u:22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const RUN_AT = '2026-11-25T10:00:01.000+00:00';
const EARLIER = '2026-11-24T09:00:00.000+00:00';
const ENABLED = { RAG_DOMAIN_EXPERT_REVIEW: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_TERMINOLOGY_MINING: 'true' };
const ROW_KEYS = ['language', 'profile', 'query_masked', 'retrieval_config_hash', 'source', 'status', 'top_score'];

interface Item {
  tenant_key: string;
  query_masked: string;
  query_language: string | null;
  channel: string | null;
  outcome: string | null;
  retrieval_config_hash: string | null;
  reasons: string[];
  mined_at: string;
  user_id?: string;
  chat_id?: string;
  candidates?: unknown[];
  rag_retrieval_log: { tenant_key: string; status: string; top_score: number | null } | null;
}

interface Call {
  name: string;
  args: Record<string, unknown>;
}

interface Query {
  table: string;
  select: string;
  eq: Array<[string, unknown]>;
  limit: number | null;
}

interface FakeOptions {
  items?: Item[];
  recorder?: 'ok' | 'missing' | 'fail' | 'throw';
  mineRows?: Array<{ tenant_key: string; reason: string; inserted: number; tenant_inserted: number }>;
}

function item(tenant: string, query: string, reasons: string[], extra: Partial<Item> = {}): Item {
  return {
    tenant_key: tenant,
    query_masked: query,
    query_language: 'en',
    channel: 'chat',
    outcome: 'refused_no_context',
    retrieval_config_hash: 'cfg-hash-1',
    reasons,
    mined_at: RUN_AT,
    user_id: '33333333-3333-4333-8333-333333333333',
    chat_id: '44444444-4444-4444-8444-444444444444',
    candidates: [{ chunk_id: 'c1', document_id: '55555555-5555-4555-8555-555555555555', rank: 1, similarity: 0.4, kept: false }],
    rag_retrieval_log: { tenant_key: tenant, status: 'empty', top_score: 0.42 },
    ...extra,
  };
}

function fakeClient(options: FakeOptions = {}) {
  const items = options.items ?? [];
  const calls: Call[] = [];
  const queries: Query[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === 'rag_purge_retrieval_log') return Promise.resolve({ data: 0, error: null });
      if (name === 'rag_mine_failed_queries_report') return Promise.resolve({ data: options.mineRows ?? [], error: null });
      if (name === MISS_RECORDER_RPC) {
        if (options.recorder === 'missing') return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'not found' } });
        if (options.recorder === 'fail') return Promise.resolve({ data: null, error: { code: 'P0001', message: 'invalid_miss' } });
        if (options.recorder === 'throw') return Promise.reject(new Error('network down'));
        return Promise.resolve({ data: '66666666-6666-4666-8666-666666666666', error: null });
      }
      return Promise.resolve({ data: null, error: { code: 'unexpected' } });
    },
    from(table: string) {
      const query: Query = { table, select: '', eq: [], limit: null };
      const builder: Record<string, unknown> = {};
      builder.select = (columns: string) => {
        query.select = columns;
        return builder;
      };
      builder.delete = () => builder;
      builder.lt = () => builder;
      builder.order = () => builder;
      builder.eq = (column: string, value: unknown) => {
        query.eq.push([column, value]);
        return builder;
      };
      builder.limit = (n: number) => {
        query.limit = n;
        return builder;
      };
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        if (!query.select) return Promise.resolve({ error: null, count: 0 }).then(onFulfilled, onRejected);
        queries.push(query);
        const tenant = query.eq.find(([column]) => column === 'tenant_key')?.[1];
        const rows = items
          .filter((row) => row.tenant_key === tenant)
          .sort((a, b) => b.mined_at.localeCompare(a.mined_at))
          .slice(0, query.limit ?? undefined);
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls, queries };
}

function recorderCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.name === MISS_RECORDER_RPC);
}

const UNTIL = new Date(NOW);

describe('bridgeToTerminologyMisses (D-17, Phase 4.1.1 D-25)', () => {
  it('records one feedback miss per eligible new item under that item\'s own tenant key, and skips low_score-only items', async () => {
    const fake = fakeClient({
      items: [
        item(TENANT_A, 'synthetic question alpha', ['feedback_negative', 'low_score']),
        item(TENANT_A, 'synthetic question beta', ['low_score'], { outcome: 'answered' }),
        item(TENANT_B, 'synthetic question gamma', ['zero_results'], { outcome: 'unknown', rag_retrieval_log: null }),
        item(TENANT_B, 'synthetic question delta', ['refusal_disputed']),
      ],
    });
    const lines: string[] = [];
    const counts = await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 2 }, { tenantKey: TENANT_B, inserted: 2 }] },
      { client: fake.client, enabled: true, log: (line) => lines.push(line) },
    );
    const calls = recorderCalls(fake.calls);
    expect(calls).toHaveLength(3);
    expect(counts).toEqual({ recorded: 3, skipped: 1, failed: 0 });
    const byQuery = new Map(calls.map((call) => [(call.args.p_row as Record<string, unknown>).query_masked, call.args]));
    expect(byQuery.get('synthetic question alpha')?.p_tenant_key).toBe(TENANT_A);
    expect(byQuery.get('synthetic question gamma')?.p_tenant_key).toBe(TENANT_B);
    expect(byQuery.get('synthetic question delta')?.p_tenant_key).toBe(TENANT_B);
    expect(byQuery.has('synthetic question beta')).toBe(false);
    expect(byQuery.get('synthetic question alpha')?.p_row).toEqual({
      source: 'feedback',
      query_masked: 'synthetic question alpha',
      language: 'en',
      status: 'empty',
      top_score: 0.42,
      retrieval_config_hash: 'cfg-hash-1',
      profile: 'chat',
    });
    expect(byQuery.get('synthetic question gamma')?.p_row).toMatchObject({ status: 'empty', top_score: null });
    for (const call of calls) {
      expect(Object.keys(call.args).sort()).toEqual(['p_row', 'p_tenant_key']);
      expect(Object.keys(call.args.p_row as object).sort()).toEqual(ROW_KEYS);
    }
    expect(lines.join('\n')).not.toContain('synthetic question');
  });

  it('reads each tenant only under its own key and this run\'s mining week, and never touches the candidate or dictionary tables', async () => {
    const fake = fakeClient({ items: [item(TENANT_A, 'synthetic question alpha', ['feedback_negative'])] });
    await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }, { tenantKey: TENANT_B, inserted: 0 }] },
      { client: fake.client, enabled: true, log: () => undefined },
    );
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].table).toBe('rag_review_items');
    expect(fake.queries[0].eq).toEqual([
      ['tenant_key', TENANT_A],
      ['mining_window', '2026-11-23T00:00:00.000Z'],
    ]);
    expect(fake.queries.every((query) => !/rag_term_/.test(query.table))).toBe(true);
    expect(fake.calls.every((call) => call.name === MISS_RECORDER_RPC)).toBe(true);
  });

  it('drops a fetched row whose tenant or retrieval-log tenant differs from the tenant being bridged', async () => {
    const fake = fakeClient({
      items: [
        item(TENANT_A, 'synthetic question alpha', ['feedback_negative'], {
          rag_retrieval_log: { tenant_key: TENANT_B, status: 'ok', top_score: 0.9 },
        }),
      ],
    });
    await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }] },
      { client: fake.client, enabled: true, log: () => undefined },
    );
    const calls = recorderCalls(fake.calls);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_tenant_key).toBe(TENANT_A);
    expect(calls[0].args.p_row).toMatchObject({ status: 'empty', top_score: null });
  });

  it('bridges only the rows of this run: older items of the same week are not copied again', async () => {
    const fake = fakeClient({
      items: [
        item(TENANT_A, 'synthetic question new', ['feedback_negative']),
        item(TENANT_A, 'synthetic question old', ['feedback_negative'], { mined_at: EARLIER }),
      ],
    });
    await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }] },
      { client: fake.client, enabled: true, log: () => undefined },
    );
    const queries = recorderCalls(fake.calls).map((call) => (call.args.p_row as Record<string, unknown>).query_masked);
    expect(queries).toEqual(['synthetic question new']);
  });

  it('skips a tenant whose fetched rows do not match the run count', async () => {
    const fake = fakeClient({ items: [item(TENANT_A, 'synthetic question old', ['feedback_negative'], { mined_at: EARLIER })] });
    const lines: string[] = [];
    const counts = await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 2 }] },
      { client: fake.client, enabled: true, log: (line) => lines.push(line) },
    );
    expect(recorderCalls(fake.calls)).toHaveLength(0);
    expect(counts.recorded).toBe(0);
  });

  it('cuts the masked query to 500 characters and keeps a lower-case language tag', async () => {
    const long = 'synthetic '.repeat(80);
    const fake = fakeClient({ items: [item(TENANT_A, long, ['zero_results'], { query_language: 'zh-Hans', channel: 'voice' })] });
    await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }] },
      { client: fake.client, enabled: true, log: () => undefined },
    );
    const row = recorderCalls(fake.calls)[0].args.p_row as Record<string, unknown>;
    expect(Array.from(row.query_masked as string)).toHaveLength(500);
    expect(row.language).toBe('zh-hans');
    expect(row.profile).toBe('voice');
  });

  it('does nothing with terminology mining off, and logs one skip line', async () => {
    const fake = fakeClient({ items: [item(TENANT_A, 'synthetic question alpha', ['feedback_negative'])] });
    const lines: string[] = [];
    await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }] },
      { client: fake.client, enabled: false, log: (line) => lines.push(line) },
    );
    expect(fake.calls).toHaveLength(0);
    expect(fake.queries).toHaveLength(0);
    expect(lines).toEqual(['[Feedback Loop] terminology bridge skipped (terminology_mining_off)']);
  });

  it('stops after the first call when the recorder does not exist, with one skip line', async () => {
    const fake = fakeClient({
      recorder: 'missing',
      items: [
        item(TENANT_A, 'synthetic question alpha', ['feedback_negative']),
        item(TENANT_B, 'synthetic question gamma', ['zero_results']),
      ],
    });
    const lines: string[] = [];
    await bridgeToTerminologyMisses(
      { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }, { tenantKey: TENANT_B, inserted: 1 }] },
      { client: fake.client, enabled: true, log: (line) => lines.push(line) },
    );
    expect(recorderCalls(fake.calls)).toHaveLength(1);
    expect(lines).toEqual(['[Feedback Loop] terminology bridge skipped (recorder_missing)']);
  });

  it('never rejects when the recorder fails or throws', async () => {
    for (const recorder of ['fail', 'throw'] as const) {
      const fake = fakeClient({ recorder, items: [item(TENANT_A, 'synthetic question alpha', ['feedback_negative'])] });
      const lines: string[] = [];
      const counts = await bridgeToTerminologyMisses(
        { until: UNTIL, tenants: [{ tenantKey: TENANT_A, inserted: 1 }] },
        { client: fake.client, enabled: true, log: (line) => lines.push(line) },
      );
      expect(counts).toEqual({ recorded: 0, skipped: 0, failed: 1 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('synthetic question');
    }
  });

  it('the bridged reasons are exactly feedback_negative, refusal_disputed and zero_results', () => {
    expect([...BRIDGE_REASONS].sort()).toEqual(['feedback_negative', 'refusal_disputed', 'zero_results']);
  });

  it('the mining week is the UTC Monday of until', () => {
    expect(miningWindowStart(new Date('2026-11-29T23:59:59.000Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(miningWindowStart(new Date('2026-11-23T00:00:00.000Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });
});

describe('runMining with the terminology bridge', () => {
  const mineRows = [
    { tenant_key: TENANT_A, reason: 'feedback_negative', inserted: 1, tenant_inserted: 1 },
    { tenant_key: TENANT_B, reason: 'zero_results', inserted: 1, tenant_inserted: 1 },
  ];
  const items = [
    item(TENANT_A, 'synthetic question alpha', ['feedback_negative']),
    item(TENANT_B, 'synthetic question gamma', ['zero_results']),
  ];

  async function run(env: Record<string, string>, recorder: FakeOptions['recorder'] = 'ok') {
    const fake = fakeClient({ items, mineRows, recorder });
    const lines: string[] = [];
    const result = await runMining(
      { until: UNTIL },
      {
        client: fake.client,
        env,
        now: () => NOW,
        log: (line) => lines.push(line),
        loadConfig: () => ({ config: { window_days: 7 } as never, sha256: 'a'.repeat(64) }),
        purge: async () => ({ logRows: 0, reviewItems: 0 }),
      },
    );
    return { fake, lines, result };
  }

  it('bridges the run\'s items per tenant after the mining rpc when RAG_TERMINOLOGY_MINING is true', async () => {
    const { fake, result } = await run(ENABLED);
    expect(result.status).toBe('completed');
    const names = fake.calls.map((call) => call.name);
    expect(names.indexOf(MISS_RECORDER_RPC)).toBeGreaterThan(names.indexOf('rag_mine_failed_queries_report'));
    expect(recorderCalls(fake.calls).map((call) => call.args.p_tenant_key).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it('makes no recorder call with RAG_TERMINOLOGY_MINING unset or false', async () => {
    for (const value of [undefined, 'false']) {
      const env: Record<string, string> = { ...ENABLED };
      if (value === undefined) delete env.RAG_TERMINOLOGY_MINING;
      else env.RAG_TERMINOLOGY_MINING = value;
      const { fake, lines } = await run(env);
      expect(recorderCalls(fake.calls)).toHaveLength(0);
      expect(fake.queries).toHaveLength(0);
      expect(lines.filter((line) => line.includes('terminology bridge'))).toEqual([
        '[Feedback Loop] terminology bridge skipped (terminology_mining_off)',
      ]);
    }
  });

  it('returns the same result whether the recorder works, is missing, fails or throws', async () => {
    const ok = await run(ENABLED, 'ok');
    for (const recorder of ['missing', 'fail', 'throw'] as const) {
      const other = await run(ENABLED, recorder);
      expect(other.result).toEqual(ok.result);
    }
    const off = await run({ ...ENABLED, RAG_TERMINOLOGY_MINING: 'false' });
    expect(off.result).toEqual(ok.result);
  });
});
