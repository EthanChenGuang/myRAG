import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { pgliteClient } from '../helpers/pglite-rest-client.ts';
import { runLexstatsCli, type LexstatsDeps } from '../../src/lib/rag/lexical/stats-cli.ts';
import type { LexstatsDb } from '../../src/lib/rag/lexical/stats-admin.ts';

/**
 * `npm run rag:lexstats` (plan 04.4-09, D-18, D-19, D-34) against the 0900-0902 statistics in a PGlite fixture database, both
 * deployment modes. Chunk text is neutral generated words (w0..wN, D-41).
 */
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000b2';
const LINE_RE = /^[0-9a-f]{12} (building|ready|not_enabled) chunks=\d+ lexemes=\d+ pending=\d+/;

function words(seed: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `w${(seed * 7 + i * 3) % 17}`).join(' ');
}

async function seed(db: PGlite, userId: string, seedValue: number, count: number): Promise<void> {
  const docId = crypto.randomUUID();
  await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid)", [
    docId,
    `lexstats-cli-${docId}.txt`,
    userId,
  ]);
  for (let i = 0; i < count; i++) {
    await db.query(
      `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current, chunking_profile_id)
       VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3, $4, 'en', 'ready', true, 'legacy')`,
      [crypto.randomUUID(), docId, i, words(seedValue + i, 3 + (i % 4))],
    );
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

for (const mode of MODES) {
  describe(`rag:lexstats CLI (${mode})`, () => {
    let db: PGlite;
    let deps: LexstatsDeps;
    const tenantA = mode === 'single-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
    const tenantB = `u:${SECOND_USER_ID}`;

    const run = async (argv: string[]) => {
      const c = capture();
      const code = await runLexstatsCli(argv, c.io, deps);
      return { code, ...c };
    };

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'multi-tenant') await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'second-user@example.invalid')", [SECOND_USER_ID]);
      else await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid') ON CONFLICT DO NOTHING", [FIXTURE_USER_ID]);
      const client = pgliteClient(db, { role: 'service_role', label: 'lexstats', calls: [] });
      deps = { db: client as unknown as LexstatsDb, scoringMode: 'ts_rank_cd' };
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.exec(`
        RESET ROLE;
        DELETE FROM public.rag_lexical_stats_pending;
        DELETE FROM public.rag_lexical_stats_state;
        DELETE FROM public.rag_lexical_df;
        DELETE FROM public.rag_lexical_corpus;
        DELETE FROM public.document_chunks;
        DELETE FROM public.documents;
      `);
      await seed(db, FIXTURE_USER_ID, 1, 6);
      if (mode === 'multi-tenant') await seed(db, SECOND_USER_ID, 2, 4);
    });

    test('enable --tenant leaves the tenant ready with a clean check', async () => {
      const enabled = await run(['enable', '--tenant', tenantA]);
      assert.equal(enabled.code, 0, enabled.err.join('\n'));
      assert.match(enabled.out.at(-1)!, /^[0-9a-f]{12} ready chunks=6 /);
      const checked = await run(['check', '--tenant', tenantA]);
      assert.equal(checked.code, 0);
      assert.match(checked.out[0]!, LINE_RE);
      assert.match(checked.out[0]!, /clean=true/);
    });

    test('status --all --json lists only enabled tenants, hashed, with no raw key', async () => {
      assert.equal((await run(['enable', '--tenant', tenantA])).code, 0);
      const status = await run(['status', '--all', '--json']);
      assert.equal(status.code, 0);
      assert.equal(status.out.length, 1);
      const row = JSON.parse(status.out[0]!) as Record<string, unknown>;
      assert.equal(row.state, 'ready');
      assert.equal(row.chunks, 6);
      assert.equal(row.tenant, crypto.createHash('sha256').update(tenantA).digest('hex').slice(0, 12));
      assert.ok(!status.out[0]!.includes(tenantA));
    });

    test('compact folds staged changes and check stays clean', async () => {
      assert.equal((await run(['enable', '--tenant', tenantA])).code, 0);
      await seed(db, FIXTURE_USER_ID, 9, 3);
      const before = await run(['status', '--tenant', tenantA]);
      assert.match(before.out[0]!, /pending=[1-9]\d*/);
      const compacted = await run(['compact', '--tenant', tenantA, '--max-rows', '1']);
      assert.equal(compacted.code, 0, compacted.err.join('\n'));
      assert.match(compacted.out.at(-1)!, /^[0-9a-f]{12} ready chunks=9 lexemes=\d+ pending=0/);
      assert.equal((await run(['check', '--tenant', tenantA])).code, 0);
    });

    test('tampered counters: check exits 1, check --repair exits 0 and leaves a clean check', async () => {
      assert.equal((await run(['enable', '--tenant', tenantA])).code, 0);
      await db.query("UPDATE public.rag_lexical_df SET df = df + 5 WHERE tenant_key = $1 AND corpus = 'chunks'", [tenantA]);
      await db.query("UPDATE public.rag_lexical_corpus SET chunk_count = chunk_count + 1 WHERE tenant_key = $1", [tenantA]);
      const drift = await run(['check', '--all']);
      assert.equal(drift.code, 1);
      assert.match(drift.out[0]!, /clean=false/);
      const repaired = await run(['check', '--all', '--repair']);
      assert.equal(repaired.code, 0, repaired.err.join('\n'));
      assert.equal((await run(['check', '--tenant', tenantA])).code, 0);
    });

    test('enable --all enables every tenant with member chunks and no other key; a second run is a no-op', async () => {
      const first = await run(['enable', '--all']);
      assert.equal(first.code, 0, first.err.join('\n'));
      const states = (await db.query<{ tenant_key: string; status: string }>('SELECT tenant_key, status FROM public.rag_lexical_stats_state ORDER BY 1')).rows;
      const expected = mode === 'multi-tenant' ? [tenantA, tenantB].sort() : [tenantA];
      assert.deepEqual(
        states.map((s) => s.tenant_key),
        expected,
      );
      assert.ok(states.every((s) => s.status === 'ready'));
      for (const line of first.out) {
        assert.match(line, LINE_RE);
        for (const key of expected) assert.ok(!line.includes(key), 'no raw tenant key under --all');
        assert.ok(!/\bw\d+\b/.test(line), 'no lexeme');
      }
      const rebuiltAt = (await db.query<{ r: string }>('SELECT max(rebuilt_at)::text AS r FROM public.rag_lexical_stats_state')).rows[0]!.r;
      const second = await run(['enable', '--all']);
      assert.equal(second.code, 0);
      const rebuiltAgain = (await db.query<{ r: string }>('SELECT max(rebuilt_at)::text AS r FROM public.rag_lexical_stats_state')).rows[0]!.r;
      assert.equal(rebuiltAgain, rebuiltAt, 'second enable --all rebuilt nothing');
    });

    test('disable --tenant removes the statistics; status reports not_enabled', async () => {
      assert.equal((await run(['enable', '--tenant', tenantA])).code, 0);
      assert.equal((await run(['disable', '--tenant', tenantA])).code, 0);
      const status = await run(['status', '--tenant', tenantA]);
      assert.match(status.out[0]!, /^[0-9a-f]{12} not_enabled chunks=0 lexemes=0 pending=0/);
      assert.ok(status.out[0]!.includes(tenantA), '--tenant names the key, so it may be shown');
      const rows = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_lexical_df WHERE tenant_key = $1', [tenantA])).rows[0]!.n;
      assert.equal(rows, 0);
    });

    test('a key of the other deployment mode fails with the rpc name and code, exit 1', async () => {
      const other = mode === 'single-tenant' ? `u:${SECOND_USER_ID}` : 's:default';
      const failed = await run(['status', '--tenant', other]);
      assert.equal(failed.code, 1);
      assert.ok(failed.err.some((l) => l.startsWith('[Lexical Stats]') && l.includes('rag_lexstats_status') && l.includes('22023')), failed.err.join('\n'));
    });
  });
}
