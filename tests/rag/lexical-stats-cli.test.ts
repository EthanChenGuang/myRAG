import { describe, expect, it } from 'vitest';
import { parseLexstatsArgs, runLexstatsCli, USAGE, type LexstatsDeps } from '@/lib/rag/lexical/stats-cli';
import type { LexstatsDb, LexstatsQuery } from '@/lib/rag/lexical/stats-admin';

const TENANT_A = 'u:00000000-0000-4000-8000-0000000000a1';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b2';
const LINE_RE = /^[0-9a-f]{12} (building|ready|not_enabled) chunks=\d+ lexemes=\d+ pending=\d+/;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('parseLexstatsArgs', () => {
  it('accepts each sub-command with a tenant', () => {
    for (const command of ['enable', 'rebuild', 'compact', 'check', 'status', 'disable'] as const) {
      const parsed = parseLexstatsArgs([command, '--tenant', TENANT_A]);
      expect(parsed).toMatchObject({ ok: true, command, target: { kind: 'tenant', tenantKey: TENANT_A }, json: false, repair: false });
    }
  });

  it('accepts --all, --json, --repair with check and --max-rows with compact', () => {
    expect(parseLexstatsArgs(['status', '--all', '--json'])).toMatchObject({ ok: true, target: { kind: 'all' }, json: true });
    expect(parseLexstatsArgs(['check', '--all', '--repair'])).toMatchObject({ ok: true, repair: true });
    expect(parseLexstatsArgs(['compact', '--all', '--max-rows', '50000'])).toMatchObject({ ok: true, maxRows: 50000 });
    expect(parseLexstatsArgs(['compact', '--all'])).toMatchObject({ ok: true, maxRows: 5000 });
  });

  it.each([
    [[], 'missing sub-command'],
    [['purge', '--all'], 'unknown sub-command'],
    [['status'], 'missing target'],
    [['status', '--tenant', TENANT_A, '--all'], 'both targets'],
    [['status', '--tenant', TENANT_A, '--tenant', TENANT_B], 'tenant twice'],
    [['status', '--all', '--all'], 'all twice'],
    [['status', '--all', '--json', '--json'], 'json twice'],
    [['status', '--tenant'], 'tenant without value'],
    [['status', '--tenant', 'not-a-key'], 'bad tenant key'],
    [['compact', '--all', '--max-rows', '0'], 'max-rows 0'],
    [['compact', '--all', '--max-rows', '50001'], 'max-rows too big'],
    [['compact', '--all', '--max-rows', '1.5'], 'max-rows not integer'],
    [['compact', '--all', '--max-rows', '10', '--max-rows', '10'], 'max-rows twice'],
    [['status', '--all', '--max-rows', '10'], 'max-rows outside compact'],
    [['rebuild', '--all', '--repair'], 'repair outside check'],
    [['check', '--all', '--repair', '--repair'], 'repair twice'],
    [['disable', '--all'], 'disable --all'],
    [['status', '--all', '--verbose'], 'unknown option'],
    [['status', '--all', '--cluster'], 'cluster with status'],
    [['compact', '--all', '--cluster'], 'cluster with compact'],
    [['check', '--all', '--cluster', '--cluster'], 'cluster twice'],
    [['disable', '--all', '--cluster'], 'disable --all --cluster'],
  ])('rejects %j (%s)', (argv) => {
    expect(parseLexstatsArgs(argv as string[]).ok).toBe(false);
  });

  it('accepts --cluster with enable, rebuild, check and disable (04.4-17)', () => {
    for (const command of ['enable', 'rebuild', 'check', 'disable'] as const) {
      expect(parseLexstatsArgs([command, '--tenant', TENANT_A, '--cluster'])).toMatchObject({ ok: true, command, cluster: true });
    }
    expect(parseLexstatsArgs(['check', '--all', '--cluster', '--repair'])).toMatchObject({ ok: true, cluster: true, repair: true });
    expect(parseLexstatsArgs(['status', '--all'])).toMatchObject({ ok: true, cluster: false });
    expect(USAGE).toContain('--cluster');
  });

  it('a usage error exits 2 and prints the usage', async () => {
    const { io: cli, err } = io();
    const code = await runLexstatsCli(['disable', '--all'], cli, { db: fakeDb({}), scoringMode: 'ts_rank_cd' });
    expect(code).toBe(2);
    expect(err).toContain(USAGE);
  });
});

interface FakeTenant {
  state: 'building' | 'ready' | null;
  clean?: boolean;
  failRpc?: string;
}

/** Minimal LexstatsDb: the stats state table and the seven RPCs over an in-memory map. */
function fakeDb(tenants: Record<string, FakeTenant>, calls: string[] = []): LexstatsDb {
  const keys = () => Object.keys(tenants).sort();
  const query = (table: string): LexstatsQuery => {
    let after: string | null = null;
    let limit = 1000;
    const q: LexstatsQuery = {
      select: () => q,
      eq: () => q,
      in: () => q,
      gt: (_c: string, v: unknown) => {
        after = String(v);
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limit = n;
        return q;
      },
      then: (resolve, reject) => {
        const rows = keys()
          .filter((k) => (table === 'rag_lexical_stats_state' ? tenants[k]!.state !== null : true))
          .filter((k) => after === null || k > after)
          .slice(0, limit)
          .map((tenant_key) => ({ tenant_key }));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return {
    from: query,
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push(fn);
      const key = String(args.p_tenant_key);
      const t = tenants[key];
      const answer = (data: unknown, error: { code: string; message: string } | null = null) => Promise.resolve({ data, error });
      if (!t) return answer(null, { code: '22023', message: 'unknown' });
      if (t.failRpc === fn) return answer(null, { code: 'XX000', message: `secret detail ${key}` });
      switch (fn) {
        case 'rag_lexstats_enable':
          t.state = t.state ?? 'building';
          return answer(t.state);
        case 'rag_lexstats_rebuild':
          t.state = 'ready';
          return answer({ chunk_count: 3, lexeme_rows: 7, corpus_rows: 1 });
        case 'rag_lexstats_compact':
          return answer(0);
        case 'rag_lexstats_disable': {
          const had = t.state !== null;
          t.state = null;
          return answer(had);
        }
        case 'rag_lexstats_status':
          return answer({ state: t.state, chunk_count: 3, lexeme_count: 7, pending: 0, oldest_pending_age_s: null });
        case 'rag_lexstats_check':
          return answer({
            state: t.state,
            pending: 0,
            df_mismatch: 0,
            df_mismatch_with_pending: t.clean === false ? 2 : 0,
            chunk_count_diff: 0,
            chunk_count_diff_with_pending: 0,
            total_len_diff: 0,
            total_len_diff_with_pending: 0,
            clean: t.state === null ? null : t.clean !== false,
          });
        default:
          return answer(null, { code: '42883', message: 'missing' });
      }
    },
  };
}

describe('runLexstatsCli with a fake client', () => {
  it('status --all prints one hashed line per enabled tenant and no raw key', async () => {
    const { io: cli, out } = io();
    const deps: LexstatsDeps = { db: fakeDb({ [TENANT_A]: { state: 'ready' }, [TENANT_B]: { state: null } }), scoringMode: 'ts_rank_cd' };
    const code = await runLexstatsCli(['status', '--all'], cli, deps);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(LINE_RE);
    expect(out[0]).toMatch(/^[0-9a-f]{12} ready /);
    expect(out.join('\n')).not.toContain(TENANT_A);
  });

  it('status --tenant shows the named key and reports not_enabled', async () => {
    const { io: cli, out } = io();
    const code = await runLexstatsCli(['status', '--tenant', TENANT_B], cli, { db: fakeDb({ [TENANT_B]: { state: null } }), scoringMode: 'ts_rank_cd' });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^[0-9a-f]{12} not_enabled chunks=\d+ lexemes=\d+ pending=\d+/);
    expect(out[0]).toContain(TENANT_B);
  });

  it('--json prints the same as JSON lines', async () => {
    const { io: cli, out } = io();
    await runLexstatsCli(['status', '--all', '--json'], cli, { db: fakeDb({ [TENANT_A]: { state: 'ready' } }), scoringMode: 'ts_rank_cd' });
    const row = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(row).toMatchObject({ command: 'status', state: 'ready', chunks: 3, lexemes: 7, pending: 0 });
    expect(row.tenant).toMatch(/^[0-9a-f]{12}$/);
    expect(row).not.toHaveProperty('tenant_key');
    expect(out[0]).not.toContain(TENANT_A);
  });

  it('check exits 1 on drift, and on a not-ready tenant only under bm25', async () => {
    const drift = io();
    expect(await runLexstatsCli(['check', '--all'], drift.io, { db: fakeDb({ [TENANT_A]: { state: 'ready', clean: false } }), scoringMode: 'ts_rank_cd' })).toBe(1);
    expect(drift.out[0]).toMatch(LINE_RE);
    expect(drift.out[0]).toContain('clean=false');

    const notEnabled = { [TENANT_A]: { state: null } } as Record<string, FakeTenant>;
    expect(await runLexstatsCli(['check', '--tenant', TENANT_A], io().io, { db: fakeDb(notEnabled), scoringMode: 'ts_rank_cd' })).toBe(0);
    expect(await runLexstatsCli(['check', '--tenant', TENANT_A], io().io, { db: fakeDb(notEnabled), scoringMode: 'bm25' })).toBe(1);
    const building = { [TENANT_A]: { state: 'building' } } as Record<string, FakeTenant>;
    expect(await runLexstatsCli(['check', '--tenant', TENANT_A], io().io, { db: fakeDb(building), scoringMode: 'bm25' })).toBe(1);
  });

  it('enable rebuilds once more when the first check is not clean (D-18)', async () => {
    const calls: string[] = [];
    const tenants: Record<string, FakeTenant> = { [TENANT_A]: { state: null, clean: false } };
    const code = await runLexstatsCli(['enable', '--tenant', TENANT_A], io().io, { db: fakeDb(tenants, calls), scoringMode: 'ts_rank_cd' });
    expect(calls.filter((c) => c === 'rag_lexstats_rebuild')).toHaveLength(2);
    expect(calls.filter((c) => c === 'rag_lexstats_check')).toHaveLength(2);
    expect(code).toBe(1);
  });

  it('a failing RPC prints the rpc name and code only and the --all loop continues', async () => {
    const { io: cli, out, err } = io();
    const deps: LexstatsDeps = {
      db: fakeDb({ [TENANT_A]: { state: 'ready', failRpc: 'rag_lexstats_status' }, [TENANT_B]: { state: 'ready' } }),
      scoringMode: 'ts_rank_cd',
    };
    const code = await runLexstatsCli(['status', '--all'], cli, deps);
    expect(code).toBe(1);
    expect(err.some((l) => l.startsWith('[Lexical Stats]') && l.includes('rag_lexstats_status') && l.includes('XX000'))).toBe(true);
    expect(err.join('\n')).not.toContain('secret detail');
    expect(err.join('\n')).not.toContain(TENANT_A);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(LINE_RE);
  });
});
