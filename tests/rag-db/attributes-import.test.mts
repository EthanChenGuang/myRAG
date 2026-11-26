import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { AttributesImportOutcome } from '@/lib/rag/ingest/attributes/import';
import type { TenantScope } from '@/lib/rag/tenant/scope';

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';

const { runAttributesImport } = await import('@/lib/rag/ingest/attributes/import');
const { main } = await import('@/lib/rag/ingest/attributes/cli');
const { resetAttributeSchemaCacheForTests } = await import('@/lib/rag/ingest/attributes/schema');
const { resetIngestDepsForTests, setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
const { mintScope } = await import('@/lib/rag/tenant/scope');

/**
 * TPL-04 (D-23, D-24, pitfall 9): the rag:attributes run against the 1005 import function in both deployment modes. Documents are written
 * with the Phase 3 writer functions; import files live in a temporary directory. Keys and values are synthetic.
 */

const ORG_A = '00000000-0000-4000-8000-000000130301';
const ORG_B = '00000000-0000-4000-8000-000000130302';
const OWNER_A = '00000000-0000-4000-8000-000000130311';
const OWNER_B = '00000000-0000-4000-8000-000000130312';
const SOURCE = 'config_upload';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';
const MARKER = 'marker-value-m3x';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
  scope: TenantScope;
}

let sequence = 0;
const next = (label: string): string => `${label}-${++sequence}`;

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

const asParam = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && !(Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null))
    ? JSON.stringify(value)
    : value;

/** Service-role RPC over PGlite, with an optional hook that runs before a call. */
function pgliteRpc(db: PGlite, before?: (fn: string, args: Record<string, unknown>) => Promise<void>): RpcClient & { calls: Array<{ fn: string; args: Row }> } {
  const calls: Array<{ fn: string; args: Row }> = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = (before ? before(fn, args) : Promise.resolve())
        .then(() => db.query<Row>(sql, keys.map((key) => asParam(args[key]))))
        .then((result): RpcResponse => ({ data: result.rows, error: null }))
        .catch((error: unknown): RpcResponse => {
          const code = (error as { code?: unknown } | null)?.code;
          return { data: null, error: { code: typeof code === 'string' ? code : 'P0001', message: error instanceof Error ? error.message : String(error) } };
        });
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type) VALUES ($1, 'alpha_code', 'code'), ($1, 'beta_list', 'text_list'),
       ($1, 'gamma_text', 'text') ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
}

async function beginVersion(db: PGlite, tenant: Tenant, sourceKey: string): Promise<string> {
  const begun = (
    await rows(
      db,
      `SELECT outcome, document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, $4, $5, $6, $7, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, tenant.orgId, SOURCE, sourceKey, `${sourceKey}.md`, crypto.createHash('sha256').update(next('sha')).digest('hex')],
    )
  )[0];
  assert.equal(begun?.outcome, 'created');
  return String(begun?.document_id);
}

async function writeChunks(db: PGlite, tenant: Tenant, id: string): Promise<void> {
  const contents = [`${next('tok')} neutral probe sentence one`, `${next('tok')} neutral probe sentence two`];
  const chunks = contents.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed % 1536 ? 1 : 0));
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 2)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [vector(1), vector(2)] })],
  );
}

async function publishedDocument(db: PGlite, tenant: Tenant, sourceKey: string): Promise<string> {
  const id = await beginVersion(db, tenant, sourceKey);
  await writeChunks(db, tenant, id);
  await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
  return id;
}

async function attributesOf(db: PGlite, id: string): Promise<{ document: unknown; chunks: unknown[] }> {
  const document = (await rows(db, 'SELECT attributes FROM documents WHERE id = $1', [id]))[0]?.attributes ?? null;
  const chunks = (await rows(db, 'SELECT attributes FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id])).map((row) => row.attributes);
  return { document, chunks };
}

/** Row hashes of a tenant's documents, chunks and staged rows. */
async function tenantSnapshot(db: PGlite, tenantKey: string): Promise<string[]> {
  const hashes = async (sql: string) => (await rows(db, sql, [tenantKey])).map((row) => String(row.h));
  return [
    ...(await hashes("SELECT md5(row_to_json(d)::text) AS h FROM documents d WHERE tenant_key = $1 ORDER BY id")),
    ...(await hashes("SELECT md5(row_to_json(c)::text) AS h FROM document_chunks c WHERE tenant_key = $1 ORDER BY id")),
    ...(await hashes("SELECT md5(row_to_json(s)::text) AS h FROM rag_staged_attributes s WHERE tenant_key = $1 ORDER BY source, source_key")),
  ];
}

/** Everything about a tenant's chunks except their attribute values. */
async function chunkBodies(db: PGlite, tenantKey: string): Promise<string[]> {
  return (
    await rows(
      db,
      `SELECT md5(concat_ws('|', id::text, document_id::text, content, lexical_text, embedding::text)) AS h FROM document_chunks
        WHERE tenant_key = $1 ORDER BY id`,
      [tenantKey],
    )
  ).map((row) => String(row.h));
}

async function seedCacheFor(db: PGlite, tenantKey: string, documentId: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{}'::jsonb, $3::jsonb, false, now() + interval '1 hour')`,
    [tenantKey, crypto.createHash('sha256').update(next('cache')).digest('hex'), JSON.stringify([{ document_id: documentId, version: 1 }])],
  );
}

async function cacheCount(db: PGlite, tenantKey: string): Promise<number> {
  return Number((await rows(db, 'SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenantKey]))[0]?.n);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attributes-import-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function importFile(lines: Array<Record<string, unknown>>): string {
  const target = path.join(tmp, `${next('import')}.jsonl`);
  fs.writeFileSync(target, lines.map((line) => JSON.stringify(line)).join('\n'));
  return target;
}

interface Run {
  outcome: AttributesImportOutcome;
  out: string[];
  err: string[];
}

async function runImport(rpc: RpcClient, tenant: Tenant, file: string, apply: boolean): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  resetAttributeSchemaCacheForTests();
  setIngestDepsForTests({ db: () => rpc });
  try {
    const outcome = await runAttributesImport(
      { scope: tenant.scope, file, apply },
      { rpc, signal: new AbortController().signal, io: { out: (line) => out.push(line), err: (line) => err.push(line) } },
    );
    return { outcome, out, err };
  } finally {
    resetIngestDepsForTests();
  }
}

async function database(mode: 'multi-tenant' | 'single-tenant'): Promise<{ db: PGlite; a: Tenant; b: Tenant | null }> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  if (mode === 'single-tenant') {
    await defineKeys(db, 's:default');
    return { db, a: { key: 's:default', userId: null, orgId: null, scope: mintScope('single', null, null) }, b: null };
  }
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    OWNER_A,
    'import-a@example.invalid',
    OWNER_B,
    'import-b@example.invalid',
  ]);
  await db.query(
    'INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false) ON CONFLICT DO NOTHING',
    [ORG_A, 'Tenant A', 'tenant-a-1313', OWNER_A, ORG_B, 'Tenant B', 'tenant-b-1313', OWNER_B],
  );
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner') ON CONFLICT DO NOTHING",
    [ORG_A, OWNER_A, ORG_B, OWNER_B],
  );
  await defineKeys(db, `o:${ORG_A}`);
  await defineKeys(db, `o:${ORG_B}`);
  return {
    db,
    a: { key: `o:${ORG_A}`, userId: OWNER_A, orgId: ORG_A, scope: mintScope('org', null, ORG_A) },
    b: { key: `o:${ORG_B}`, userId: OWNER_B, orgId: ORG_B, scope: mintScope('org', null, ORG_B) },
  };
}

const totalsLine = (run: Run, label: string): string | undefined => run.out.find((line) => line.includes(label));

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`rag:attributes import (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null;

    before(async () => {
      ({ db, a, b } = await database(mode));
    });

    after(async () => {
      await db?.close();
    });

    test('apply writes documents and every chunk, stages unknown keys, prints the totals and the outbox line; a repeat changes nothing', async () => {
      const keyOne = `set-a/${next('item')}`;
      const keyTwo = `set-a/${next('item')}`;
      const later = `set-a/${next('item')}`;
      const one = await publishedDocument(db, a, keyOne);
      const two = await publishedDocument(db, a, keyTwo);
      await seedCacheFor(db, a.key, one);
      const cacheBefore = await cacheCount(db, a.key);
      const bodies = await chunkBodies(db, a.key);
      const file = importFile([
        { source_key: keyOne, attributes: { alpha_code: ' A-1 ', beta_list: ['x', 'y'] } },
        { source_key: keyTwo, source: SOURCE, attributes: { gamma_text: 'neutral words' } },
        { source_key: later, attributes: { alpha_code: 'L-1' } },
      ]);
      const rpc = pgliteRpc(db);

      const first = await runImport(rpc, a, file, true);
      assert.equal(first.outcome.exitCode, 0, first.err.join('\n'));
      assert.deepEqual((await attributesOf(db, one)), {
        document: { alpha_code: 'A-1', beta_list: ['x', 'y'] },
        chunks: [{ alpha_code: 'A-1', beta_list: ['x', 'y'] }, { alpha_code: 'A-1', beta_list: ['x', 'y'] }],
      });
      assert.deepEqual((await attributesOf(db, two)).chunks, [{ gamma_text: 'neutral words' }, { gamma_text: 'neutral words' }]);
      assert.deepEqual(new Set(first.outcome.changedDocumentIds), new Set([one, two]));
      assert.equal(first.outcome.applied?.chunksUpdated, 4);
      assert.equal(first.outcome.applied?.staged, 1);
      assert.match(totalsLine(first, 'chunk rows updated:') ?? '', /chunk rows updated: 4 in 1 batches/);
      assert.match(totalsLine(first, 'vector sync outbox rows added:') ?? '', /vector sync outbox rows added: 0$/);
      assert.equal(await cacheCount(db, a.key), cacheBefore - 1);
      assert.deepEqual(await chunkBodies(db, a.key), bodies, 'chunk ids, content, lexical text and vectors stay equal');
      assert.ok(!rpc.calls.some((call) => !/^rag_(attribute_definitions_for|import_document_attributes)$/.test(call.fn)), 'no other RPC');

      await seedCacheFor(db, a.key, one);
      const cacheSecond = await cacheCount(db, a.key);
      const snapshot = await tenantSnapshot(db, a.key);
      const second = await runImport(rpc, a, file, true);
      assert.equal(second.outcome.exitCode, 0);
      assert.deepEqual(
        [second.outcome.applied?.documentsChanged, second.outcome.applied?.chunksUpdated, second.outcome.applied?.staged, second.outcome.applied?.outboxRows],
        [0, 0, 0, 0],
      );
      assert.equal(second.outcome.applied?.documentsUnchanged, 2);
      assert.equal(second.outcome.applied?.stagedUnchanged, 1);
      assert.deepEqual(second.outcome.changedDocumentIds, []);
      assert.equal(await cacheCount(db, a.key), cacheSecond, 'the cached answer naming an imported document is still there');
      assert.deepEqual(await tenantSnapshot(db, a.key), snapshot);

      const begun = await beginVersion(db, a, later);
      const applied = (await rows(db, 'SELECT * FROM rag_apply_document_attributes(p_tenant_key => $1, p_document_id => $2, p_explicit => NULL)', [a.key, begun]))[0];
      assert.equal(applied?.origin, 'staged');
      await writeChunks(db, a, begun);
      assert.deepEqual((await attributesOf(db, begun)).chunks, [{ alpha_code: 'L-1' }, { alpha_code: 'L-1' }]);
    });

    test('a dry run leaves every row of documents, document_chunks and rag_staged_attributes unchanged', async () => {
      const key = `set-a/${next('item')}`;
      await publishedDocument(db, a, key);
      const file = importFile([{ source_key: key, attributes: { alpha_code: 'D-1' } }, { source_key: `set-a/${next('item')}`, attributes: { alpha_code: 'D-2' } }]);
      const before = await tenantSnapshot(db, a.key);
      const run = await runImport(pgliteRpc(db), a, file, false);
      assert.equal(run.outcome.exitCode, 2);
      assert.equal(run.outcome.dryRun?.documentsChanged, 1);
      assert.equal(run.outcome.dryRun?.staged, 1);
      assert.deepEqual(await tenantSnapshot(db, a.key), before);
    });

    test('an invalid file writes nothing: exit 3, no import call, and the value is never printed', async () => {
      const key = `set-a/${next('item')}`;
      await publishedDocument(db, a, key);
      const file = importFile([{ source_key: key, attributes: { alpha_code: 'V-1' } }, { source_key: `set-a/${next('item')}`, attributes: { delta_text: MARKER } }]);
      const before = await tenantSnapshot(db, a.key);
      const rpc = pgliteRpc(db);
      const run = await runImport(rpc, a, file, true);
      assert.equal(run.outcome.exitCode, 3);
      assert.deepEqual(rpc.calls.map((call) => call.fn), ['rag_attribute_definitions_for']);
      assert.ok(![...run.out, ...run.err].join('\n').includes(MARKER));
      assert.deepEqual(await tenantSnapshot(db, a.key), before);
    });

    test('401 rows run as three batches; a refusal at the second batch exits 1, keeps the first, and a rerun completes with it unchanged', async () => {
      const keys = Array.from({ length: 401 }, (_, index) => `set-b/${next(`item-${index}`)}`);
      const published = await publishedDocument(db, a, keys[0] as string);
      const lines = keys.map((key, index) => ({ source_key: key, attributes: index < 200 ? { alpha_code: `B-${index}` } : { gamma_text: `neutral ${index}` } }));
      const file = importFile(lines);
      let applyCalls = 0;
      const rpc = pgliteRpc(db, async (fn, args) => {
        if (fn !== 'rag_import_document_attributes' || args.p_dry_run !== false) return;
        applyCalls += 1;
        if (applyCalls === 2) await rows(db, "DELETE FROM public.rag_attribute_definitions WHERE tenant_key = $1 AND key = 'gamma_text'", [a.key]);
      });
      const failed = await runImport(rpc, a, file, true);
      assert.equal(failed.outcome.exitCode, 1);
      assert.equal(failed.outcome.batches, 3);
      assert.equal(failed.outcome.batchesApplied, 1);
      assert.ok(failed.err.some((line) => /1 of 3 batches applied/.test(line)), failed.err.join('\n'));
      assert.deepEqual((await attributesOf(db, published)).document, { alpha_code: 'B-0' });
      const stagedAfterFailure = Number(
        (await rows(db, "SELECT count(*)::int AS n FROM rag_staged_attributes WHERE tenant_key = $1 AND source_key LIKE 'set-b/%'", [a.key]))[0]?.n,
      );
      assert.equal(stagedAfterFailure, 199);

      await defineKeys(db, a.key);
      const rerun = await runImport(pgliteRpc(db), a, file, true);
      assert.equal(rerun.outcome.exitCode, 0, rerun.err.join('\n'));
      assert.equal(rerun.outcome.batches, 3);
      assert.equal(rerun.outcome.applied?.documentsUnchanged, 1);
      assert.equal(rerun.outcome.applied?.stagedUnchanged, 199);
      assert.equal(rerun.outcome.applied?.staged, 201);
      assert.equal(rerun.outcome.applied?.chunksUpdated, 0);
      assert.equal(rerun.out.filter((line) => /batch \d of 3:/.test(line)).length, 3);
    });

    if (mode === 'multi-tenant') {
      test("an import for tenant A never touches tenant B's document, chunks or staged rows with the same source key", async () => {
        assert.ok(b);
        const shared = `set-c/${next('item')}`;
        const pendingKey = `set-c/${next('item')}`;
        const docA = await publishedDocument(db, a, shared);
        await publishedDocument(db, b, shared);
        await rows(db, 'SELECT * FROM rag_stage_document_attributes(p_tenant_key => $1, p_rows => $2::jsonb)', [
          b.key,
          JSON.stringify([{ source: SOURCE, source_key: pendingKey, attributes: { alpha_code: 'B-keep' } }]),
        ]);
        const beforeB = await tenantSnapshot(db, b.key);
        const file = importFile([{ source_key: shared, attributes: { alpha_code: 'A-only' } }, { source_key: pendingKey, attributes: { alpha_code: 'A-stage' } }]);
        const run = await runImport(pgliteRpc(db), a, file, true);
        assert.equal(run.outcome.exitCode, 0);
        assert.deepEqual((await attributesOf(db, docA)).document, { alpha_code: 'A-only' });
        assert.deepEqual(await tenantSnapshot(db, b.key), beforeB, "tenant B's rows are byte-equal");
      });
    } else {
      test('single-tenant mode refuses a u: or o: key at the tenant check (exit 64, no RPC)', async () => {
        const file = importFile([{ source_key: 'set-d/item-001', attributes: { alpha_code: 'S-1' } }]);
        for (const key of [`o:${ORG_A}`, `u:${OWNER_A}`]) {
          const rpc = pgliteRpc(db);
          const err: string[] = [];
          const code = await main(['--tenant', key, '--import', file, '--apply'], { out: () => undefined, err: (line) => err.push(line) }, new AbortController().signal, {
            rpc,
            enabled: () => true,
            resolveScope: (tenantKey) => backfillScope(tenantKey, { deploymentMode: 'single-tenant' }),
          });
          assert.equal(code, 64);
          assert.deepEqual(rpc.calls, []);
          assert.ok(err.some((line) => /tenant refused: invalid_tenant/.test(line)));
        }
      });
    }
  });
}
