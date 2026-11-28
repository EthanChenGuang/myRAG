import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_DUP_CLUSTER_BATCH_SIZE, USAGE, main, parseDupClusterArgs } from '@/lib/rag/dedupe/cli';

const TENANT = 'u:00000000-0000-4000-8000-0000000000a1';
const CHUNK = '00000000-0000-4000-8000-0000000000e1';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
}

describe('parseDupClusterArgs', () => {
  test('parses the tenant, dry run, batch size and resume cursor', () => {
    expect(parseDupClusterArgs(['--tenant', TENANT])).toEqual({
      ok: true,
      dryRun: false,
      tenantKey: TENANT,
      batchSize: DEFAULT_DUP_CLUSTER_BATCH_SIZE,
      resumeAfter: null,
    });
    expect(parseDupClusterArgs(['--dry-run', '--tenant', 's:default', '--batch-size', '50', '--resume-after', CHUNK])).toEqual({
      ok: true,
      dryRun: true,
      tenantKey: 's:default',
      batchSize: 50,
      resumeAfter: CHUNK,
    });
  });

  test.each([
    [[], /--tenant/],
    [['--tenant', 'tenant-a'], /tenant key/],
    [['--tenant', TENANT, '--tenant', TENANT], /twice/],
    [['--tenant', TENANT, '--dry-run', '--dry-run'], /twice/],
    [['--tenant', TENANT, '--verbose'], /unknown option/],
    [['--tenant'], /needs a value/],
    [['--tenant', TENANT, '--batch-size', '0'], /--batch-size/],
    [['--tenant', TENANT, '--batch-size', '1001'], /--batch-size/],
    [['--tenant', TENANT, '--batch-size', '5x'], /--batch-size/],
    [['--tenant', TENANT, '--resume-after', 'not-a-uuid'], /--resume-after/],
  ])('refuses %j', (argv, message) => {
    const parsed = parseDupClusterArgs(argv as string[]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(message);
  });
});

describe('main', () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  });

  test('bad arguments exit 2 with the usage line', async () => {
    const { io, err } = capture();
    expect(await main(['--tenant', TENANT, '--bogus'], io)).toBe(2);
    expect(err).toContain(USAGE);
    expect(USAGE).toMatch(/npm run rag:dup-clusters -- --tenant <key>/);
  });

  test('a missing service-role key exits 1 before any database work', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { io, err } = capture();
    expect(await main(['--tenant', TENANT], io)).toBe(1);
    expect(err.join('\n')).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
