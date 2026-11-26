import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { allowListEntryFor } from '../helpers/security-definer-allow-list';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0653_finetune_export.sql');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

const LEGACY = 'openai-3-small-1536';
const HALFVEC = 'voyage-4-large-1024';
const SLOT_A = 'ft-a-1024';
const SECOND_USER = '33333333-3333-4333-8333-333333333333';
const SIGNATURE = 'public.rag_finetune_export_vectors(text, text, text, uuid, integer)';

interface ExportRow {
  chunk_id: string;
  embedding: number[];
  embedding_model: string;
  dims: number;
}

/** Runs one statement and returns 'accepted' or the error message; outside a transaction a failed statement rolls itself back. */
async function outcome(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  const nested = db.isInTransaction();
  if (nested) await db.exec('SAVEPOINT attempt');
  try {
    await db.query(sql, params);
    if (nested) await db.exec('RELEASE SAVEPOINT attempt');
    return 'accepted';
  } catch (error) {
    if (nested) await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return error instanceof Error ? error.message : String(error);
  }
}

function halfvecLiteral(seed: number): string {
  return `[${Array.from({ length: 1024 }, (_, index) => ((index + seed) % 5) / 8 + 0.125).join(',')}]`;
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';

  describe(`0653 fine-tune vector export (${mode})`, () => {
    let db: PGlite;
    let tenantA: string;
    let tenantB: string;
    let ownerA: string;
    let chunksA: string[] = [];
    let chunksB: string[] = [];

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      ownerA = fixture.fixtureUserId;
      tenantA = multi ? `u:${ownerA}` : 's:default';
      tenantB = `u:${SECOND_USER}`;
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SECOND_USER, 'second-user@example.invalid']);
      chunksA = await insertDocument(5, ownerA);
      if (multi) chunksB = await insertDocument(5, SECOND_USER);
      await db.query(
        `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT c.id, $1, c.tenant_key, $2::public.halfvec, 'voyage-4-large', 1024 FROM public.document_chunks c`,
        [HALFVEC, halfvecLiteral(1)],
      );
    });

    after(async () => {
      await db?.close();
    });

    async function insertDocument(chunks: number, owner: string): Promise<string[]> {
      const documentId = crypto.randomUUID();
      if (multi) {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          documentId, `export-${documentId.slice(0, 8)}.md`, 'A neutral synthetic paragraph about a sample record.', '{}', owner,
        ]);
      } else {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
          documentId, `export-${documentId.slice(0, 8)}.md`, 'A neutral synthetic paragraph about a sample record.', '{}',
        ]);
      }
      const ids: string[] = [];
      for (let index = 0; index < chunks; index += 1) {
        const chunkId = crypto.randomUUID();
        await db.query(
          "INSERT INTO public.document_chunks (id, document_id, content, chunk_index, metadata, embedding) VALUES ($1, $2, $3, $4, '{}'::jsonb, array_fill(0.02::float4, ARRAY[1536])::public.vector)",
          [chunkId, documentId, `A neutral synthetic sentence number ${index}.`, index],
        );
        ids.push(chunkId);
      }
      return ids;
    }

    async function grant(tenant: string, scope: 'private' | 'deployment'): Promise<void> {
      await db.query('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenant, scope, 'TICKET-1', 'op']);
    }

    async function revoke(tenant: string): Promise<void> {
      await db.query('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenant, 'none', null, 'op']);
    }

    async function exportPage(tenant: string, profile: string, after: string | null, limit: number, purpose = 'private'): Promise<ExportRow[]> {
      const result = await db.query<ExportRow>('SELECT * FROM public.rag_finetune_export_vectors($1, $2, $3, $4, $5)', [tenant, purpose, profile, after, limit]);
      return result.rows;
    }

    async function exportAll(tenant: string, profile: string, limit = 2, purpose = 'private'): Promise<ExportRow[]> {
      const out: ExportRow[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await exportPage(tenant, profile, cursor, limit, purpose);
        if (page.length === 0) return out;
        out.push(...page);
        cursor = page[page.length - 1].chunk_id;
      }
    }

    const attempt = (tenant: string, purpose: string, profile: string, limit = 10): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_finetune_export_vectors($1, $2, $3, NULL, $4)', [tenant, purpose, profile, limit]);

    test('without consent the export is refused', async () => {
      assert.match(await attempt(tenantA, 'private', LEGACY), /^export_refused: consent/);
    });

    test('legacy profile: only the tenant\'s chunks, every one once, keyset ordered by chunk id', async () => {
      await grant(tenantA, 'private');
      const rows = await exportAll(tenantA, LEGACY, 2);
      assert.deepEqual(rows.map((row) => row.chunk_id), [...chunksA].sort());
      assert.equal(new Set(rows.map((row) => row.chunk_id)).size, chunksA.length);
      for (const row of rows) {
        assert.equal(row.dims, 1536);
        assert.equal(row.embedding.length, 1536);
        assert.equal(row.embedding_model, 'text-embedding-3-small');
        assert.ok(Math.abs(row.embedding[0] - 0.02) < 1e-6);
      }
      for (const id of chunksB) assert.ok(!rows.some((row) => row.chunk_id === id), 'tenant B chunk exported for tenant A');
    });

    test('halfvec profile reads chunk_embeddings of that tenant only', async () => {
      const rows = await exportAll(tenantA, HALFVEC, 3);
      assert.deepEqual(rows.map((row) => row.chunk_id), [...chunksA].sort());
      for (const row of rows) {
        assert.equal(row.dims, 1024);
        assert.equal(row.embedding.length, 1024);
        assert.equal(row.embedding_model, 'voyage-4-large');
        assert.ok(Math.abs(row.embedding[0] - (1 / 8 + 0.125)) < 1e-3);
      }
    });

    test('an unbound slot and an unknown profile are refused', async () => {
      assert.match(await attempt(tenantA, 'private', SLOT_A), /^export_refused: unbound/);
      assert.match(await attempt(tenantA, 'private', 'no-such-profile'), /^export_refused: unknown_profile/);
    });

    test('limit and purpose are checked', async () => {
      assert.match(await attempt(tenantA, 'private', LEGACY, 0), /^export_refused: invalid_limit/);
      assert.match(await attempt(tenantA, 'private', LEGACY, 1001), /^export_refused: invalid_limit/);
      assert.match(await attempt(tenantA, 'everything', LEGACY), /purpose must be private or deployment/);
      assert.match(await attempt(tenantA, 'deployment', LEGACY), /^export_refused: consent/);
    });

    test('non-current and not-ready chunks are never returned', async () => {
      await db.exec('BEGIN');
      try {
        await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE id = $1", [chunksA[0]]);
        await db.query('UPDATE public.document_chunks SET is_current = false WHERE id = $1', [chunksA[1]]);
        const ids = (await exportAll(tenantA, LEGACY, 10)).map((row) => row.chunk_id);
        assert.ok(!ids.includes(chunksA[0]));
        assert.ok(!ids.includes(chunksA[1]));
        assert.equal(ids.length, chunksA.length - 2);
        const halfIds = (await exportAll(tenantA, HALFVEC, 10)).map((row) => row.chunk_id);
        assert.ok(!halfIds.includes(chunksA[0]));
        assert.ok(!halfIds.includes(chunksA[1]));
      } finally {
        await db.exec('ROLLBACK');
      }
    });

    if (multi) {
      test('tenant B with identical content: each export holds only its own tenant', async () => {
        await grant(tenantB, 'deployment');
        const rowsB = await exportAll(tenantB, LEGACY, 2, 'deployment');
        assert.deepEqual(rowsB.map((row) => row.chunk_id), [...chunksB].sort());
        const rowsA = await exportAll(tenantA, HALFVEC, 2);
        assert.deepEqual(rowsA.map((row) => row.chunk_id), [...chunksA].sort());
      });

      test('a revoke makes the next call refuse', async () => {
        await revoke(tenantB);
        assert.match(await attempt(tenantB, 'deployment', LEGACY), /^export_refused: consent/);
      });
    } else {
      test('a key of the other deployment mode is refused', async () => {
        assert.match(await attempt(tenantB, 'private', LEGACY), /tenant_key_invalid/);
      });

      test('a revoke makes the next call refuse', async () => {
        await revoke(tenantA);
        assert.match(await attempt(tenantA, 'private', LEGACY), /^export_refused: consent/);
        await grant(tenantA, 'private');
      });
    }

    test('re-applying 0653 is idempotent', async () => {
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      assert.ok((await exportPage(tenantA, LEGACY, null, 1)).length <= 1);
    });

    test('service_role only, SECURITY DEFINER with an empty search_path, not on the authenticated allow-list', async () => {
      assert.equal(allowListEntryFor(SIGNATURE), undefined);
      const result = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; authed: boolean; service: boolean; pub: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub
         FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
        [SIGNATURE],
      );
      const row = result.rows[0];
      assert.ok(row, 'rag_finetune_export_vectors is missing');
      assert.equal(row.definer, true);
      assert.ok((row.config ?? []).includes('search_path=""'), JSON.stringify(row.config));
      assert.equal(row.anon, false);
      assert.equal(row.authed, false);
      assert.equal(row.pub, false);
      assert.equal(row.service, true);
    });

    test('anon and authenticated cannot execute it', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec('BEGIN');
        try {
          await db.exec(`SET LOCAL ROLE ${role}`);
          assert.match(await attempt(tenantA, 'private', LEGACY), /permission denied/);
        } finally {
          await db.exec('ROLLBACK');
        }
      }
    });
  });
}

describe('npm run rag:finetune over the fake edge (two tenants)', () => {
  const FT_ENV = { RAG_FINETUNE: 'on' };
  let fixture: import('../../eval/harness/two-tenant.mts').TwoTenantDatabase;
  let edge: import('../../eval/harness/fake-edge.mts').FakeEdge;
  let cli: typeof import('@/lib/rag/finetune/cli');
  let bundleIo: typeof import('@/lib/rag/finetune/bundle-io');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let ids: typeof import('../../eval/harness/two-tenant.mts').TWO_TENANT_IDS;
  let tenantA: string;
  let tenantB: string;
  const bundles: string[] = [];

  before(async () => {
    const twoTenant = await import('../../eval/harness/two-tenant.mts');
    const fakeEdge = await import('../../eval/harness/fake-edge.mts');
    ids = twoTenant.TWO_TENANT_IDS;
    tenantA = `u:${ids.userA}`;
    tenantB = `u:${ids.userB}`;
    fixture = await twoTenant.createTwoTenantDatabase();
    edge = await fakeEdge.startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fakeEdge.fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    cli = await import('@/lib/rag/finetune/cli');
    bundleIo = await import('@/lib/rag/finetune/bundle-io');
    ingestDeps = await import('@/lib/rag/ingest/deps');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
  });

  after(async () => {
    ingestDeps?.resetIngestDepsForTests();
    activeProfile?.resetActiveProfileForTests();
    for (const dir of bundles) fs.rmSync(dir, { recursive: true, force: true });
    await edge?.close();
    await fixture?.db.close();
  });

  function makeBundle(tenantKeys: string[], purpose: 'private' | 'deployment'): string {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ft-export-'));
    bundles.push(dir);
    const manifest = {
      run_id: 'run-export-1',
      purpose,
      split_rule: 'ft-sha256-first8hex-mod100-80-10-10',
      tenant_keys: [...tenantKeys].sort(),
      chunks: {},
      counts: {},
      files: {},
      created_at: '2026-11-26T10:00:00Z',
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  }

  async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cli.main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, undefined, FT_ENV);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const consent = (tenant: string, scope: 'none' | 'private' | 'deployment') =>
    fixture.db.query('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenant, scope, scope === 'none' ? null : 'TICKET-2', 'op']);

  const rowsFile = (dir: string, base: string) =>
    fs.readFileSync(path.join(dir, `${base}.rows.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

  test('export-vectors refuses without consent and writes nothing', async () => {
    const dir = makeBundle([tenantA], 'private');
    const result = await run('export-vectors', '--bundle', dir);
    assert.equal(result.code, 1);
    assert.match(result.err, /refused: consent/);
    assert.equal(fs.existsSync(path.join(dir, 'vectors')) ? fs.readdirSync(path.join(dir, 'vectors')).length : 0, 0);
  });

  test('export-vectors writes each tenant\'s own chunk vectors of the active profile, counts only on stdout', async () => {
    await consent(tenantA, 'deployment');
    await consent(tenantB, 'deployment');
    const dir = makeBundle([tenantA, tenantB], 'deployment');
    const result = await run('export-vectors', '--bundle', dir, '--batch-size', '1');
    assert.equal(result.code, 0, result.err);
    const baseA = bundleIo.vectorFileBase('chunks', tenantA, 'openai-3-small-1536');
    const baseB = bundleIo.vectorFileBase('chunks', tenantB, 'openai-3-small-1536');
    assert.deepEqual(rowsFile(dir, baseA).map((row) => row.chunk_id), [ids.chunkA]);
    assert.deepEqual(rowsFile(dir, baseB).map((row) => row.chunk_id), [ids.chunkB]);
    const { header, vectors } = bundleIo.readVectorSet(dir, baseA);
    assert.equal(header.tenant_key, tenantA);
    assert.equal(header.dims, 1536);
    assert.equal(vectors.length, 1);
    assert.doesNotMatch(result.out, /canary|personal notes/);
    assert.match(result.out, /2 rows for 2 tenants/);
  });

  test('a consent revoke between two commands makes the second refuse', async () => {
    const dir = makeBundle([tenantA, tenantB], 'deployment');
    assert.equal((await run('export-vectors', '--bundle', dir)).code, 0);
    await consent(tenantB, 'none');
    const again = await run('export-vectors', '--bundle', dir);
    assert.equal(again.code, 1);
    assert.match(again.err, /refused: consent/);
    await consent(tenantB, 'deployment');
  });
});
