import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { FakeObjectStore } from '../helpers/fake-object-store';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0311_rag_originals_bucket.sql';

type Row = Record<string, unknown>;

const rowsOf = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

describe('rag-originals bucket migration', () => {
  for (const mode of MODES) {
    test(`${mode}: a private bucket with a 20 MB limit and no storage.objects policy`, async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      try {
        const buckets = await rowsOf(fixture.db, "SELECT id, name, public, file_size_limit::bigint::text AS file_size_limit FROM storage.buckets WHERE id = 'rag-originals'");
        assert.deepEqual(buckets, [{ id: 'rag-originals', name: 'rag-originals', public: false, file_size_limit: '20971520' }]);
        const reaching = await rowsOf(
          fixture.db,
          `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND (COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%rag-originals%' OR COALESCE(qual, '') || COALESCE(with_check, '') NOT LIKE '%bucket_id%')`,
        );
        assert.deepEqual(reaching, [], 'no policy on storage.objects names the bucket or covers every bucket: only the service key reaches it');
      } finally {
        await fixture.db.close();
      }
    });

    test(`${mode}: applying the migration again keeps one bucket and turns a public or resized bucket back to private and 20 MB`, async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      try {
        await fixture.db.query("UPDATE storage.buckets SET public = true, file_size_limit = 1 WHERE id = 'rag-originals'");
        await applyMigrationFiles(fixture.db, [MIGRATION]);
        await applyMigrationFiles(fixture.db, [MIGRATION]);
        const buckets = await rowsOf(fixture.db, "SELECT public, file_size_limit::bigint::text AS file_size_limit FROM storage.buckets WHERE id = 'rag-originals'");
        assert.deepEqual(buckets, [{ public: false, file_size_limit: '20971520' }]);
      } finally {
        await fixture.db.close();
      }
    });
  }
});

describe('rag_get_ingest_origin returns what a rehydrator needs, for its own tenant only', () => {
  let fixture: TwoTenantDatabase;
  let documentA: string;
  let lineageA: string;
  const tenantA = `u:${TWO_TENANT_IDS.userA}`;
  const tenantB = `u:${TWO_TENANT_IDS.userB}`;
  const ORIGINAL_PATH = (lineage: string) => `${tenantA}/${lineage}/1/original.md`;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    const begun = await rowsOf(
      fixture.db,
      `SELECT * FROM rag_begin_document_version(
        p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL::uuid, p_source => 'nango', p_source_key => $3, p_filename => $4,
        p_file_sha256 => $5, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general-1', p_profile_version => 1::int)`,
      [tenantA, TWO_TENANT_IDS.userA, 'drive/folder/handbook.md', '合同.md', crypto.createHash('sha256').update('originals-a').digest('hex')],
    );
    documentA = String(begun[0]?.document_id);
    lineageA = String(begun[0]?.lineage_id);
    await fixture.db.query('SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => $3::jsonb)', [
      documentA,
      tenantA,
      JSON.stringify({ original_path: ORIGINAL_PATH(lineageA) }),
    ]);
  });

  after(async () => {
    await fixture?.db.close();
  });

  test('the owner reads lineage id, original path, source and source key', async () => {
    const rows = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_origin(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    assert.deepEqual(rows, [{ lineage_id: lineageA, original_path: ORIGINAL_PATH(lineageA), source: 'nango', source_key: 'drive/folder/handbook.md' }]);
    const [document] = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    assert.equal(document?.filename, '合同.md');
    assert.equal('original_path' in (document ?? {}), false, 'the 0310 function keeps its result columns, so 0310 can be applied again');
  });

  test('another tenant gets no row for the same id, so neither the path nor the lineage leaks', async () => {
    const foreign = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_origin(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantB]);
    assert.deepEqual(foreign, []);
    const org = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_origin(p_document_id => $1, p_tenant_key => $2)', [documentA, `o:${TWO_TENANT_IDS.orgO}`]);
    assert.deepEqual(org, []);
    const unknown = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_origin(p_document_id => $1, p_tenant_key => $2)', [
      '00000000-0000-4000-8000-0000000000aa',
      tenantA,
    ]);
    assert.deepEqual(unknown, []);
  });

  test('the function is still executable by service_role only', async () => {
    const privileges = await rowsOf(
      fixture.db,
      `SELECT r AS role, has_function_privilege(r, 'rag_get_ingest_origin(uuid, text)', 'EXECUTE') AS can_execute
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r ORDER BY r`,
    );
    assert.deepEqual(privileges, [
      { role: 'anon', can_execute: false },
      { role: 'authenticated', can_execute: false },
      { role: 'service_role', can_execute: true },
    ]);
    const exposed = await rowsOf(
      fixture.db,
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_%' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    );
    assert.deepEqual(exposed, []);
  });

  test('applying the migration a second time changes nothing the function returns', async () => {
    const before = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_origin(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    await applyMigrationFiles(fixture.db, [MIGRATION]);
    const after = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_origin(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    assert.deepEqual(after, before);
  });
});

const MARKDOWN = [
  '# Dock Rules',
  '',
  'Forklift batteries rotate every shift under the zebra quartz seventeen policy and the staff follow the rules.',
  '',
  '## Receiving Dock',
  '',
  'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four for the team.',
  '',
  '## Shipping Cage',
  '',
  'Outbound pallets leave through the shipping cage after the supervisor signs the manifest for the carrier.',
  '',
].join('\n');

const POLICY_TEXT = [
  '# Receiving Policy',
  '',
  'See https://docs.example.com/receiving-guide for the full rules, effective 2025-03-14 for every warehouse crew.',
  '',
  '## Night Shift',
  '',
  'The night crew scans every pallet at the dock on 14 March 2025 and stages it beside bay four for the morning team.',
  '',
  '## Outbound',
  '',
  'Outbound pallets leave through the shipping cage after the supervisor signs the manifest, see https://docs.example.com/outbound for details.',
  '',
].join('\n');

const BIG_TEXT = Array.from(
  { length: 80 },
  (_, index) => `## Bay ${index + 1}\n\nPallet group ${index + 1} rolls through bay ${index + 1}, where the crew ${'scans every carton and notes the count for the supervisor '.repeat(3)}\n`,
).join('\n');

describe('ingest stores the original and the parse output, and resume rebuilds its inputs from them', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let store: FakeObjectStore;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let storeModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    storeModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  const install = () => {
    store = fakeStoreModule.createFakeObjectStore();
    storeModule.setObjectStoreForTests(store);
  };

  afterEach(() => {
    depsModule.resetIngestDepsForTests();
    storeModule.resetObjectStoreForTests();
    mock.restoreAll();
  });

  const scopeOf = async (userId: string) => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const uploadText = async (userId: string, text: string, filename: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text,
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const uploadFile = async (userId: string, file: Uint8Array, filename: string, mimeType: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      file,
      filename,
      mimeType,
      signal: new AbortController().signal,
    });

  const documentRow = async (documentId: string) =>
    (await rowsOf(fixture.db, 'SELECT filename, status, lineage_id, version, original_path, processing_state FROM documents WHERE id = $1', [documentId]))[0] as Row;

  const chunkCount = async (documentId: string) =>
    Number((await rowsOf(fixture.db, 'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [documentId]))[0]?.n);

  test('a Markdown text upload stores original.md and parse.md under the tenant, lineage and version and records original_path', async () => {
    install();
    const result = await uploadText(TWO_TENANT_IDS.userA, MARKDOWN, 'dock-rules.md');

    assert.equal(result.status, 'ready');
    assert.ok(result.documentId);
    const row = await documentRow(result.documentId);
    const prefix = `u:${TWO_TENANT_IDS.userA}/${String(row.lineage_id)}/1/`;
    assert.equal(row.original_path, `${prefix}original.md`);
    assert.deepEqual(store.keys(), [`${prefix}original.md`, `${prefix}parse.md`]);
    assert.equal(new TextDecoder().decode(store.objects.get(`${prefix}original.md`)?.bytes), MARKDOWN);
    assert.equal(new TextDecoder().decode(store.objects.get(`${prefix}parse.md`)?.bytes), MARKDOWN);
    assert.equal(store.objects.get(`${prefix}original.md`)?.contentType, 'text/markdown');
    const artifacts = (row.processing_state as { artifacts: Record<string, string> }).artifacts;
    assert.deepEqual(artifacts, { 'original.md': `${prefix}original.md`, 'parse.md': `${prefix}parse.md` });
  });

  test('bytes named 合同.txt are stored as original.txt while the filename column keeps 合同.txt', async () => {
    install();
    const bytes = new TextEncoder().encode('合同条款：付款期限为三十天。\n\n第二条：交付地点为上海仓库，由乙方负责运输并承担费用。\n');
    const result = await uploadFile(TWO_TENANT_IDS.userB, bytes, '合同.txt', 'text/plain');

    assert.equal(result.status, 'ready');
    assert.ok(result.documentId);
    const row = await documentRow(result.documentId);
    const prefix = `u:${TWO_TENANT_IDS.userB}/${String(row.lineage_id)}/1/`;
    assert.equal(row.filename, '合同.txt');
    assert.equal(row.original_path, `${prefix}original.txt`);
    assert.deepEqual(store.keys(), [`${prefix}original.txt`, `${prefix}parse.md`]);
    assert.deepEqual(Array.from(store.objects.get(`${prefix}original.txt`)?.bytes ?? []), Array.from(bytes));
    assert.equal(store.objects.get(`${prefix}original.txt`)?.contentType, 'text/plain');
  });

  test("one tenant's upload never writes under another tenant's prefix", async () => {
    install();
    const a = await uploadText(TWO_TENANT_IDS.userA, `${MARKDOWN}\nA note only tenant A has written down.\n`, 'tenant-a.md');
    const b = await uploadText(TWO_TENANT_IDS.userB, `${MARKDOWN}\nA note only tenant B has written down.\n`, 'tenant-b.md');
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
    const keys = store.keys();
    assert.equal(keys.length, 4);
    assert.equal(keys.filter((key) => key.startsWith(`u:${TWO_TENANT_IDS.userA}/`)).length, 2);
    assert.equal(keys.filter((key) => key.startsWith(`u:${TWO_TENANT_IDS.userB}/`)).length, 2);
  });

  test('a storage failure on the original fails the run with store_original_failed, writes no chunks, and a retry after the outage succeeds', async () => {
    install();
    store.failOn('put');
    const text = `${MARKDOWN}\nA closing note for the outage test.\n`;
    const failed = await uploadText(TWO_TENANT_IDS.userA, text, 'outage.md');

    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'store_original_failed');
    assert.ok(failed.documentId);
    assert.equal(await chunkCount(failed.documentId), 0);
    assert.equal((await documentRow(failed.documentId)).status, 'failed');
    assert.deepEqual(store.keys(), []);

    store.heal();
    const retried = await uploadText(TWO_TENANT_IDS.userA, text, 'outage.md');
    assert.equal(retried.status, 'ready');
    assert.ok(retried.documentId);
    assert.ok((await chunkCount(retried.documentId)) > 0);
    assert.equal(store.keys().length, 2);
  });

  test('a storage failure on the parse output fails the run with store_parse_output_failed and writes no chunks', async () => {
    install();
    store.failIf((op, key) => op === 'put' && key.endsWith('/parse.md'));
    const failed = await uploadText(TWO_TENANT_IDS.userA, `${MARKDOWN}\nA closing note for the parse output test.\n`, 'parse-outage.md');

    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'store_parse_output_failed');
    assert.ok(failed.documentId);
    assert.equal(await chunkCount(failed.documentId), 0);
  });

  test('a skipped duplicate stores nothing: same bytes again, and the same content with other line endings', async () => {
    install();
    const first = await uploadText(TWO_TENANT_IDS.userA, `${MARKDOWN}\nA closing note for the duplicate test.\n`, 'dup.md');
    assert.equal(first.status, 'ready');
    const keysAfterFirst = store.keys();
    assert.equal(keysAfterFirst.length, 2);
    const putsAfterFirst = store.calls.filter((call) => call.op === 'put').length;

    const sameBytes = await uploadText(TWO_TENANT_IDS.userA, `${MARKDOWN}\nA closing note for the duplicate test.\n`, 'dup.md');
    assert.equal(sameBytes.status, 'skipped_duplicate');
    assert.equal(store.calls.filter((call) => call.op === 'put').length, putsAfterFirst, 'file hash duplicate: no put');

    const crlf = await uploadText(TWO_TENANT_IDS.userA, `${MARKDOWN}\nA closing note for the duplicate test.\n`.replace(/\n/g, '\r\n'), 'dup-crlf.md');
    assert.equal(crlf.status, 'skipped_duplicate');
    assert.deepEqual(store.keys(), keysAfterFirst, 'content hash duplicate: what it stored is removed again');
  });

  beforeEach(() => install());

  /** The text gets a line naming the file, so two tests never upload the same bytes into one tenant (that would be a duplicate). */
  const upload = async (userId: string, text: string, filename: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text: `${text}\nThis copy belongs to ${filename}.\n`,
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const JUMP_MS = 60_000;

  /** The clock jumps past the request deadline once the named stage has saved its state, so the next stage yields. */
  const interruptAfter = (stage: string) => {
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    let clock = 1_000_000;
    let armed = true;
    const db: RpcClient = {
      rpc(fn, args) {
        const state = args.p_state as { lastCompleted?: string } | undefined;
        if (armed && fn === 'rag_save_ingest_state' && state?.lastCompleted === stage) {
          clock += JUMP_MS;
          armed = false;
        }
        return real.rpc(fn, args);
      },
    };
    depsModule.setIngestDepsForTests({ db: () => db, now: () => clock });
  };

  /** A process that dies right after its first chunk batch is written: every later call, cleanup included, fails. */
  const dieAfterFirstBatch = () => {
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    let dead = false;
    let batches = 0;
    const refuse = () => {
      const response: RpcResponse = { data: null, error: { code: '57014', message: 'killed' } };
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: Parameters<Promise<RpcResponse>['then']>[0], onRejected: Parameters<Promise<RpcResponse>['then']>[1]) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request as unknown as ReturnType<RpcClient['rpc']>;
    };
    const db: RpcClient = {
      rpc(fn, args) {
        if (dead) return refuse();
        const request = real.rpc(fn, args);
        if (fn !== 'rag_write_chunks') return request;
        batches += 1;
        const wrapped = {
          abortSignal(signal: AbortSignal) {
            request.abortSignal(signal);
            return wrapped;
          },
          then: (onFulfilled: Parameters<Promise<RpcResponse>['then']>[0], onRejected: Parameters<Promise<RpcResponse>['then']>[1]) =>
            request
              .then((response) => {
                dead = true;
                return response;
              })
              .then(onFulfilled, onRejected),
        };
        return wrapped as unknown as ReturnType<RpcClient['rpc']>;
      },
    };
    depsModule.setIngestDepsForTests({ db: () => db });
    return () => batches;
  };

  const shape = (documentId: string) =>
    rowsOf(
      fixture.db,
      'SELECT chunk_index, content, content_hash, lexical_text, section_path, language, chunk_kind, metadata, embedding IS NOT NULL AS embedded FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );

  const idsFollowTheRule = async (documentId: string) =>
    (
      await rowsOf(
        fixture.db,
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE id = substr(encode(sha256(convert_to(document_id::text || ':' || chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid)::int AS ruled
         FROM document_chunks WHERE document_id = $1`,
        [documentId],
      )
    )[0] as { total: number; ruled: number };

  const state = async (documentId: string) =>
    (await rowsOf(fixture.db, 'SELECT status, processing_state FROM documents WHERE id = $1', [documentId]))[0] as { status: string; processing_state: Record<string, unknown> };

  test('a run stopped by the deadline right after parse resumes with no file bytes and ends as an uninterrupted run does', async () => {
    interruptAfter('parse');
    const interrupted = await upload(TWO_TENANT_IDS.userA, POLICY_TEXT, 'policy.md');
    assert.equal(interrupted.status, 'processing');
    assert.equal(interrupted.reason, 'deadline');
    assert.ok(interrupted.documentId);
    assert.equal((await state(interrupted.documentId)).processing_state.lastCompleted, 'parse');
    assert.equal((await shape(interrupted.documentId)).length, 0);

    depsModule.resetIngestDepsForTests();
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId);
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.documentId, interrupted.documentId);

    const twin = await upload(TWO_TENANT_IDS.userB, POLICY_TEXT, 'policy.md');
    assert.equal(twin.status, 'ready');
    assert.ok(twin.documentId);
    const resumedChunks = await shape(interrupted.documentId);
    assert.ok(resumedChunks.length >= 3);
    assert.deepEqual(resumedChunks, await shape(twin.documentId), 'chunk text, hashes, lexical text, path, language and metadata match the uninterrupted run');
    const ids = await idsFollowTheRule(interrupted.documentId);
    assert.deepEqual(ids, { total: resumedChunks.length, ruled: resumedChunks.length });
  });

  test('a run stopped before embed resumes with the same chunk metadata as an uninterrupted run, URL keys included', async () => {
    interruptAfter('images');
    const interrupted = await upload(TWO_TENANT_IDS.userA, POLICY_TEXT, 'policy-late.md');
    assert.equal(interrupted.status, 'processing');
    assert.ok(interrupted.documentId);

    depsModule.resetIngestDepsForTests();
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId);
    assert.equal(resumed.status, 'ready');
    const twin = await upload(TWO_TENANT_IDS.userB, POLICY_TEXT, 'policy-late.md');
    assert.ok(twin.documentId);

    const resumedChunks = await shape(interrupted.documentId);
    const twinChunks = await shape(twin.documentId);
    assert.deepEqual(resumedChunks, twinChunks);
    assert.ok(resumedChunks.some((chunk) => (chunk.metadata as Row).has_urls === true), 'the URL metadata of enrich is rebuilt');
    assert.deepEqual(await idsFollowTheRule(interrupted.documentId), { total: resumedChunks.length, ruled: resumedChunks.length });
  });

  test('a process that dies after the first embed batch leaves a resumable document, and the resume ends with one set of chunks', async () => {
    const batches = dieAfterFirstBatch();
    const died = await upload(TWO_TENANT_IDS.userA, BIG_TEXT, 'bays.md');
    assert.equal(died.status, 'failed');
    assert.ok(died.documentId);
    assert.equal(batches(), 1);
    const partial = await shape(died.documentId);
    assert.ok(partial.length > 0, 'the first batch is in the database');
    assert.equal((await state(died.documentId)).status, 'processing', 'the cleanup never ran, so the document is still resumable');

    depsModule.resetIngestDepsForTests();
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), died.documentId);
    assert.equal(resumed.status, 'ready');

    const twin = await upload(TWO_TENANT_IDS.userB, BIG_TEXT, 'bays.md');
    assert.ok(twin.documentId);
    const resumedChunks = await shape(died.documentId);
    assert.ok(resumedChunks.length > partial.length, 'more than one batch was needed');
    assert.equal(new Set(resumedChunks.map((chunk) => chunk.chunk_index)).size, resumedChunks.length, 'no duplicate chunk');
    assert.deepEqual(resumedChunks.map((chunk) => chunk.chunk_index), resumedChunks.map((_, index) => index));
    assert.ok(resumedChunks.every((chunk) => chunk.embedded === true));
    assert.deepEqual(resumedChunks, await shape(twin.documentId));
    assert.deepEqual(await idsFollowTheRule(died.documentId), { total: resumedChunks.length, ruled: resumedChunks.length });
  });

  test('without parse.md the resume parses the stored original again and stores parse.md anew', async () => {
    interruptAfter('images');
    const interrupted = await upload(TWO_TENANT_IDS.userA, POLICY_TEXT, 'policy-reparse.md');
    assert.ok(interrupted.documentId);
    const parseKey = store.keys().find((key) => key.endsWith('/parse.md')) as string;
    assert.ok(parseKey);
    store.objects.delete(parseKey);

    depsModule.resetIngestDepsForTests();
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId);

    assert.equal(resumed.status, 'ready');
    assert.ok(store.keys().includes(parseKey), 'parse.md is stored again');
    const twin = await upload(TWO_TENANT_IDS.userB, POLICY_TEXT, 'policy-reparse.md');
    assert.ok(twin.documentId);
    assert.deepEqual(await shape(interrupted.documentId), await shape(twin.documentId));
  });

  test('without parse.md and without the original the resume fails as original_unavailable and writes no chunks', async () => {
    interruptAfter('images');
    const interrupted = await upload(TWO_TENANT_IDS.userA, POLICY_TEXT, 'policy-lost.md');
    assert.ok(interrupted.documentId);
    store.objects.clear();

    depsModule.resetIngestDepsForTests();
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId);

    assert.equal(resumed.status, 'failed');
    assert.equal(resumed.reason, 'original_unavailable');
    assert.equal((await shape(interrupted.documentId)).length, 0);
    assert.equal((await state(interrupted.documentId)).status, 'failed');
  });

  test('a run stopped before the original was stored cannot resume without the file: it reports resume_input_unavailable and touches nothing', async () => {
    interruptAfter('file_hash_dedup');
    const interrupted = await upload(TWO_TENANT_IDS.userA, POLICY_TEXT, 'policy-early.md');
    assert.equal(interrupted.status, 'processing');
    assert.ok(interrupted.documentId);
    assert.deepEqual(store.calls, []);

    depsModule.resetIngestDepsForTests();
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId);

    assert.equal(resumed.status, 'processing');
    assert.equal(resumed.reason, 'resume_input_unavailable');
    assert.deepEqual(store.calls, []);
    assert.equal((await state(interrupted.documentId)).status, 'processing');
  });

  test("another tenant cannot resume the document, and a path outside the tenant's prefix is never read", async () => {
    interruptAfter('images');
    const interrupted = await upload(TWO_TENANT_IDS.userA, POLICY_TEXT, 'policy-foreign.md');
    assert.ok(interrupted.documentId);
    const callsBefore = store.calls.length;

    depsModule.resetIngestDepsForTests();
    const foreign = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userB), interrupted.documentId);
    assert.equal(foreign.status, 'failed');
    assert.equal(foreign.reason, 'document_not_found');
    assert.equal(store.calls.length, callsBefore, 'no store call for a document of another tenant');

    const row = (await rowsOf(fixture.db, 'SELECT lineage_id FROM documents WHERE id = $1', [interrupted.documentId]))[0] as Row;
    const foreignKey = `u:${TWO_TENANT_IDS.userB}/${String(row.lineage_id)}/1/original.md`;
    await store.put(foreignKey, new TextEncoder().encode('# Not yours\n\nText that belongs to another tenant entirely.\n'), { contentType: 'text/markdown' });
    await fixture.db.query('UPDATE documents SET original_path = $2 WHERE id = $1', [interrupted.documentId, foreignKey]);
    const parseKey = store.keys().find((key) => key.endsWith('/parse.md') && key.startsWith(`u:${TWO_TENANT_IDS.userA}/`)) as string;
    store.objects.delete(parseKey);
    const callsMark = store.calls.length;

    const tampered = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId);
    assert.equal(tampered.status, 'failed');
    assert.equal(tampered.reason, 'original_unavailable');
    assert.equal(store.calls.slice(callsMark).filter((call) => call.key.startsWith(`u:${TWO_TENANT_IDS.userB}/`)).length, 0, "the other tenant's object was not read");
  });
});
