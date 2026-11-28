import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { lexicalTokens } from '@/lib/rag/lexical/tokenize';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { maskPII } from '@/lib/rag/trace/mask';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { extractTerms, mineCandidates, readMisses, type MinerDb } from '@/lib/rag/terminology/mine/mine';
import { main, parseMineArgs } from '@/lib/rag/terminology/mine/cli';

/** D-26, D-25, PO-4: the miner over an in-memory copy of the 0473 functions. D-37: placeholder terms only; D-35: registry languages. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const TENANT_A = `u:${USER_A}`;
const TENANT_B = `u:${USER_B}`;
const SCOPES: Record<string, TenantScope> = {
  [TENANT_A]: mintScope('personal', USER_A, null),
  [TENANT_B]: mintScope('personal', USER_B, null),
};

type Row = Record<string, unknown>;

interface Miss {
  tenant_key: string;
  query_masked: string;
  language: string | null;
  source?: string;
}

interface Candidate {
  tenant_key: string;
  term: string;
  language: string;
  support: number;
  examples: string[];
  corpus_df: number;
  status: 'pending' | 'accepted' | 'dismissed';
  source: string;
  entry_id: string | null;
}

interface FakeDb {
  misses: Miss[];
  corpus: Record<string, string[]>;
  dictionary: Record<string, Row[]>;
  candidates: Map<string, Candidate>;
  calls: Array<{ fn: string; args: Row }>;
  tables: string[];
  db: MinerDb;
}

function thenable(outcome: unknown) {
  const request = {
    abortSignal: () => request,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
  };
  return request;
}

function fakeDb(): FakeDb {
  const fake: Omit<FakeDb, 'db'> = { misses: [], corpus: {}, dictionary: {}, candidates: new Map(), calls: [], tables: [] };
  const df = (tenant: string, token: string) => (fake.corpus[tenant] ?? []).filter((doc) => lexicalTokens(doc).includes(token)).length;
  const db = {
    rpc(fn: string, args: Row) {
      fake.calls.push({ fn, args });
      if (fn === 'rag_term_read_misses') {
        return thenable({ data: [...fake.misses].reverse().filter((miss) => miss.tenant_key === args.p_tenant_key).map((miss) => ({ ...miss, source: miss.source ?? 'miss_log' })), error: null });
      }
      if (fn === 'rag_term_effective') return thenable({ data: fake.dictionary[args.p_tenant_key as string] ?? [], error: null });
      if (fn === 'rag_term_corpus_df') {
        const tokens = args.p_tokens as string[];
        return thenable({ data: tokens.map((token) => ({ token, df: df(args.p_tenant_key as string, token) })), error: null });
      }
      if (fn === 'rag_term_purge_misses') return thenable({ data: 0, error: null });
      if (fn === 'rag_term_upsert_candidates') {
        const rows = args.p_rows as Row[];
        for (const row of rows) {
          expect(row).not.toHaveProperty('status');
          expect(row).not.toHaveProperty('entry_id');
          const key = `${args.p_tenant_key}|${row.language}|${row.term}`;
          const seen = fake.candidates.get(key);
          const next = { support: row.support as number, examples: row.examples as string[], corpus_df: row.corpus_df as number };
          if (seen) Object.assign(seen, next);
          else
            fake.candidates.set(key, {
              tenant_key: args.p_tenant_key as string,
              term: row.term as string,
              language: row.language as string,
              source: (row.source as string) ?? 'miss_log',
              status: 'pending',
              entry_id: null,
              ...next,
            });
        }
        return thenable({ data: rows.length, error: null });
      }
      return thenable({ data: null, error: { message: `unexpected ${fn}` } });
    },
    from(table: string) {
      fake.tables.push(table);
      const filters: { gt?: string } = {};
      const builder = {
        select: () => builder,
        gte: () => builder,
        gt(_column: string, value: string) {
          filters.gt = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
          const keys = [...new Set(fake.misses.map((miss) => miss.tenant_key))].sort().filter((key) => filters.gt === undefined || key > filters.gt);
          return Promise.resolve({ data: keys.slice(0, 1).map((tenant_key) => ({ tenant_key })), error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  } as unknown as MinerDb;
  return { ...fake, db };
}

const resolveScope = async (tenantKey: string) => SCOPES[tenantKey] ?? null;

function addMisses(fake: FakeDb, tenant: string, queries: string[], language: string | null = LATIN): void {
  for (const query of queries) fake.misses.push({ tenant_key: tenant, query_masked: query, language });
}

const LATIN_QUERIES = ['where is termdelta configured', 'termdelta rollout steps', 'who owns termdelta today'];
const HAN_QUERIES = ['术语丁戊怎么申请', '请说明术语丁戊流程', '术语丁戊在哪里找'];

function candidate(fake: FakeDb, tenant: string, language: string, term: string): Candidate | undefined {
  return fake.candidates.get(`${tenant}|${language}|${term}`);
}

let logged: string[];

beforeEach(() => {
  invalidateTerminologyCache('all');
  logged = [];
  for (const method of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractTerms', () => {
  it('keeps lexical tokens and Han 2-4-grams, never mask placeholders, digit-only terms or single Han characters', () => {
    const terms = extractTerms(`${maskPII('mail jane.doe@example.invalid about termdelta 20261126')} 术语丁戊`);
    expect(terms).toContain('termdelta');
    expect(terms).toContain('术语丁戊');
    expect(terms).toContain('术语丁');
    expect(terms).not.toContain('email');
    expect(terms).not.toContain('20261126');
    expect(terms.some((term) => /^\p{Script=Han}$/u.test(term))).toBe(false);
    expect(terms.every((term) => !term.includes('[') && !term.includes(']'))).toBe(true);
  });
});

describe('readMisses', () => {
  it('is the one reader of the miss source: each tenant read through rag_term_read_misses with the window', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, ['termdelta one']);
    addMisses(fake, TENANT_B, ['termdelta two']);
    const read = await readMisses(fake.db, { windowDays: 7 });
    expect(read.map((tenant) => tenant.tenantKey)).toEqual([TENANT_A, TENANT_B]);
    expect(read[0]!.misses.map((miss) => miss.query_masked)).toEqual(['termdelta one']);
    expect(fake.calls.filter((call) => call.fn === 'rag_term_read_misses').map((call) => call.args)).toEqual([
      { p_tenant_key: TENANT_A, p_window_days: 7 },
      { p_tenant_key: TENANT_B, p_window_days: 7 },
    ]);
    const one = await readMisses(fake.db, { tenantKey: TENANT_B, windowDays: 14 });
    expect(one.map((tenant) => tenant.tenantKey)).toEqual([TENANT_B]);
  });
});

describe('mineCandidates', () => {
  it('3 distinct misses with a Latin or Han placeholder term absent from the corpus give one candidate each, support 3, df 0', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    addMisses(fake, TENANT_A, HAN_QUERIES, HAN);
    fake.corpus[TENANT_A] = ['an unrelated synthetic sentence'];
    const report = await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    const latin = candidate(fake, TENANT_A, LATIN, 'termdelta');
    expect(latin).toMatchObject({ support: 3, corpus_df: 0, status: 'pending' });
    expect(latin!.examples.length).toBeLessThanOrEqual(3);
    expect(LATIN_QUERIES).toEqual(expect.arrayContaining(latin!.examples));
    const han = candidate(fake, TENANT_A, HAN, '术语丁戊');
    expect(han).toMatchObject({ support: 3, corpus_df: 0, status: 'pending' });
    // The shorter grams of the same queries collapse into the longest one.
    expect(candidate(fake, TENANT_A, HAN, '术语丁')).toBeUndefined();
    expect(candidate(fake, TENANT_A, HAN, '丁戊')).toBeUndefined();
    expect(report.tenants[0]).toMatchObject({ tenantKey: TENANT_A, misses: 6, distinctQueries: 6 });
    expect(fake.calls.some((call) => call.fn === 'rag_term_upsert_entry' || call.fn === 'rag_term_apply_import')).toBe(false);
  });

  it('two misses, or the same masked query three times, give no candidate', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES.slice(0, 2));
    addMisses(fake, TENANT_A, ['termepsilon now', 'termepsilon now', 'termepsilon now']);
    await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    expect(candidate(fake, TENANT_A, LATIN, 'termdelta')).toBeUndefined();
    expect(candidate(fake, TENANT_A, LATIN, 'termepsilon')).toBeUndefined();
  });

  it('a term that is a dictionary variant or canonical is never a candidate', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    addMisses(fake, TENANT_A, ['termzeta first', 'termzeta second', 'termzeta third']);
    addMisses(fake, TENANT_A, HAN_QUERIES, HAN);
    fake.dictionary[TENANT_A] = [
      { entry_id: 'e1', layer: 'shared', canonical: 'termzeta', variants: ['term zeta'], normalized_variants: ['term zeta'], language: LATIN, kind: 'synonym', mode: 'one_way' },
      { entry_id: 'e2', layer: 'workspace', canonical: 'term canon', variants: ['termdelta'], normalized_variants: ['termdelta'], language: LATIN, kind: 'synonym', mode: 'one_way' },
      { entry_id: 'e3', layer: 'workspace', canonical: '术语丁戊己', variants: ['术语庚'], normalized_variants: ['术语庚'], language: HAN, kind: 'synonym', mode: 'one_way' },
    ];
    await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    expect(candidate(fake, TENANT_A, LATIN, 'termdelta')).toBeUndefined();
    expect(candidate(fake, TENANT_A, LATIN, 'termzeta')).toBeUndefined();
    expect([...fake.candidates.values()].some((row) => row.language === HAN && '术语丁戊己'.includes(row.term))).toBe(false);
  });

  it('a term in more than two of the tenant\'s documents is dropped; one in two documents stays with df 2', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    addMisses(fake, TENANT_A, ['termeta first', 'termeta second', 'termeta third']);
    fake.corpus[TENANT_A] = ['termdelta one', 'termdelta two', 'termdelta three', 'termeta here', 'termeta there'];
    await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    expect(candidate(fake, TENANT_A, LATIN, 'termdelta')).toBeUndefined();
    expect(candidate(fake, TENANT_A, LATIN, 'termeta')).toMatchObject({ corpus_df: 2 });
    for (const call of fake.calls.filter((entry) => entry.fn === 'rag_term_corpus_df')) expect(call.args.p_tenant_key).toBe(TENANT_A);
  });

  it('mask placeholders and digit-only terms never become candidates', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, ['[EMAIL] 4417 alpha query', '[EMAIL] 4417 beta query', '[EMAIL] 4417 gamma query', '[PHONE] x', '[PHONE] y', '[PHONE] z']);
    await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    const terms = [...fake.candidates.values()].map((row) => row.term);
    expect(terms).not.toContain('email');
    expect(terms).not.toContain('phone');
    expect(terms).not.toContain('4417');
  });

  it('re-running updates support and keeps the status; a dismissed or accepted candidate stays as decided', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    addMisses(fake, TENANT_A, ['termtheta a', 'termtheta b', 'termtheta c']);
    await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    candidate(fake, TENANT_A, LATIN, 'termdelta')!.status = 'dismissed';
    Object.assign(candidate(fake, TENANT_A, LATIN, 'termtheta')!, { status: 'accepted', entry_id: 'e9' });
    addMisses(fake, TENANT_A, ['termdelta again here', 'termtheta d']);
    await mineCandidates({ db: fake.db, resolveScope, tenantKey: TENANT_A });
    expect(candidate(fake, TENANT_A, LATIN, 'termdelta')).toMatchObject({ support: 4, status: 'dismissed' });
    expect(candidate(fake, TENANT_A, LATIN, 'termtheta')).toMatchObject({ support: 4, status: 'accepted', entry_id: 'e9' });
    expect(fake.candidates.size).toBe(2);
  });

  it('tenant A\'s misses never produce candidates or df reads for tenant B', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    fake.corpus[TENANT_B] = ['termdelta one', 'termdelta two', 'termdelta three'];
    await mineCandidates({ db: fake.db, resolveScope });
    expect(candidate(fake, TENANT_A, LATIN, 'termdelta')).toMatchObject({ corpus_df: 0 });
    expect([...fake.candidates.values()].every((row) => row.tenant_key === TENANT_A)).toBe(true);
    expect(fake.calls.filter((call) => call.fn !== 'rag_term_purge_misses').every((call) => call.args.p_tenant_key === TENANT_A)).toBe(true);
  });

  it('purges with 30 before mining; a dry run purges nothing and writes nothing', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    await mineCandidates({ db: fake.db, resolveScope });
    expect(fake.calls[0]).toEqual({ fn: 'rag_term_purge_misses', args: { p_older_than_days: 30 } });

    const dry = fakeDb();
    addMisses(dry, TENANT_A, LATIN_QUERIES);
    const report = await mineCandidates({ db: dry.db, resolveScope, dryRun: true });
    expect(report.tenants[0]).toMatchObject({ tenantKey: TENANT_A, candidates: 1, upserted: 0 });
    expect(dry.calls.some((call) => call.fn === 'rag_term_purge_misses' || call.fn === 'rag_term_upsert_candidates')).toBe(false);
    expect(dry.candidates.size).toBe(0);
  });

  it('a tenant whose scope cannot be resolved is skipped; logs carry counts only', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    const report = await mineCandidates({ db: fake.db, resolveScope: async () => null });
    expect(report.tenants[0]).toMatchObject({ tenantKey: TENANT_A, error: 'scope_unavailable' });
    expect(fake.candidates.size).toBe(0);
    await mineCandidates({ db: fake.db, resolveScope });
    expect(logged.join('\n')).not.toMatch(/termdelta|configured|rollout/);
    expect(logged.join('\n')).not.toContain(USER_A);
  });
});

describe('rag:terms:mine CLI', () => {
  it('parses --tenant, --window-days, --min-support and --dry-run and refuses bad values', () => {
    expect(parseMineArgs([])).toEqual({ ok: true, tenantKey: null, windowDays: 14, minSupport: 3, dryRun: false });
    expect(parseMineArgs(['--tenant', TENANT_A, '--window-days', '7', '--min-support', '4', '--dry-run'])).toEqual({
      ok: true,
      tenantKey: TENANT_A,
      windowDays: 7,
      minSupport: 4,
      dryRun: true,
    });
    expect(parseMineArgs(['--tenant', 'nope']).ok).toBe(false);
    expect(parseMineArgs(['--window-days', '0']).ok).toBe(false);
    expect(parseMineArgs(['--window-days', '31']).ok).toBe(false);
    expect(parseMineArgs(['--min-support', '0']).ok).toBe(false);
    expect(parseMineArgs(['--dry-run', '--dry-run']).ok).toBe(false);
    expect(parseMineArgs(['--other']).ok).toBe(false);
  });

  it('a dry run prints counts per tenant and writes nothing', async () => {
    const fake = fakeDb();
    addMisses(fake, TENANT_A, LATIN_QUERIES);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['--dry-run'], { out: (line) => out.push(line), err: (line) => err.push(line) }, { db: fake.db, resolveScope });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('dry run, nothing written');
    expect(out.join('\n')).toContain(`${TENANT_A}: misses 3, distinct queries 3, would upsert 1`);
    expect(out.join('\n')).not.toContain('termdelta');
    expect(fake.calls.some((call) => call.fn === 'rag_term_purge_misses' || call.fn === 'rag_term_upsert_candidates')).toBe(false);
  });

  it('bad arguments exit 2', async () => {
    const err: string[] = [];
    expect(await main(['--window-days', 'x'], { out: () => undefined, err: (line) => err.push(line) })).toBe(2);
    expect(err.join('\n')).toContain('usage: npm run rag:terms:mine');
  });
});
