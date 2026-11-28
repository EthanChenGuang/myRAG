import { afterEach, describe, expect, test } from 'vitest';
import { CACHE_EFFECT, IDENTIFIERS_COMMAND, RUN_AFTER, USAGE, main } from '@/lib/rag/identifiers/cli';

const TENANT = 'o:00000000-0000-4000-8000-0000000000b1';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
}

describe('rag:identifiers main', () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  });

  test('the command string is the UI-SPEC {identifiers} constant; usage, run-after and cache lines', () => {
    expect(IDENTIFIERS_COMMAND).toBe('npm run rag:identifiers -- --tenant <key>');
    expect(USAGE).toMatch(/^usage: npm run rag:identifiers -- \[--tenant <key>\] \[--dry-run\] \[--batch-size 100\] \[--resume-after <documentId>\]$/);
    expect(RUN_AFTER).toMatch(/after npm run rag:rechunk and after identifier pattern changes/);
    expect(CACHE_EFFECT).toMatch(/^semantic cache: unaffected/);
  });

  test.each([
    [['--tenant', TENANT, '--tenant', TENANT]],
    [['--tenant', 'o:not-a-uuid']],
    [['--batch-size', '-1']],
    [['--resume-after', '00000000-0000-4000-8000-0000000000d1']],
    [['--what']],
  ])('bad arguments %j exit 2 with the usage line', async (argv) => {
    const { io, err } = capture();
    expect(await main(argv as string[], io)).toBe(2);
    expect(err[0]).toMatch(/^\[RAG Identifiers\] /);
    expect(err).toContain(USAGE);
  });

  test('a missing service-role key exits 1 before any database work', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { io, err } = capture();
    expect(await main(['--tenant', TENANT, '--dry-run'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
