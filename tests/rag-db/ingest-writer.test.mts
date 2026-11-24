import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

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
    const it = (name: string, run: (t: TestContext) => Promise<unknown>) => test(`${name} [${mode}]`, run);
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
      for (const key of ['tenant_key', 'is_current', 'version', 'lineage_id', 'superseded_by', 'content', 'id', 'organization_id', 'user_id', 'not_a_column']) {
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
      const everyRag = await call(
        ctx.db,
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_%'
           AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
      );
      assert.deepEqual(everyRag, []);
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
