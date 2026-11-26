import { afterEach, describe, expect, test } from 'vitest';
import { RUN_AFTER, TABLE_ROWS_COMMAND, USAGE, main } from '@/lib/rag/tables/cli';
import {
  DEFAULT_LOOKUP_BACKFILL_BATCH_SIZE,
  LookupBackfillError,
  listBackfillTenants,
  parseLookupBackfillArgs,
  type TenantListingAdmin,
} from '@/lib/rag/ingest/lookup-backfill';

const TENANT = 'u:00000000-0000-4000-8000-0000000000a1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
}

describe('parseLookupBackfillArgs', () => {
  test('parses the tenant, dry run, batch size and resume cursor; no tenant means every tenant', () => {
    expect(parseLookupBackfillArgs([])).toEqual({ ok: true, dryRun: false, tenantKey: null, batchSize: DEFAULT_LOOKUP_BACKFILL_BATCH_SIZE, resumeAfter: null });
    expect(parseLookupBackfillArgs(['--dry-run', '--tenant', 'S:DEFAULT', '--batch-size', '50', '--resume-after', DOCUMENT])).toEqual({
      ok: true,
      dryRun: true,
      tenantKey: 's:default',
      batchSize: 50,
      resumeAfter: DOCUMENT,
    });
  });

  test.each([
    [['--tenant', 'tenant-a'], /tenant key/],
    [['--tenant', TENANT, '--tenant', TENANT], /twice/],
    [['--dry-run', '--dry-run'], /twice/],
    [['--batch-size', '5', '--batch-size', '6'], /twice/],
    [['--tenant', TENANT, '--verbose'], /unknown option/],
    [['--tenant'], /needs a value/],
    [['--tenant', '--dry-run'], /needs a value/],
    [['--batch-size', '0'], /--batch-size/],
    [['--batch-size', '1001'], /--batch-size/],
    [['--batch-size', '5x'], /--batch-size/],
    [['--tenant', TENANT, '--resume-after', 'not-a-uuid'], /--resume-after/],
    [['--resume-after', DOCUMENT], /needs --tenant/],
  ])('refuses %j', (argv, message) => {
    const parsed = parseLookupBackfillArgs(argv as string[]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(message);
  });
});

describe('rag:table-rows main', () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  });

  test('the command string is the UI-SPEC {tableRows} constant and the usage says when to run it', () => {
    expect(TABLE_ROWS_COMMAND).toBe('npm run rag:table-rows -- --tenant <key>');
    expect(USAGE).toMatch(/^usage: npm run rag:table-rows -- \[--tenant <key>\] \[--dry-run\]/);
    expect(RUN_AFTER).toMatch(/after npm run rag:rechunk and after identifier pattern changes/);
  });

  test('bad arguments exit 2 with the usage line and the run-after note', async () => {
    const { io, err } = capture();
    expect(await main(['--tenant', TENANT, '--bogus'], io)).toBe(2);
    expect(err).toContain(USAGE);
    expect(err).toContain(RUN_AFTER);
    expect(err[0]).toMatch(/^\[RAG Tables\] unknown option/);
  });

  test('a duplicate flag exits 2', async () => {
    const { io } = capture();
    expect(await main(['--dry-run', '--dry-run'], io)).toBe(2);
  });

  test('a missing service-role key exits 1 before any database work', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { io, err } = capture();
    expect(await main(['--tenant', TENANT], io)).toBe(1);
    expect(err.join('\n')).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('listBackfillTenants', () => {
  function fakeAdmin(keys: string[], seen: string[] = []): TenantListingAdmin {
    return {
      from: (table) => ({
        select: () => ({
          eq: () => ({
            gt: (_column, value) => ({
              order: () => ({
                limit: () => ({
                  abortSignal: async () => {
                    seen.push(`${table}>${value}`);
                    const next = keys.filter((key) => key > value).sort()[0];
                    return { data: next ? [{ tenant_key: next }] : [], error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    };
  }

  test('single-tenant mode covers s:default only and reads nothing', async () => {
    const seen: string[] = [];
    expect(await listBackfillTenants({ multiTenant: false, admin: fakeAdmin(['u:x'], seen), signal: new AbortController().signal })).toEqual(['s:default']);
    expect(seen).toEqual([]);
  });

  test('multi-tenant mode reads one distinct tenant key at a time in key order and skips malformed or single keys', async () => {
    const orgKey = 'o:00000000-0000-4000-8000-0000000000b1';
    const seen: string[] = [];
    const keys = await listBackfillTenants({ multiTenant: true, admin: fakeAdmin([TENANT, orgKey, 's:default', 'junk'], seen), signal: new AbortController().signal });
    expect(keys).toEqual([orgKey, TENANT]);
    expect(seen[0]).toBe('documents>');
  });

  test('multi-tenant mode without an admin client is a LookupBackfillError', async () => {
    await expect(listBackfillTenants({ multiTenant: true, admin: null, signal: new AbortController().signal })).rejects.toBeInstanceOf(LookupBackfillError);
  });
});
