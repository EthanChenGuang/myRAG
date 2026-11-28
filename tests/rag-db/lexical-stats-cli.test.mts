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
        DELETE FROM public.rag_lexical_cluster_dirty;
        DELETE FROM public.rag_lexical_cluster_units;
        DELETE FROM public.rag_lexical_stats_pending;
        DELETE FROM public.rag_lexical_stats_state;
        DELETE FROM public.rag_lexical_df;
        DELETE FROM public.rag_lexical_corpus;
        UPDATE public.document_chunks SET dup_cluster_id = NULL WHERE dup_cluster_id IS NOT NULL;
        DELETE FROM public.rag_dup_clusters;
        DELETE FROM public.document_chunks;
        DELETE FROM public.documents;
      `);
      await seed(db, FIXTURE_USER_ID, 1, 6);
      if (mode === 'multi-tenant') await seed(db, SECOND_USER_ID, 2, 4);
    });

    /** Three copies of one chunk in three documents of tenant A, in one duplicate cluster (04.4-17, D-46). */
    const clusterCopies = async (): Promise<void> => {
      const cluster = (
        await db.query<{ id: string }>("INSERT INTO public.rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, 'openai-3-small-1536') RETURNING id", [
          tenantA,
        ])
      ).rows[0]!.id;
      for (let i = 0; i < 3; i++) {
        const docId = crypto.randomUUID();
        await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid)", [
          docId,
          `lexstats-cli-copy-${docId}.txt`,
          FIXTURE_USER_ID,
        ]);
        await db.query(
          `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current,
             chunking_profile_id, dup_cluster_id)
           VALUES ($1, $2, 'neutral sample', '{}'::jsonb, 0, 'w91 w92 w93 w94', 'en', 'ready', true, 'legacy', $3::uuid)`,
          [crypto.randomUUID(), docId, cluster],
        );
      }
    };

    test('enable --cluster: raw enable, cluster enable, rebuild and a clean check with the cluster fields; counts only', async () => {
      await clusterCopies();
      const enabled = await run(['enable', '--tenant', tenantA, '--cluster']);
      assert.equal(enabled.code, 0, enabled.err.join('\n'));
      const line = enabled.out.at(-1)!;
      assert.match(line, /^[0-9a-f]{12} ready chunks=9 /);
      for (const field of ['cluster_status=ready', 'cluster_dirty=0', 'cluster_df_diff=0', 'cluster_chunk_count_diff=0', 'cluster_ledger_diff=0', 'clean=true']) {
        assert.ok(line.includes(field), `${field} in ${line}`);
      }
      assert.ok(!/\bw9[1-4]\b/.test(line), 'no lexeme');
      const corpus = await db.query<{ corpus: string; n: number }>(
        'SELECT corpus, sum(chunk_count)::int AS n FROM public.rag_lexical_corpus WHERE tenant_key = $1 GROUP BY 1 ORDER BY 1',
        [tenantA],
      );
      assert.deepEqual(corpus.rows, [
        { corpus: 'chunks', n: 9 },
        { corpus: 'chunks_cluster', n: 7 },
      ]);
      const json = await run(['status', '--tenant', tenantA, '--json']);
      assert.equal(JSON.parse(json.out[0]!).cluster_status, 'ready', 'status prints the cluster fields');
      const again = await run(['enable', '--tenant', tenantA, '--cluster']);
      assert.equal(again.code, 0, 'a second run is clean too');
    });

    test('check --cluster: a tampered cluster counter exits 1; --repair rebuilds and exits 0; check without the flag also reports it', async () => {
      await clusterCopies();
      assert.equal((await run(['enable', '--tenant', tenantA, '--cluster'])).code, 0);
      await db.query("UPDATE public.rag_lexical_df SET df = df + 3 WHERE tenant_key = $1 AND corpus = 'chunks_cluster'", [tenantA]);
      const drift = await run(['check', '--tenant', tenantA, '--cluster']);
      assert.equal(drift.code, 1);
      assert.match(drift.out[0]!, /cluster_df_diff=[1-9]/);
      assert.equal((await run(['check', '--tenant', tenantA])).code, 1, 'the plain check counts the cluster difference');
      const repaired = await run(['check', '--tenant', tenantA, '--cluster', '--repair']);
      assert.equal(repaired.code, 0, repaired.err.join('\n'));
      assert.match(repaired.out[0]!, /repaired=true/);
      assert.equal((await run(['check', '--tenant', tenantA, '--cluster'])).code, 0);
    });

    test('disable --cluster removes only the cluster statistics; rebuild and check --cluster then refuse with exit 1', async () => {
      await clusterCopies();
      assert.equal((await run(['enable', '--tenant', tenantA, '--cluster'])).code, 0);
      const raw = (await db.query("SELECT lexeme, df FROM public.rag_lexical_df WHERE tenant_key = $1 AND corpus = 'chunks' ORDER BY 1", [tenantA])).rows;
      const disabled = await run(['disable', '--tenant', tenantA, '--cluster']);
      assert.equal(disabled.code, 0, disabled.err.join('\n'));
      assert.match(disabled.out[0]!, /cluster_removed=true/);
      assert.doesNotMatch(disabled.out[0]!, /cluster_status=/);
      const left = await db.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM public.rag_lexical_df WHERE tenant_key = $1 AND corpus = 'chunks_cluster')
              + (SELECT count(*) FROM public.rag_lexical_cluster_units WHERE tenant_key = $1)
              + (SELECT count(*) FROM public.rag_lexical_cluster_dirty WHERE tenant_key = $1) AS n`,
        [tenantA],
      );
      assert.equal(Number(left.rows[0]!.n), 0);
      assert.deepEqual((await db.query("SELECT lexeme, df FROM public.rag_lexical_df WHERE tenant_key = $1 AND corpus = 'chunks' ORDER BY 1", [tenantA])).rows, raw);
      assert.equal((await run(['check', '--tenant', tenantA])).code, 0, 'raw statistics stay clean');
      assert.equal((await run(['rebuild', '--tenant', tenantA, '--cluster'])).code, 1);
      const refused = await run(['check', '--tenant', tenantA, '--cluster']);
      assert.equal(refused.code, 1);
      assert.ok(refused.err.some((l) => l.includes('enable --cluster')));
    });

    test('RAG_LEXICAL_DF_MODE=cluster: enable without --cluster prints one hint and enables raw statistics only', async () => {
      const c = capture();
      const code = await runLexstatsCli(['enable', '--tenant', tenantA], c.io, { ...deps, scoringMode: 'bm25', dfMode: 'cluster' });
      assert.equal(code, 0, c.err.join('\n'));
      assert.equal(c.err.filter((l) => l.includes('add --cluster')).length, 1);
      assert.ok(!c.err.join('\n').includes(tenantA), 'hashed tenant only');
      const state = await db.query<{ cluster_status: string | null }>('SELECT cluster_status FROM public.rag_lexical_stats_state WHERE tenant_key = $1', [tenantA]);
      assert.equal(state.rows[0]?.cluster_status, null);
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
