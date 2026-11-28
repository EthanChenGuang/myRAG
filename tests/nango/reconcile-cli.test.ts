import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSourceReconcile = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nango/reconcile', () => {
  class SourceReconcileDatabaseError extends Error {
    readonly code: string | null;
    constructor(code: string | null) {
      super('source_reconcile_database_error');
      this.code = code;
    }
  }
  return { runSourceReconcile, SourceReconcileDatabaseError };
});

import { USAGE, main, parseReconcileArgs } from '@/lib/nango/reconcile-cli';
import { SourceReconcileDatabaseError } from '@/lib/nango/reconcile';

const CONNECTION = '00000000-0000-4000-8000-00000000c001';
const COUNTS = { processed: 2, removed: 1, paused: 0, incomplete: 1, failed: 0, skipped: 0, overdue: 0 };

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

describe('parseReconcileArgs', () => {
  it('parses --connection and --max-seconds', () => {
    expect(parseReconcileArgs([])).toEqual({ ok: true, connectionId: null, maxSeconds: 50 });
    expect(parseReconcileArgs(['--connection', CONNECTION, '--max-seconds', '120'])).toEqual({ ok: true, connectionId: CONNECTION, maxSeconds: 120 });
  });

  it('refuses an unknown option, a repeated option, a bad uuid and an out-of-range duration', () => {
    for (const argv of [
      ['--tenant', 's:default'],
      ['--connection', CONNECTION, '--connection', CONNECTION],
      ['--connection', 'not-a-uuid'],
      ['--connection'],
      ['--max-seconds', '0'],
      ['--max-seconds', '601'],
      ['--max-seconds', '1.5'],
    ]) {
      expect(parseReconcileArgs(argv).ok).toBe(false);
    }
  });
});

describe('rag:source-reconcile main', () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    runSourceReconcile.mockReset();
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-service-role-key';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  });

  it('exits 2 with the usage on bad arguments and runs nothing', async () => {
    const captured = io();
    expect(await main(['--unknown'], captured.io)).toBe(2);
    expect(captured.err).toContain(USAGE);
    expect(runSourceReconcile).not.toHaveBeenCalled();
  });

  it('exits 1 without SUPABASE_SERVICE_ROLE_KEY', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const captured = io();
    expect(await main([], captured.io)).toBe(1);
    expect(runSourceReconcile).not.toHaveBeenCalled();
  });

  it('exits 1 on a database failure', async () => {
    runSourceReconcile.mockRejectedValue(new SourceReconcileDatabaseError('08006'));
    const captured = io();
    expect(await main([], captured.io)).toBe(1);
    expect(captured.err.join('\n')).toContain('[Source Reconcile]');
  });

  it('prints one counts line with the tag and exits 0, passing the connection and the deadline', async () => {
    runSourceReconcile.mockResolvedValue({ ...COUNTS });
    const captured = io();
    expect(await main(['--connection', CONNECTION, '--max-seconds', '30'], captured.io)).toBe(0);
    expect(runSourceReconcile).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 30_000, connectionId: CONNECTION }));
    expect(captured.out).toEqual(['[Source Reconcile] processed=2 removed=1 paused=0 incomplete=1 failed=0 skipped=0 overdue=0']);
    expect(captured.out.join('\n')).not.toMatch(/\.(txt|pdf|docx)/);
  });
});
