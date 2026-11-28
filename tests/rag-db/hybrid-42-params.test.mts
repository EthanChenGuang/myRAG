import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0856 is the single Phase 4.2 redefinition of hybrid_search_chunks and rag_exact_id_documents (D-43): one function of each name, every
 * earlier parameter kept in order with the two new ones appended, service_role only, and a call without the new parameters returns what
 * the same call returned before 0856. 0855 adds rag_document_versions under the same grants.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0856_hybrid_search_42.sql';
const LEGACY = 'openai-3-small-1536';
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const TOKEN = 'paramsprobe';
const FUNCTIONS = ['hybrid_search_chunks', 'rag_exact_id_documents'] as const;
const NEW_PARAMS = ['p_version_scope', 'p_identifiers_norm'];
const NEW_COLUMNS = ['dup_cluster_id', 'is_current', 'document_version'];

const numberOf = (file: string): number => Number(path.basename(file).slice(0, 4));

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

/** The parameter names of the newest definition of `name` in a migration numbered below 0856, read from the file. */
function previousParams(name: string): { file: string; params: string[] } {
  const files = migrationFiles('multi-tenant').filter((file) => numberOf(file) < 856).reverse();
  const header = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, 'i');
  for (const file of files) {
    const sql = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const match = header.exec(sql);
    if (!match) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (depth > 0 && i < sql.length) {
      if (sql[i] === '(') depth += 1;
      if (sql[i] === ')') depth -= 1;
      i += 1;
    }
    const args = sql.slice(start, i - 1);
    return { file, params: [...args.matchAll(/(?:^|,)\s*(p_[a-z0-9_]+)\s/g)].map((m) => m[1] as string) };
  }
  throw new Error(`no earlier definition of ${name}`);
}

async function argNames(db: PGlite, name: string): Promise<string[][]> {
  const rows = await db.query<{ names: string[] | null }>(
    "SELECT p.proargnames AS names FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1",
    [name],
  );
  return rows.rows.map((row) => row.names ?? []);
}

async function overloads(db: PGlite, name: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1",
    [name],
  );
  return rows.rows[0]?.n ?? -1;
}

interface Seed {
  key: string;
  userId: string | null;
}

async function seed(db: PGlite, s: Seed): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const docId = crypto.randomUUID();
    const text = `${TOKEN} neutral sample sentence number ${i} ${i % 2 === 0 ? 'even' : 'odd'}`;
    await db.query(
      `INSERT INTO documents (id, filename, content, is_current, status, created_at${s.userId ? ', user_id' : ''})
       VALUES ($1, $2, $3, true, 'ready', $4::timestamptz${s.userId ? ', $5' : ''})`,
      [docId, `sample-${i}.md`, text, `2024-0${i + 1}-01T00:00:00Z`, ...(s.userId ? [s.userId] : [])],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 0)`,
      [crypto.randomUUID(), docId, text, vec(text), s.key],
    );
  }
}

const DEFAULT_CALL = `SELECT leg, rank, chunk_id::text, similarity, lexical_score
  FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
    p_dense_limit => 10, p_lexical_limit => 10) ORDER BY leg, rank`;
const DEFAULT_EXACT = 'SELECT chunk_id::text, matched_field FROM rag_exact_id_documents($1, $2::text[], 20)';

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  const key = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const userId = mode === 'multi-tenant' ? FIXTURE_USER_ID : null;

  describe(`0856 one definition, earlier parameters intact (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let before0856: { hybrid: unknown[]; exact: unknown[] };

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      db = fixture.db;
      const files = migrationFiles(mode);
      await applyMigrationFiles(db, files.filter((file) => numberOf(file) < 856));
      await seed(db, { key, userId });
      before0856 = {
        hybrid: (await db.query(DEFAULT_CALL, [key, LEGACY, vec(`${TOKEN} query`), [TOKEN]])).rows,
        exact: (await db.query(DEFAULT_EXACT, [key, [TOKEN]])).rows,
      };
      await applyMigrationFiles(db, files.filter((file) => numberOf(file) >= 856));
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    test('a call without the new parameters returns the same rows in the same order as before 0856', async () => {
      assert.ok(before0856.hybrid.length > 0, 'the seed is found');
      assert.deepEqual((await db.query(DEFAULT_CALL, [key, LEGACY, vec(`${TOKEN} query`), [TOKEN]])).rows, before0856.hybrid);
      assert.ok(before0856.exact.length > 0, 'the seed is found by the exact leg');
      assert.deepEqual((await db.query(DEFAULT_EXACT, [key, [TOKEN]])).rows, before0856.exact);
    });

    for (const name of FUNCTIONS) {
      test(`${name}: one function; earlier parameters in order, then the two new ones with defaults`, async () => {
        assert.equal(await overloads(db, name), 1, `${name} overloads`);
        const { file, params } = previousParams(name);
        assert.ok(params.length >= 3, `parsed ${params.length} parameters from ${file}`);
        const [names] = await argNames(db, name);
        const inputs = (names ?? []).filter((n) => n.startsWith('p_'));
        for (const param of params) assert.ok(inputs.includes(param), `${param} (from ${file}) is still a parameter`);
        assert.deepEqual(inputs, [...params, ...NEW_PARAMS]);
        const args = await db.query<{ args: string }>(
          "SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1",
          [name],
        );
        const text = args.rows[0]?.args ?? '';
        assert.match(text, /p_version_scope jsonb DEFAULT NULL::jsonb, p_identifiers_norm text\[\] DEFAULT NULL::text\[\]$/);
      });

      test(`${name}: SECURITY INVOKER, empty search_path, service_role only`, async () => {
        const rows = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; auth: boolean; service: boolean; acl: string | null }>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                  p.proacl::text AS acl
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
          [name],
        );
        const row = rows.rows[0];
        assert.equal(row?.definer, false);
        assert.deepEqual(row?.config, ['search_path=""']);
        assert.deepEqual({ anon: row?.anon, auth: row?.auth, service: row?.service }, { anon: false, auth: false, service: true });
        assert.ok(!/(^|[{,])=X/.test(row?.acl ?? ''), 'no PUBLIC execute');
      });
    }

    test('hybrid_search_chunks returns the three trailing columns after dense_mode', async () => {
      const rows = await db.query<{ names: string[]; modes: string[] }>(
        "SELECT p.proargnames AS names, p.proargmodes::text[] AS modes FROM pg_proc p WHERE p.proname = 'hybrid_search_chunks'",
      );
      const names = rows.rows[0]?.names ?? [];
      const outputs = names.filter((_, i) => rows.rows[0]?.modes?.[i] === 't');
      assert.deepEqual(outputs.slice(-4), ['dense_mode', ...NEW_COLUMNS]);
    });

    test('rag_document_versions: SECURITY INVOKER, empty search_path, service_role only', async () => {
      const rows = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; auth: boolean; service: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
           FROM pg_proc p WHERE p.proname = 'rag_document_versions'`,
      );
      assert.equal(rows.rows.length, 1);
      assert.deepEqual(rows.rows[0], { definer: false, config: ['search_path=""'], anon: false, auth: false, service: true });
    });

    const BODIES: Record<string, Record<string, unknown>> = {
      hybrid_search_chunks: {
        p_tenant_key: key,
        p_profile_id: LEGACY,
        p_query_embedding: vec(TOKEN),
        p_lexical_tokens: [TOKEN],
        p_dense_limit: 1,
        p_lexical_limit: 1,
        p_version_scope: { mode: 'all' },
        p_identifiers_norm: ['idx-x'],
      },
      rag_exact_id_documents: { p_tenant_key: key, p_tokens: [TOKEN], p_limit: 5, p_version_scope: { mode: 'all' } },
      rag_document_versions: { p_tenant_key: key, p_document_ids: [crypto.randomUUID()] },
    };

    for (const [name, body] of Object.entries(BODIES)) {
      test(`fake edge: anon is refused with 42501 on ${name}; the service key succeeds`, async () => {
        const call = async (apikey: string) => {
          const res = await fetch(`${edge.url}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: { apikey, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: res.status, body: (await res.json()) as { code?: string } };
        };
        const anon = await call(ANON_KEY);
        assert.equal(anon.status, 403);
        assert.equal(anon.body.code, '42501');
        const service = await call(SERVICE_KEY);
        assert.equal(service.status, 200, JSON.stringify(service.body));
        assert.ok(Array.isArray(service.body));
      });

      test(`SET ROLE authenticated gets 42501 on ${name}`, async () => {
        const names = Object.keys(body);
        const sql = `SELECT 1 FROM ${name}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
        const values = Object.values(body).map((value) =>
          value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value,
        );
        await db.exec('SET ROLE authenticated');
        try {
          await assert.rejects(
            () => db.query(sql, values),
            (error: unknown) => (error as { code?: string }).code === '42501',
          );
        } finally {
          await db.exec('RESET ROLE');
        }
      });
    }

    test('re-applying 0855 and 0856 keeps one function of each name and the same grants', async () => {
      const files = migrationFiles(mode).filter((file) => numberOf(file) >= 855);
      await applyMigrationFiles(db, files);
      await applyMigrationFiles(db, files);
      for (const name of [...FUNCTIONS, 'rag_document_versions']) assert.equal(await overloads(db, name), 1, name);
      const privileges = await db.query<{ anon: boolean; service: boolean }>(
        `SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon, bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) AS service
           FROM pg_proc p WHERE p.proname IN ('hybrid_search_chunks', 'rag_exact_id_documents', 'rag_document_versions')`,
      );
      assert.deepEqual(privileges.rows[0], { anon: false, service: true });
    });

    test('re-running an earlier definition (0802, 0314 and 0425) then 0856 again leaves one function of each name', async () => {
      const files = migrationFiles(mode);
      const older = files.filter((file) => ['0314', '0425', '0802'].includes(path.basename(file).slice(0, 4)));
      await applyMigrationFiles(db, older);
      assert.ok((await overloads(db, 'hybrid_search_chunks')) === 2, 'the earlier file adds its own overload back');
      await applyMigrationFiles(db, [MIGRATION]);
      for (const name of FUNCTIONS) assert.equal(await overloads(db, name), 1, name);
    });
  });
}

describe('0856 migration file', () => {
  test('one transaction, no SECURITY DEFINER, drops overloads by catalog lookup and reloads PostgREST', () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.doesNotMatch(sql, /SECURITY DEFINER/);
    assert.match(sql, /pg_catalog\.pg_proc/);
    assert.match(sql, /NOTIFY pgrst, 'reload schema';/);
  });
});
