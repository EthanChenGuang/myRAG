import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, runFixtureRelex, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RelexInputError } from '@/lib/rag/ingest/relex/run';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const frozenSetup = (mode: DeploymentMode): string => `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`;

async function lexicalVersions(db: PGlite): Promise<{ total: number; relexed: number; unset: number }> {
  const result = await db.query<{ total: number; relexed: number; unset: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE lexical_version = $1)::int AS relexed,
            count(*) FILTER (WHERE lexical_version IS NULL)::int AS unset
     FROM document_chunks`,
    [LEXICAL_VERSION],
  );
  return result.rows[0] as { total: number; relexed: number; unset: number };
}

for (const mode of MODES) {
  describe(`fixture relex follows the migrations option (${mode})`, () => {
    for (const setup of [
      { label: 'folded setup', sqlKey: `supabase/${mode}-setup.sql`, hasRelexRpc: true },
      { label: 'frozen pre-Phase-3 setup', sqlKey: frozenSetup(mode), setupSqlPath: frozenSetup(mode), hasRelexRpc: false },
    ]) {
      test(`a migrations:false fixture on the ${setup.label} builds as the pre-migration database and runs no relex`, async () => {
        const fixture = await createFixtureDatabase({
          deploymentMode: mode,
          corpusDir: REAL_CORPUS,
          migrations: false,
          ...(setup.setupSqlPath ? { setupSqlPath: setup.setupSqlPath } : {}),
        });
        try {
          const relexFn = await fixture.db.query<{ fn: string | null }>(`SELECT to_regproc('public.rag_relex_candidates')::text AS fn`);
          if (setup.hasRelexRpc) assert.notEqual(relexFn.rows[0]?.fn, null, 'the folded setup file carries 0402 (plan 04-42)');
          else assert.equal(relexFn.rows[0]?.fn, null, 'rag_relex_candidates comes from migration 0402, not from the frozen setup file');
          assert.deepEqual(Object.keys(fixture.sqlSha256), [setup.sqlKey], 'no lexical_version fingerprint without a relex');
          await applyMigrations(fixture.db, mode);
          const before = await lexicalVersions(fixture.db);
          assert.ok(before.total > 0, 'the corpus was loaded');
          assert.equal(before.unset, before.total, 'no relex ran before the caller applied the migrations');
          await runFixtureRelex(fixture.db);
          const after = await lexicalVersions(fixture.db);
          // 0806 backfills lineages on upgrade: an older upload with the same filename (the Phase 4.2 version notes) is superseded,
          // and relex stamps current chunks only.
          const superseded = await fixture.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM document_chunks c JOIN documents d ON d.id = c.document_id
              WHERE NOT c.is_current AND d.superseded_by IS NOT NULL AND c.lexical_version IS NULL`,
          );
          assert.equal(after.relexed + (superseded.rows[0]?.n ?? 0), after.total, 'relex after the migrations stamps every current legacy chunk');
        } finally {
          await fixture.db.close();
        }
      });
    }

    test('the default fixture (migrations applied) still relexes every chunk', async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      try {
        const versions = await lexicalVersions(fixture.db);
        assert.ok(versions.total > 0);
        assert.equal(versions.relexed, versions.total);
        assert.ok(fixture.sqlSha256[`lexical_version:${LEXICAL_VERSION}`], 'the fingerprint records the relex tokenizer version');
      } finally {
        await fixture.db.close();
      }
    });

    test('relex requested before the migrations fails with the RPC SQLSTATE visible', async () => {
      await assert.rejects(
        () =>
          createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, migrations: false, relex: true, setupSqlPath: frozenSetup(mode) }),
        (error: unknown) => {
          assert.ok(error instanceof RelexInputError, `expected RelexInputError, got ${String(error)}`);
          assert.equal(error.code, 'rpc_failed:rag_relex_candidates');
          assert.equal(error.rpcCode, '42883', 'undefined_function, not a generic P0001');
          assert.match(error.message, /42883/);
          return true;
        },
      );
    });
  });
}
