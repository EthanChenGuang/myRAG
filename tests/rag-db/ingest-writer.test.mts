import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const FOREIGN_USER_KEY = 'u:00000000-0000-4000-8000-000000000999';
const WRITER_FUNCTIONS = [
  'rag_begin_document_version',
  'rag_find_content_duplicate',
  'rag_get_ingest_document',
  'rag_mark_document_failed',
  'rag_save_ingest_state',
  'rag_set_document_fields',
];

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

interface Ctx {
  mode: DeploymentMode;
  fixture: FixtureDatabase;
  db: PGlite;
  a: Tenant;
  b: Tenant | null;
  org: Tenant | null;
}

interface BeginArgs {
  tenant: Tenant;
  userId: string | null | undefined;
  source: string;
  sourceKey: string;
  filename: string;
  sha: string | null;
  docType: string | null;
  origin: string | null;
  profileId: string;
  profileVersion: number;
}

interface BeginRow {
  outcome: string;
  document_id: string | null;
  version: number | null;
  lineage_id: string | null;
  duplicate_of: string | null;
}

async function createCtx(mode: DeploymentMode): Promise<Ctx> {
  if (mode === 'single-tenant') {
    const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
    return { mode, fixture, db: fixture.db, a: { key: 's:default', userId: null, orgId: null }, b: null, org: null };
  }
  const fixture = await createTwoTenantDatabase();
  return {
    mode,
    fixture,
    db: fixture.db,
    a: { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA, orgId: null },
    b: { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB, orgId: null },
    org: { key: `o:${TWO_TENANT_IDS.orgO}`, userId: TWO_TENANT_IDS.userA, orgId: TWO_TENANT_IDS.orgO },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function call(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 60).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

let sequence = 0;
const uniqueKey = (label: string): string => `${label}-${++sequence}.md`;
const sha = (label: string): string => crypto.createHash('sha256').update(`${label}-${++sequence}`).digest('hex');

const BEGIN_SQL = `SELECT * FROM rag_begin_document_version(
  p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => $3::uuid, p_source => $4, p_source_key => $5, p_filename => $6,
  p_file_sha256 => $7, p_doc_type => $8, p_doc_type_origin => $9, p_profile_id => $10, p_profile_version => $11::int)`;

function beginParams(ctx: Ctx, args: Partial<BeginArgs> & { sourceKey: string }): unknown[] {
  const tenant = args.tenant ?? ctx.a;
  return [
    tenant.key,
    args.userId === undefined ? tenant.userId : args.userId,
    tenant.orgId,
    args.source ?? 'config_upload',
    args.sourceKey,
    args.filename ?? 'writer-fixture.md',
    args.sha === undefined ? sha('file') : args.sha,
    args.docType === undefined ? 'general' : args.docType,
    args.origin === undefined ? 'fallback' : args.origin,
    args.profileId ?? 'general-1',
    args.profileVersion ?? 1,
  ];
}

async function begin(ctx: Ctx, args: Partial<BeginArgs> & { sourceKey: string }): Promise<BeginRow> {
  const rows = await call(ctx.db, BEGIN_SQL, beginParams(ctx, args));
  assert.equal(rows.length, 1, 'begin returns exactly one row');
  return rows[0] as unknown as BeginRow;
}

async function beginError(ctx: Ctx, args: Partial<BeginArgs> & { sourceKey: string }): Promise<string | null> {
  return errorOf(ctx.db, BEGIN_SQL, beginParams(ctx, args));
}

async function docRow(ctx: Ctx, id: string | null): Promise<Row> {
  const rows = await call(ctx.db, 'SELECT * FROM documents WHERE id = $1', [id]);
  assert.equal(rows.length, 1, `document ${String(id)} exists`);
  return rows[0] as Row;
}

async function makeCurrent(ctx: Ctx, id: string | null): Promise<void> {
  await call(ctx.db, "UPDATE documents SET is_current = true, status = 'ready' WHERE id = $1", [id]);
}

function wrongTenantKey(ctx: Ctx): string {
  return ctx.b?.key ?? FOREIGN_USER_KEY;
}

function setFields(ctx: Ctx, id: string | null, tenantKey: string, fields: unknown): Promise<string | null> {
  return errorOf(ctx.db, 'SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => $3::jsonb)', [
    id,
    tenantKey,
    JSON.stringify(fields),
  ]);
}

for (const mode of MODES) {
  describe(`ingest writer: begin, lookup, fields and state (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: (t: TestContext) => Promise<void>) => test(`${name} [${mode}]`, run);
    before(async () => {
      ctx = await createCtx(mode);
    });
    after(async () => {
      await ctx?.db.close();
    });

    it('begin on a new identity creates version 1 as a non-current processing row with its own lineage', async () => {
      const key = uniqueKey('new-identity');
      const file = sha('new');
      const row = await begin(ctx, { sourceKey: key, sha: file, filename: 'New Identity.md', docType: 'financial_report', origin: 'picked', profileId: 'financial-1', profileVersion: 3 });
      assert.equal(row.outcome, 'created');
      assert.equal(row.version, 1);
      assert.equal(row.lineage_id, row.document_id);
      assert.equal(row.duplicate_of, null);
      const doc = await docRow(ctx, row.document_id);
      assert.equal(doc.is_current, false);
      assert.equal(doc.status, 'processing');
      assert.equal(doc.tenant_key, ctx.a.key);
      assert.equal(doc.source, 'config_upload');
      assert.equal(doc.source_key, key);
      assert.equal(doc.file_sha256, file);
      assert.equal(doc.filename, 'New Identity.md');
      assert.equal(doc.doc_type, 'financial_report');
      assert.equal(doc.doc_type_origin, 'picked');
      assert.equal(doc.processing_profile_id, 'financial-1');
      assert.equal(doc.processing_profile_version, 3);
    });

    it('begin with a file_sha256 that a current document of the same tenant has returns skipped_duplicate and creates nothing', async () => {
      const file = sha('dup');
      const first = await begin(ctx, { sourceKey: uniqueKey('dup-first'), sha: file });
      await makeCurrent(ctx, first.document_id);
      const other = await begin(ctx, { sourceKey: uniqueKey('dup-second'), sha: file });
      assert.equal(other.outcome, 'skipped_duplicate');
      assert.equal(other.duplicate_of, first.document_id);
      assert.equal(other.document_id, null);
      const same = await call(ctx.db, 'SELECT count(*)::int AS n FROM documents WHERE file_sha256 = $1', [file]);
      assert.equal(same[0]?.n, 1);
      const sameIdentity = await begin(ctx, { sourceKey: (await docRow(ctx, first.document_id)).source_key as string, sha: file });
      assert.equal(sameIdentity.outcome, 'skipped_duplicate');
      assert.equal(sameIdentity.duplicate_of, first.document_id);
    });

    it('the same file hash in another tenant is ingested normally', async (t) => {
      const other = ctx.b;
      if (other === null) return t.skip('single-tenant has one tenant');
      const file = sha('cross');
      const first = await begin(ctx, { sourceKey: uniqueKey('cross-a'), sha: file });
      await makeCurrent(ctx, first.document_id);
      const second = await begin(ctx, { tenant: other, sourceKey: uniqueKey('cross-b'), sha: file });
      assert.equal(second.outcome, 'created');
      assert.equal(second.duplicate_of, null);
      assert.equal((await docRow(ctx, second.document_id)).tenant_key, other.key);
    });

    it('begin twice for the same identity and hash while the first is processing returns the first row', async () => {
      const key = uniqueKey('resume');
      const file = sha('resume');
      const first = await begin(ctx, { sourceKey: key, sha: file });
      const again = await begin(ctx, { sourceKey: key, sha: file });
      assert.equal(first.outcome, 'created');
      assert.equal(again.outcome, 'resumed');
      assert.equal(again.document_id, first.document_id);
      assert.equal(again.version, 1);
      const rows = await call(ctx.db, 'SELECT count(*)::int AS n FROM documents WHERE tenant_key = $1 AND source_key = $2', [ctx.a.key, key]);
      assert.equal(rows[0]?.n, 1);
    });

    it('begin for an identity whose current row has another hash makes version 2 in the same lineage with external_url copied and no content_type or slug', async () => {
      const key = uniqueKey('versioned');
      const first = await begin(ctx, { sourceKey: key, sha: sha('v1') });
      await makeCurrent(ctx, first.document_id);
      await call(ctx.db, 'UPDATE documents SET metadata = $2::jsonb WHERE id = $1', [
        first.document_id,
        JSON.stringify({ external_url: 'https://example.invalid/page', scratch_note: 'not user set' }),
      ]);
      if (ctx.mode === 'multi-tenant') {
        await call(ctx.db, "UPDATE documents SET content_type = 'faq', slug = $2 WHERE id = $1", [first.document_id, `slug-${sequence}`]);
      }
      const second = await begin(ctx, { sourceKey: key, sha: sha('v2') });
      assert.equal(second.outcome, 'created');
      assert.equal(second.version, 2);
      assert.equal(second.lineage_id, first.lineage_id);
      assert.notEqual(second.document_id, first.document_id);
      const doc = await docRow(ctx, second.document_id);
      assert.equal(doc.is_current, false);
      assert.equal(doc.status, 'processing');
      assert.deepEqual(doc.metadata, { external_url: 'https://example.invalid/page' });
      if (ctx.mode === 'multi-tenant') {
        assert.equal(doc.content_type, null);
        assert.equal(doc.slug, null);
      }
      const old = await docRow(ctx, first.document_id);
      assert.equal(old.is_current, true, 'beginning a version does not touch the current row');
      const third = await begin(ctx, { sourceKey: key, sha: sha('v3') });
      assert.equal(third.version, 3, 'a new hash while version 2 is still processing is the next version of the lineage');
      assert.equal(third.lineage_id, first.lineage_id);
    });

    it('begin rejects a source outside the widened set and creates nothing', async () => {
      const key = uniqueKey('bad-source');
      const message = await beginError(ctx, { sourceKey: key, source: 'upload' });
      assert.match(message ?? '', /invalid_source/);
      const rows = await call(ctx.db, 'SELECT count(*)::int AS n FROM documents WHERE source_key = $1', [key]);
      assert.equal(rows[0]?.n, 0);
    });

    it('rag_find_content_duplicate finds the same-tenant current document and nothing across tenants', async () => {
      const hash = `content-${sha('content')}`;
      const original = await begin(ctx, { sourceKey: uniqueKey('content-original') });
      await call(ctx.db, 'UPDATE documents SET content_hash = $2 WHERE id = $1', [original.document_id, hash]);
      const incoming = await begin(ctx, { sourceKey: uniqueKey('content-incoming') });
      const find = (tenantKey: string, id: string | null) =>
        call(ctx.db, 'SELECT * FROM rag_find_content_duplicate(p_tenant_key => $1, p_content_hash => $2, p_document_id => $3)', [tenantKey, hash, id]);
      assert.deepEqual(await find(ctx.a.key, incoming.document_id), [], 'a processing row is not a duplicate target');
      await makeCurrent(ctx, original.document_id);
      const found = await find(ctx.a.key, incoming.document_id);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.duplicate_of, original.document_id);
      assert.deepEqual(await find(ctx.a.key, original.document_id), [], 'a document is never a duplicate of itself');
      if (ctx.b !== null) {
        const foreign = await begin(ctx, { tenant: ctx.b, sourceKey: uniqueKey('content-foreign') });
        assert.deepEqual(await find(ctx.b.key, foreign.document_id), [], 'the other tenant sees no match');
      }
    });

    it('rag_set_document_fields stores whitelisted keys, merges metadata and keeps untouched columns', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('fields') });
      const id = row.document_id;
      const fields = {
        content_hash: 'hash-1',
        language: 'zh',
        doc_date: '2025-03-01',
        doc_type: 'invoice_receipt',
        doc_type_origin: 'auto',
        parser_used: 'docling',
        parser_version: '2.0.0',
        processing_profile_id: 'invoice-1',
        processing_profile_version: 2,
        original_path: 'rag-originals/tenant/lineage/1/original.pdf',
        source_provider: 'google-drive',
        source_file_id: 'file-1',
        source_connection_id: 'connection-1',
        status: 'quarantined',
        metadata: { external_url: 'https://example.invalid/a' },
      };
      assert.equal(await setFields(ctx, id, ctx.a.key, fields), null);
      assert.equal(await setFields(ctx, id, ctx.a.key, { metadata: { note: 'n' } }), null);
      const rows = await call(ctx.db, 'SELECT *, doc_date::text AS doc_date_text FROM documents WHERE id = $1', [id]);
      const doc = rows[0] as Row;
      for (const [name, value] of Object.entries(fields)) {
        if (name === 'metadata' || name === 'doc_date') continue;
        assert.equal(doc[name], value, name);
      }
      assert.equal(doc.doc_date_text, '2025-03-01');
      assert.deepEqual(doc.metadata, { external_url: 'https://example.invalid/a', note: 'n' });
      assert.equal(doc.is_current, false);
      assert.equal(doc.tenant_key, ctx.a.key);
      assert.equal(await setFields(ctx, id, ctx.a.key, { language: null }), null);
      assert.equal((await docRow(ctx, id)).language, null, 'an explicit null clears the column');
    });

    it('rag_set_document_fields rejects keys outside the whitelist and a status it does not own', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('fields-reject') });
      const id = row.document_id;
      for (const key of ['tenant_key', 'is_current', 'version', 'lineage_id', 'superseded_by', 'id', 'organization_id', 'user_id', 'not_a_column']) {
        const message = await setFields(ctx, id, ctx.a.key, { [key]: key === 'is_current' ? true : 'x' });
        assert.match(message ?? '', /invalid_field/, key);
      }
      assert.match((await setFields(ctx, id, ctx.a.key, { status: 'ready' })) ?? '', /invalid_status/);
      assert.match((await setFields(ctx, id, ctx.a.key, { language: 'en', is_current: true })) ?? '', /invalid_field/);
      assert.match((await setFields(ctx, id, ctx.a.key, { metadata: 'text' })) ?? '', /invalid_metadata/);
      const doc = await docRow(ctx, id);
      assert.equal(doc.language, null, 'a rejected call changes nothing');
      assert.equal(doc.status, 'processing');
      assert.equal(doc.is_current, false);
    });

    it('rag_set_document_fields stores the parsed text in content and leaves it alone when the key is absent', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('content') });
      const id = row.document_id;
      const parsed = 'First line of the parsed text.\n\nSecond paragraph with a tab\tand a quote " and a backslash \\.';
      const failure = await setFields(ctx, id, ctx.a.key, { content: parsed });
      assert.equal(failure, null, 'content is an allowed field');
      assert.equal((await docRow(ctx, id)).content, parsed);
      assert.equal(await setFields(ctx, id, ctx.a.key, { language: 'en' }), null);
      assert.equal((await docRow(ctx, id)).content, parsed, 'a call without content keeps it');
    });

    it('rag_set_document_fields refuses a content that is not text and changes nothing', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('content-type') });
      const id = row.document_id;
      assert.equal(await setFields(ctx, id, ctx.a.key, { content: 'kept' }), null);
      for (const value of [42, true, { a: 1 }, ['x'], null]) {
        const message = await setFields(ctx, id, ctx.a.key, { content: value });
        assert.match(message ?? '', /invalid_field/, JSON.stringify(value));
      }
      assert.equal((await docRow(ctx, id)).content, 'kept');
    });

    it('rag_set_document_fields cannot set content on another tenant\'s document', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('content-tenant') });
      const id = row.document_id;
      const message = await setFields(ctx, id, wrongTenantKey(ctx), { content: 'leaked' });
      assert.match(message ?? '', /tenant_mismatch/);
      assert.equal((await docRow(ctx, id)).content, '', 'the row is untouched');
    });

    it('rag_save_ingest_state and rag_get_ingest_document round-trip the processing state for the tenant only', async () => {
      const key = uniqueKey('state');
      const row = await begin(ctx, { sourceKey: key, filename: 'State Doc.md', docType: 'product_technical', origin: 'tenant_default' });
      const state = { stage: 'chunk', done: ['identify', 'parse'], cursor: 12 };
      const saved = await call(
        ctx.db,
        'SELECT * FROM rag_save_ingest_state(p_document_id => $1, p_tenant_key => $2, p_processing_status => $3, p_state => $4::jsonb)',
        [row.document_id, ctx.a.key, 'chunking', JSON.stringify(state)],
      );
      assert.equal(saved.length, 1);
      const read = (tenantKey: string) =>
        call(ctx.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [row.document_id, tenantKey]);
      const got = await read(ctx.a.key);
      assert.equal(got.length, 1);
      const first = got[0] as Row;
      assert.equal(first.status, 'processing');
      assert.equal(first.version, 1);
      assert.equal(first.processing_status, 'chunking');
      assert.deepEqual(first.processing_state, state);
      assert.equal(first.filename, 'State Doc.md');
      assert.equal(first.doc_type, 'product_technical');
      assert.equal(first.parser_used, null);
      assert.ok(first.created_at !== null && first.created_at !== undefined);
      assert.deepEqual(await read(wrongTenantKey(ctx)), [], 'another tenant gets nothing');
      assert.deepEqual(await read(ctx.a.key.replace(/.$/, 'f')), [], 'a different key gets nothing');
    });

    it('rag_mark_document_failed records the reason and never takes the current version down', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('failed') });
      const failed = await call(ctx.db, 'SELECT * FROM rag_mark_document_failed(p_document_id => $1, p_tenant_key => $2, p_reason => $3)', [
        row.document_id,
        ctx.a.key,
        'parser timeout',
      ]);
      assert.equal(failed.length, 1);
      const doc = await docRow(ctx, row.document_id);
      assert.equal(doc.status, 'failed');
      assert.equal(doc.processing_status, 'failed');
      assert.equal((doc.processing_state as Row).failure_reason, 'parser timeout');
      assert.equal(doc.is_current, false);

      const live = await begin(ctx, { sourceKey: uniqueKey('failed-current') });
      await makeCurrent(ctx, live.document_id);
      const message = await errorOf(ctx.db, 'SELECT * FROM rag_mark_document_failed(p_document_id => $1, p_tenant_key => $2, p_reason => $3)', [
        live.document_id,
        ctx.a.key,
        'late failure',
      ]);
      assert.match(message ?? '', /document_is_current/);
      assert.equal((await docRow(ctx, live.document_id)).status, 'ready');
    });

    it('a tenant key that is not the row\'s tenant raises tenant_mismatch in every function that takes a document', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('mismatch') });
      const wrong = wrongTenantKey(ctx);
      const id = row.document_id;
      const attempts: Array<[string, string, unknown[]]> = [
        ['rag_set_document_fields', 'SELECT * FROM rag_set_document_fields($1, $2, $3::jsonb)', [id, wrong, '{"language":"en"}']],
        ['rag_save_ingest_state', 'SELECT * FROM rag_save_ingest_state($1, $2, $3, $4::jsonb)', [id, wrong, 'x', '{}']],
        ['rag_mark_document_failed', 'SELECT * FROM rag_mark_document_failed($1, $2, $3)', [id, wrong, 'x']],
        ['rag_find_content_duplicate', 'SELECT * FROM rag_find_content_duplicate($1, $2, $3)', [wrong, 'h', id]],
      ];
      for (const [name, sql, params] of attempts) {
        assert.match((await errorOf(ctx.db, sql, params)) ?? '', /tenant_mismatch/, name);
      }
      const doc = await docRow(ctx, id);
      assert.equal(doc.language, null);
      assert.equal(doc.status, 'processing');
      assert.equal(doc.processing_status, null);
    });

    it('begin raises tenant_mismatch when the tenant key is not the key of the user and organization it was given', async () => {
      const key = uniqueKey('begin-mismatch');
      const message = await beginError(ctx, { tenant: { key: wrongTenantKey(ctx), userId: ctx.a.userId, orgId: ctx.a.orgId }, sourceKey: key });
      assert.match(message ?? '', /tenant_mismatch/);
      const rows = await call(ctx.db, 'SELECT count(*)::int AS n FROM documents WHERE source_key = $1', [key]);
      assert.equal(rows[0]?.n, 0);
    });

    it('single-tenant ignores the user and organization arguments; multi-tenant stores them', async () => {
      const key = uniqueKey('owner');
      const stranger = '00000000-0000-4000-8000-000000000777';
      if (ctx.mode === 'single-tenant') {
        const row = await begin(ctx, { sourceKey: key, userId: stranger });
        const doc = await docRow(ctx, row.document_id);
        assert.equal(doc.user_id, null);
        assert.equal(doc.organization_id, null);
        assert.equal(doc.tenant_key, 's:default');
      } else {
        const org = ctx.org as Tenant;
        const row = await begin(ctx, { tenant: org, sourceKey: key });
        const doc = await docRow(ctx, row.document_id);
        assert.equal(doc.tenant_key, org.key);
        assert.equal(doc.organization_id, org.orgId);
        assert.equal(doc.user_id, org.userId);
        const personal = await begin(ctx, { sourceKey: key });
        const personalDoc = await docRow(ctx, personal.document_id);
        assert.equal(personalDoc.organization_id, null);
        assert.equal(personalDoc.user_id, ctx.a.userId);
        assert.equal(personal.outcome, 'created', 'the same source key in another tenant is another identity');
      }
    });

    it('the writer functions are SECURITY DEFINER, pinned to search_path public and executable by service_role only', async () => {
      const result = await call(
        ctx.db,
        `SELECT p.proname, p.prosecdef, p.proconfig::text AS config, pg_get_functiondef(p.oid) AS def,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY p.proname`,
        [WRITER_FUNCTIONS],
      );
      assert.deepEqual(
        result.map((row) => row.proname),
        WRITER_FUNCTIONS,
      );
      for (const row of result) {
        const name = String(row.proname);
        assert.equal(row.prosecdef, true, `${name} is SECURITY DEFINER`);
        assert.match(String(row.config), /search_path=/, `${name} pins search_path`);
        assert.equal(row.anon_exec, false, `${name} is not executable by anon`);
        assert.equal(row.authenticated_exec, false, `${name} is not executable by authenticated`);
        assert.equal(row.service_exec, true, `${name} is executable by service_role`);
      }
      const begun = result.find((row) => row.proname === 'rag_begin_document_version');
      assert.match(String(begun?.def), /pg_advisory_xact_lock/);
      await assertNoClientCallableRagFunctions(ctx.db);
    });

    it('a call made as anon or authenticated is refused', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('role') });
      const before = await docRow(ctx, row.document_id);
      for (const role of ['anon', 'authenticated']) {
        let message: string | null = null;
        try {
          await ctx.db.exec(`SET ROLE ${role}`);
          message = await errorOf(ctx.db, 'SELECT * FROM rag_set_document_fields($1, $2, $3::jsonb)', [row.document_id, ctx.a.key, '{"language":"en"}']);
        } finally {
          await ctx.db.exec('RESET ROLE');
        }
        assert.match(message ?? '', /permission denied/, role);
      }
      assert.deepEqual(await docRow(ctx, row.document_id), before);
    });
  });
}

const LEGACY_PROFILE = 'openai-3-small-1536';
const CHUNK_FUNCTIONS = ['rag_publish_document_version', 'rag_write_chunks'];
const WRITE_SQL = `SELECT * FROM rag_write_chunks(
  p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => $5::boolean, p_total => $6::int)`;
const PUBLISH_SQL = 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)';

interface WriteOptions {
  label?: string;
  embeddings?: boolean;
  final?: boolean;
  total?: number | null;
  extra?: (index: number) => Row;
}

function chunkText(label: string, index: number): string {
  return `${label} chunk ${index} body text`;
}

function chunkSpecs(count: number, options: WriteOptions): Row[] {
  const label = options.label ?? 'writer';
  return Array.from({ length: count }, (_unused, index) => ({
    chunk_index: index,
    content: chunkText(label, index),
    metadata: { document_title: 'writer-fixture.md', chunk_index: index, chunk_position: index + 1, total_chunks: count, urls: [], has_urls: false },
    ...(options.extra ? options.extra(index) : {}),
  }));
}

function embeddingsFor(count: number, label: string): Row {
  return { [LEGACY_PROFILE]: Array.from({ length: count }, (_unused, index) => embedText(chunkText(label, index))) };
}

async function writeChunks(ctx: Ctx, id: string | null, tenantKey: string, count: number, options: WriteOptions = {}): Promise<Row[]> {
  const embeddings = options.embeddings === false ? {} : embeddingsFor(count, options.label ?? 'writer');
  return call(ctx.db, WRITE_SQL, [
    id,
    tenantKey,
    JSON.stringify(chunkSpecs(count, options)),
    JSON.stringify(embeddings),
    options.final ?? false,
    options.total === undefined ? null : options.total,
  ]);
}

function writeError(ctx: Ctx, id: string | null, tenantKey: string, chunks: unknown, embeddings: unknown, final = false, total: number | null = null): Promise<string | null> {
  return errorOf(ctx.db, WRITE_SQL, [id, tenantKey, JSON.stringify(chunks), JSON.stringify(embeddings), final, total]);
}

function expectedChunkId(documentId: string | null, index: number): string {
  const hex = crypto.createHash('sha256').update(`${documentId}:${index}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function chunkRows(ctx: Ctx, documentId: string | null): Promise<Row[]> {
  return call(
    ctx.db,
    `SELECT id, chunk_index, content, status, is_current, tenant_key, version, doc_type, source, language, doc_date::text AS doc_date, parser_used,
            organization_id, metadata, embedding IS NOT NULL AS has_embedding, chunk_kind, section_path, page_start, page_end, content_hash,
            embedding_text_version, lexical_text
     FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId],
  );
}

async function publish(ctx: Ctx, id: string | null, tenantKey: string): Promise<Row> {
  const rows = await call(ctx.db, PUBLISH_SQL, [id, tenantKey]);
  assert.equal(rows.length, 1, 'publish returns exactly one row');
  return rows[0] as Row;
}

async function searchIds(ctx: Ctx, tenant: Tenant, query: string): Promise<string[]> {
  const vector = `[${embedText(query).join(',')}]`;
  const rows =
    ctx.mode === 'single-tenant'
      ? await call(ctx.db, 'SELECT chunk_id AS id FROM match_document_chunks(query_embedding => $1::vector, similarity_threshold => 0.0, match_count => 200)', [vector])
      : await call(
          ctx.db,
          'SELECT id FROM match_documents_by_workspace(p_query_embedding => $1::vector, p_match_count => 200, p_min_similarity => 0.0, p_org_id => $2::uuid, p_user_id => $3::uuid)',
          [vector, tenant.orgId, tenant.userId],
        );
  return rows.map((row) => String(row.id));
}

async function publishedVersion(ctx: Ctx, sourceKey: string, count: number, options: WriteOptions & { tenant?: Tenant } = {}): Promise<{ id: string; ids: string[] }> {
  const tenant = options.tenant ?? ctx.a;
  const row = await begin(ctx, { tenant, sourceKey, filename: 'writer-fixture.md' });
  const id = row.document_id as string;
  await writeChunks(ctx, id, tenant.key, count, options);
  await publish(ctx, id, tenant.key);
  return { id, ids: Array.from({ length: count }, (_unused, index) => expectedChunkId(id, index)) };
}

for (const mode of MODES) {
  describe(`ingest writer: chunk writes and version publish (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: (t: TestContext) => Promise<void>) => test(`${name} [${mode}]`, run);
    before(async () => {
      ctx = await createCtx(mode);
    });
    after(async () => {
      await ctx?.db.close();
    });

    it('writing 3 chunks twice leaves 3 rows with the same deterministic ids, and a final write with p_total 2 removes chunk_index 2', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('chunks-idempotent') });
      const id = row.document_id;
      const first = await writeChunks(ctx, id, ctx.a.key, 3);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.chunks_written, 3);
      await writeChunks(ctx, id, ctx.a.key, 3, { label: 'rewritten' });
      const rows = await chunkRows(ctx, id);
      assert.deepEqual(
        rows.map((chunk) => chunk.id),
        [0, 1, 2].map((index) => expectedChunkId(id, index)),
      );
      assert.equal(rows[1]?.content, chunkText('rewritten', 1), 'a rewrite replaces the content');
      const final = await writeChunks(ctx, id, ctx.a.key, 2, { label: 'rewritten', final: true, total: 2 });
      assert.equal(final[0]?.chunks_deleted, 1);
      const remaining = await chunkRows(ctx, id);
      assert.deepEqual(
        remaining.map((chunk) => chunk.chunk_index),
        [0, 1],
      );
      const other = await begin(ctx, { sourceKey: uniqueKey('chunks-other') });
      await writeChunks(ctx, other.document_id, ctx.a.key, 3);
      await writeChunks(ctx, id, ctx.a.key, 1, { final: true, total: 1 });
      assert.equal((await chunkRows(ctx, other.document_id)).length, 3, 'a final write only prunes its own document');
    });

    it('chunk rows copy the document columns, stay processing and non-current, and mirror the promoted columns into metadata', async () => {
      const key = uniqueKey('chunks-denormalised');
      const row = await begin(ctx, { sourceKey: key, docType: 'financial_report', origin: 'picked' });
      assert.equal(
        await setFields(ctx, row.document_id, ctx.a.key, { language: 'zh', doc_date: '2025-03-01', parser_used: 'docling', content_hash: 'doc-hash' }),
        null,
      );
      await writeChunks(ctx, row.document_id, ctx.a.key, 2, {
        extra: (index) => ({
          section_path: ['Part 1', `Section ${index}`],
          page_start: index + 1,
          page_end: index + 2,
          content_hash: `chunk-hash-${index}`,
          chunk_kind: index === 0 ? 'table' : 'text',
          embedding_text_version: 1,
          lexical_text: `lexical ${index}`,
        }),
      });
      const rows = await chunkRows(ctx, row.document_id);
      assert.equal(rows.length, 2);
      const first = rows[0] as Row;
      assert.equal(first.tenant_key, ctx.a.key);
      assert.equal(first.version, 1);
      assert.equal(first.doc_type, 'financial_report');
      assert.equal(first.source, 'config_upload');
      assert.equal(first.language, 'zh');
      assert.equal(first.doc_date, '2025-03-01');
      assert.equal(first.parser_used, 'docling');
      assert.equal(first.status, 'processing');
      assert.equal(first.is_current, false);
      assert.equal(first.organization_id, ctx.a.orgId);
      assert.equal(first.chunk_kind, 'table');
      assert.deepEqual(first.section_path, ['Part 1', 'Section 0']);
      assert.equal(first.page_start, 1);
      assert.equal(first.page_end, 2);
      assert.equal(first.content_hash, 'chunk-hash-0');
      assert.equal(first.embedding_text_version, 1);
      assert.equal(first.lexical_text, 'lexical 0');
      assert.deepEqual(first.metadata, {
        document_title: 'writer-fixture.md',
        chunk_index: 0,
        chunk_position: 1,
        total_chunks: 2,
        urls: [],
        has_urls: false,
        section_path: ['Part 1', 'Section 0'],
        doc_type: 'financial_report',
        language: 'zh',
        content_hash: 'chunk-hash-0',
        chunk_kind: 'table',
        parser_used: 'docling',
        embedding_text_version: 1,
        embedding_model: 'text-embedding-3-small',
        embedding_dims: 1536,
        doc_date: '2025-03-01',
        source: 'config_upload',
        page_start: 1,
        page_end: 2,
      });
      assert.equal((rows[1] as Row).chunk_kind, 'text');
    });

    it('the legacy embedding column is written for profile openai-3-small-1536 and a chunk without an embedding keeps NULL', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('chunks-embedding') });
      await writeChunks(ctx, row.document_id, ctx.a.key, 2);
      assert.deepEqual(
        (await chunkRows(ctx, row.document_id)).map((chunk) => chunk.has_embedding),
        [true, true],
      );
      const stored = await call(ctx.db, 'SELECT vector_dims(embedding) AS dims FROM document_chunks WHERE id = $1', [expectedChunkId(row.document_id, 0)]);
      assert.equal(stored[0]?.dims, 1536);
      const bare = await begin(ctx, { sourceKey: uniqueKey('chunks-no-embedding') });
      await writeChunks(ctx, bare.document_id, ctx.a.key, 1, { embeddings: false });
      const rows = await chunkRows(ctx, bare.document_id);
      assert.equal(rows[0]?.has_embedding, false);
      assert.equal('embedding_model' in ((rows[0] as Row).metadata as Row), false);
    });

    it('an embedding entry for an unknown profile raises embedding_profile_unsupported and a wrong-length vector for a registered one raises embedding_profile_mismatch, both writing nothing', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('chunks-profile') });
      const vector = embedText('profile check');
      const message = await writeError(ctx, row.document_id, ctx.a.key, chunkSpecs(1, {}), { [LEGACY_PROFILE]: [vector], 'no-such-profile-512': [vector] });
      assert.match(message ?? '', /embedding_profile_unsupported/);
      assert.deepEqual(await chunkRows(ctx, row.document_id), []);
      assert.match((await writeError(ctx, row.document_id, ctx.a.key, chunkSpecs(1, {}), { 'voyage-4-large-2048': [vector] })) ?? '', /embedding_profile_mismatch/);
      assert.deepEqual(await chunkRows(ctx, row.document_id), []);
    });

    it('a null vector entry writes that chunk without a vector, a scalar entry is rejected with invalid_embeddings, and a wrong length next to a null is still refused', async () => {
      const halfvecProfile = 'voyage-4-large-1024';
      const legacy = embedText(chunkText('writer', 0));
      const half = Array.from({ length: 1024 }, (_unused, index) => (index === 1 ? 1 : 0));
      const row = await begin(ctx, { sourceKey: uniqueKey('chunks-null-vector') });
      const id = row.document_id;
      const written = await call(ctx.db, WRITE_SQL, [
        id,
        ctx.a.key,
        JSON.stringify(chunkSpecs(2, {})),
        JSON.stringify({ [LEGACY_PROFILE]: [legacy, null], [halfvecProfile]: { vectors: [null, half], host: 'fixture' } }),
        false,
        null,
      ]);
      assert.equal(written[0]?.chunks_written, 2);
      assert.deepEqual(
        (await chunkRows(ctx, id)).map((chunk) => chunk.has_embedding),
        [true, false],
      );
      const halfRows = await call(ctx.db, 'SELECT chunk_id::text AS chunk_id, dims FROM chunk_embeddings WHERE profile_id = $1 AND chunk_id IN ($2::uuid, $3::uuid)', [
        halfvecProfile,
        expectedChunkId(id, 0),
        expectedChunkId(id, 1),
      ]);
      assert.deepEqual(halfRows, [{ chunk_id: expectedChunkId(id, 1), dims: 1024 }]);

      const allNull = await begin(ctx, { sourceKey: uniqueKey('chunks-all-null') });
      await call(ctx.db, WRITE_SQL, [allNull.document_id, ctx.a.key, JSON.stringify(chunkSpecs(2, {})), JSON.stringify({ [LEGACY_PROFILE]: [null, null] }), false, null]);
      assert.deepEqual(
        (await chunkRows(ctx, allNull.document_id)).map((chunk) => chunk.has_embedding),
        [false, false],
      );

      const refused = await begin(ctx, { sourceKey: uniqueKey('chunks-scalar-vector') });
      for (const scalar of [42, 'not a vector', true, { values: [] }]) {
        const message = await writeError(ctx, refused.document_id, ctx.a.key, chunkSpecs(2, {}), { [LEGACY_PROFILE]: [legacy, scalar] });
        assert.match(message ?? 'no error', /invalid_embeddings/, JSON.stringify(scalar));
      }
      const shortVector = await writeError(ctx, refused.document_id, ctx.a.key, chunkSpecs(2, {}), { [LEGACY_PROFILE]: [null, legacy.slice(0, 100)] });
      assert.match(shortVector ?? 'no error', /embedding_profile_mismatch/);
      const shortHalf = await writeError(ctx, refused.document_id, ctx.a.key, chunkSpecs(2, {}), { [halfvecProfile]: [half.slice(0, 1000), null] });
      assert.match(shortHalf ?? 'no error', /embedding_profile_mismatch/);
      assert.deepEqual(await chunkRows(ctx, refused.document_id), []);
    });

    it('an embedding list that does not line up with the chunks, a final write without a total and a chunk without content are rejected', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('chunks-invalid') });
      const vector = embedText('alignment');
      assert.match((await writeError(ctx, row.document_id, ctx.a.key, chunkSpecs(2, {}), { [LEGACY_PROFILE]: [vector] })) ?? '', /embedding_count_mismatch/);
      assert.match((await writeError(ctx, row.document_id, ctx.a.key, chunkSpecs(1, {}), {}, true, null)) ?? '', /invalid_total/);
      assert.match((await writeError(ctx, row.document_id, ctx.a.key, [{ chunk_index: 0 }], {})) ?? '', /invalid_chunk/);
      assert.match((await writeError(ctx, row.document_id, ctx.a.key, { not: 'an array' }, {})) ?? '', /invalid_chunks/);
      assert.deepEqual(await chunkRows(ctx, row.document_id), []);
    });

    it('write and publish raise tenant_mismatch for another tenant\'s key and a failed document refuses both', async () => {
      const row = await begin(ctx, { sourceKey: uniqueKey('chunks-mismatch') });
      const wrong = wrongTenantKey(ctx);
      assert.match((await writeError(ctx, row.document_id, wrong, chunkSpecs(1, {}), {})) ?? '', /tenant_mismatch/);
      assert.match((await errorOf(ctx.db, PUBLISH_SQL, [row.document_id, wrong])) ?? '', /tenant_mismatch/);
      assert.deepEqual(await chunkRows(ctx, row.document_id), []);
      assert.equal((await docRow(ctx, row.document_id)).status, 'processing');

      await call(ctx.db, 'SELECT * FROM rag_mark_document_failed($1, $2, $3)', [row.document_id, ctx.a.key, 'stopped']);
      assert.match((await writeError(ctx, row.document_id, ctx.a.key, chunkSpecs(1, {}), {})) ?? '', /document_not_writable/);
      assert.match((await errorOf(ctx.db, PUBLISH_SQL, [row.document_id, ctx.a.key])) ?? '', /document_not_publishable/);
    });

    it('publishing version 2 demotes version 1, drops its legacy vectors, keeps its rows, and retrieval returns only version 2', async () => {
      const key = uniqueKey('publish-swap');
      const v1 = await publishedVersion(ctx, key, 2, { label: 'swapalpha' });
      const first = await docRow(ctx, v1.id);
      assert.equal(first.is_current, true);
      assert.equal(first.status, 'ready');
      assert.deepEqual(
        (await chunkRows(ctx, v1.id)).map((chunk) => [chunk.is_current, chunk.status, chunk.has_embedding]),
        [
          [true, 'ready', true],
          [true, 'ready', true],
        ],
      );

      const begun = await begin(ctx, { sourceKey: key, filename: 'writer-fixture.md' });
      assert.equal(begun.version, 2);
      const v2id = begun.document_id as string;
      await writeChunks(ctx, v2id, ctx.a.key, 2, { label: 'swapbravo' });
      const searchBefore = await searchIds(ctx, ctx.a, chunkText('swapalpha', 0));
      for (const id of v1.ids) assert.ok(searchBefore.includes(id), 'version 1 is searchable before the swap');
      for (let index = 0; index < 2; index += 1) assert.ok(!searchBefore.includes(expectedChunkId(v2id, index)), 'a processing version is not searchable');

      const result = await publish(ctx, v2id, ctx.a.key);
      assert.equal(result.outcome, 'published');
      assert.equal(result.document_id, v2id);
      assert.equal(result.superseded_document_id, v1.id);

      const old = await docRow(ctx, v1.id);
      assert.equal(old.is_current, false);
      assert.equal(old.superseded_by, v2id);
      assert.equal(old.status, 'ready');
      const fresh = await docRow(ctx, v2id);
      assert.equal(fresh.is_current, true);
      assert.equal(fresh.status, 'ready');
      assert.equal(fresh.superseded_by, null);
      assert.deepEqual(
        (await chunkRows(ctx, v1.id)).map((chunk) => [chunk.is_current, chunk.status, chunk.has_embedding, chunk.content]),
        [
          [false, 'ready', false, chunkText('swapalpha', 0)],
          [false, 'ready', false, chunkText('swapalpha', 1)],
        ],
      );
      assert.deepEqual(
        (await chunkRows(ctx, v2id)).map((chunk) => [chunk.is_current, chunk.status, chunk.has_embedding]),
        [
          [true, 'ready', true],
          [true, 'ready', true],
        ],
      );

      const afterSearch = await searchIds(ctx, ctx.a, chunkText('swapbravo', 0));
      for (const id of v1.ids) assert.ok(!afterSearch.includes(id), 'version 1 chunks are no longer returned');
      for (let index = 0; index < 2; index += 1) assert.ok(afterSearch.includes(expectedChunkId(v2id, index)), 'version 2 chunks are returned');

      const citation = await call(
        ctx.db,
        'SELECT dc.content, d.filename, d.version, d.is_current FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE dc.id = $1',
        [v1.ids[0]],
      );
      assert.deepEqual(citation, [{ content: chunkText('swapalpha', 0), filename: 'writer-fixture.md', version: 1, is_current: false }]);
    });

    it('publishing moves content_type and slug to the new version without a unique violation', async (t) => {
      if (ctx.mode === 'single-tenant') return t.skip('single-tenant documents have no content_type or slug');
      const key = uniqueKey('publish-slug');
      const v1 = await publishedVersion(ctx, key, 1);
      const slug = `slug-${sequence}`;
      await call(ctx.db, "UPDATE documents SET content_type = 'pricing', slug = $2 WHERE id = $1", [v1.id, slug]);
      const begun = await begin(ctx, { sourceKey: key });
      await writeChunks(ctx, begun.document_id, ctx.a.key, 1);
      await publish(ctx, begun.document_id, ctx.a.key);
      const old = await docRow(ctx, v1.id);
      assert.equal(old.content_type, null);
      assert.equal(old.slug, null);
      const fresh = await docRow(ctx, begun.document_id);
      assert.equal(fresh.content_type, 'pricing');
      assert.equal(fresh.slug, slug);
    });

    it('publishing a quarantined version leaves it quarantined and leaves the current version current, with its vectors', async () => {
      const key = uniqueKey('publish-quarantine');
      const v1 = await publishedVersion(ctx, key, 2, { label: 'quarantinealpha' });
      const begun = await begin(ctx, { sourceKey: key });
      const v2id = begun.document_id as string;
      await writeChunks(ctx, v2id, ctx.a.key, 2, { label: 'quarantinebravo' });
      assert.equal(await setFields(ctx, v2id, ctx.a.key, { status: 'quarantined' }), null);
      const result = await publish(ctx, v2id, ctx.a.key);
      assert.equal(result.outcome, 'quarantined');
      const held = await docRow(ctx, v2id);
      assert.equal(held.status, 'quarantined');
      assert.equal(held.is_current, false);
      const old = await docRow(ctx, v1.id);
      assert.equal(old.is_current, true);
      assert.equal(old.status, 'ready');
      assert.equal(old.superseded_by, null);
      assert.deepEqual(
        (await chunkRows(ctx, v1.id)).map((chunk) => [chunk.is_current, chunk.status, chunk.has_embedding]),
        [
          [true, 'ready', true],
          [true, 'ready', true],
        ],
      );
      assert.deepEqual(
        (await chunkRows(ctx, v2id)).map((chunk) => [chunk.is_current, chunk.status]),
        [
          [false, 'quarantined'],
          [false, 'quarantined'],
        ],
      );
      const found = await searchIds(ctx, ctx.a, chunkText('quarantinebravo', 0));
      for (let index = 0; index < 2; index += 1) assert.ok(!found.includes(expectedChunkId(v2id, index)), 'quarantined chunks are not retrievable');
    });

    it('publishing a quarantined first version leaves the lineage without a current row', async () => {
      const key = uniqueKey('publish-quarantine-first');
      const begun = await begin(ctx, { sourceKey: key });
      await writeChunks(ctx, begun.document_id, ctx.a.key, 1);
      await setFields(ctx, begun.document_id, ctx.a.key, { status: 'quarantined' });
      const result = await publish(ctx, begun.document_id, ctx.a.key);
      assert.equal(result.outcome, 'quarantined');
      const rows = await call(ctx.db, 'SELECT count(*)::int AS n FROM documents WHERE tenant_key = $1 AND source_key = $2 AND is_current', [ctx.a.key, key]);
      assert.equal(rows[0]?.n, 0);
    });

    it('publishing twice is a no-op the second time', async () => {
      const key = uniqueKey('publish-twice');
      const v1 = await publishedVersion(ctx, key, 2, { label: 'twicealpha' });
      const begun = await begin(ctx, { sourceKey: key });
      const v2id = begun.document_id as string;
      await writeChunks(ctx, v2id, ctx.a.key, 2, { label: 'twicebravo' });
      const first = await publish(ctx, v2id, ctx.a.key);
      assert.equal(first.outcome, 'published');
      const snapshot = async () => [await docRow(ctx, v1.id), await docRow(ctx, v2id), await chunkRows(ctx, v1.id), await chunkRows(ctx, v2id)];
      const before = await snapshot();
      const second = await publish(ctx, v2id, ctx.a.key);
      assert.equal(second.outcome, 'already_current');
      assert.equal(second.document_id, v2id);
      assert.deepEqual(await snapshot(), before);
    });

    it('a failure between the demotion and the promotion rolls everything back so version 1 stays current', async () => {
      const key = uniqueKey('publish-atomic');
      const v1 = await publishedVersion(ctx, key, 2, { label: 'atomicalpha' });
      const begun = await begin(ctx, { sourceKey: key });
      const v2id = begun.document_id as string;
      await writeChunks(ctx, v2id, ctx.a.key, 2, { label: 'atomicbravo' });
      const snapshot = async () => [await docRow(ctx, v1.id), await docRow(ctx, v2id), await chunkRows(ctx, v1.id), await chunkRows(ctx, v2id)];
      const before = await snapshot();
      await ctx.db.exec(`
        CREATE FUNCTION test_block_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.is_current AND NOT OLD.is_current THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_block_promotion BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION test_block_promotion();`);
      let message: string | null;
      try {
        message = await errorOf(ctx.db, PUBLISH_SQL, [v2id, ctx.a.key]);
      } finally {
        await ctx.db.exec('DROP TRIGGER test_block_promotion ON documents; DROP FUNCTION test_block_promotion();');
      }
      assert.match(message ?? '', /injected failure/);
      assert.deepEqual(await snapshot(), before);
      const current = await call(ctx.db, 'SELECT id FROM documents WHERE tenant_key = $1 AND source_key = $2 AND is_current', [ctx.a.key, key]);
      assert.deepEqual(current, [{ id: v1.id }]);
      const retry = await publish(ctx, v2id, ctx.a.key);
      assert.equal(retry.outcome, 'published', 'the same call succeeds once the failure is gone');
    });

    it('setting a status or type on a published document moves its chunks with it', async () => {
      const key = uniqueKey('fields-mirror');
      const v1 = await publishedVersion(ctx, key, 2, { label: 'mirroralpha' });
      assert.equal(await setFields(ctx, v1.id, ctx.a.key, { doc_type: 'contract_legal', language: 'it' }), null);
      for (const chunk of await chunkRows(ctx, v1.id)) {
        assert.equal(chunk.doc_type, 'contract_legal');
        assert.equal(chunk.language, 'it');
        assert.equal((chunk.metadata as Row).doc_type, 'contract_legal');
        assert.equal((chunk.metadata as Row).language, 'it');
      }
      assert.ok((await searchIds(ctx, ctx.a, chunkText('mirroralpha', 0))).includes(v1.ids[0] as string));
      assert.equal(await setFields(ctx, v1.id, ctx.a.key, { status: 'quarantined' }), null);
      assert.deepEqual(
        (await chunkRows(ctx, v1.id)).map((chunk) => chunk.status),
        ['quarantined', 'quarantined'],
      );
      assert.ok(!(await searchIds(ctx, ctx.a, chunkText('mirroralpha', 0))).includes(v1.ids[0] as string), 'a quarantined current document is not retrievable');
    });

    it('a version of one tenant never demotes or reads another tenant\'s document with the same source key', async (t) => {
      const other = ctx.b;
      if (other === null) return t.skip('single-tenant has one tenant');
      const key = uniqueKey('publish-two-tenants');
      const mine = await publishedVersion(ctx, key, 1, { label: 'tenantalpha' });
      const theirs = await publishedVersion(ctx, key, 1, { label: 'tenantbravo', tenant: other });
      assert.equal((await docRow(ctx, mine.id)).is_current, true);
      assert.equal((await docRow(ctx, theirs.id)).is_current, true);
      assert.equal((await docRow(ctx, theirs.id)).tenant_key, other.key);
      const next = await begin(ctx, { sourceKey: key });
      await writeChunks(ctx, next.document_id, ctx.a.key, 1, { label: 'tenantcharlie' });
      await publish(ctx, next.document_id, ctx.a.key);
      assert.equal((await docRow(ctx, mine.id)).is_current, false);
      assert.equal((await docRow(ctx, theirs.id)).is_current, true, 'the other tenant keeps its current version');
      assert.equal((await chunkRows(ctx, theirs.id))[0]?.has_embedding, true);
    });

    it('the chunk writer and publish function are SECURITY DEFINER, pinned and executable by service_role only', async () => {
      const result = await call(
        ctx.db,
        `SELECT p.proname, p.prosecdef, p.proconfig::text AS config,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY p.proname`,
        [CHUNK_FUNCTIONS],
      );
      assert.deepEqual(
        result.map((row) => row.proname),
        CHUNK_FUNCTIONS,
      );
      for (const row of result) {
        const name = String(row.proname);
        assert.equal(row.prosecdef, true, `${name} is SECURITY DEFINER`);
        assert.match(String(row.config), /search_path=/, `${name} pins search_path`);
        assert.equal(row.anon_exec, false, `${name} is not executable by anon`);
        assert.equal(row.authenticated_exec, false, `${name} is not executable by authenticated`);
        assert.equal(row.service_exec, true, `${name} is executable by service_role`);
      }
    });
  });
}
