import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { A, B, ORG, REPO_ROOT, harness, signal, type Row } from '../helpers/doc-type-change-harness.mts';

describe('multi-tenant: changing the type of a document creates a new version', () => {
  const h = harness('multi-tenant');

  before(async () => {
    await h.setup(createTwoTenantDatabase);
    await h.fixture.db.query('INSERT INTO admin_users (id) VALUES ($1)', [A]);
    await h.fixture.db.query("UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2", [ORG, A]);
  });
  after(() => h.teardown());
  beforeEach(() => h.each());
  afterEach(() => h.afterEachTest());

  test('general to contract_legal: version 2 with type contract_legal, origin picked, re-chunked by the legal chunker, and no parser call', async () => {
    const first = await h.uploadPdf(A);
    assert.equal(h.parsers.llama.length, 1);
    const before = await h.chunksOf(first.id);
    const callsBefore = [h.parsers.llama.length, h.parsers.docling.length];

    const changed = await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'contract_legal', signal: signal() });

    assert.equal(changed.ok, true);
    assert.ok(changed.ok);
    assert.equal(changed.result.status, 'ready');
    assert.equal(changed.result.version, 2);
    assert.ok(changed.result.documentId && changed.result.documentId !== first.id);
    assert.ok(changed.result.warnings.includes('parse_reused'));
    assert.deepEqual([h.parsers.llama.length, h.parsers.docling.length], callsBefore, 'equal parser options: the stored parse output is used, no parser runs');

    const next = await h.documentRow(changed.result.documentId);
    assert.equal(next.doc_type, 'contract_legal');
    assert.equal(next.doc_type_origin, 'picked');
    assert.equal(next.processing_profile_id, 'contract_legal@1');
    assert.equal(next.version, 2);
    assert.equal(next.is_current, true);
    assert.equal(next.status, 'ready');
    assert.equal(next.parser_used, 'llamaparse', 'the parser of the stored parse output stays on the row');
    assert.equal(next.lineage_id, (await h.documentRow(first.id)).lineage_id);
    assert.equal(next.source_key, `root/${first.filename}`);
    const prefix = `u:${A}/${String(next.lineage_id)}/2/`;
    assert.equal(next.original_path, `${prefix}original.pdf`);
    assert.ok(h.store.keys().includes(`${prefix}parse.md`), 'the new version has its own parse output');
    assert.deepEqual(new Uint8Array(h.store.objects.get(`${prefix}original.pdf`)?.bytes ?? []), first.bytes, 'the original is stored again, byte for byte');

    const after = await h.chunksOf(changed.result.documentId);
    assert.ok(after.length >= 3, 'one chunk per clause');
    assert.notDeepEqual(
      after.map((chunk) => chunk.content),
      before.map((chunk) => chunk.content),
      'the legal chunker cut the text differently from the markdown section chunker',
    );
    assert.ok(after.some((chunk) => (chunk.section_path as string[]).some((part) => /^Article 1/.test(part))), 'the clause is the path');
  });

  test('general to scanned_image: the parser options differ, so the stored original is parsed again once through the chain', async () => {
    const first = await h.uploadPdf(A);
    assert.equal(h.parsers.llama.length, 1);
    const callsBefore = h.parsers.llama.length;

    const changed = await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'scanned_image', signal: signal() });

    assert.ok(changed.ok);
    assert.equal(changed.result.status, 'ready');
    assert.equal(changed.result.version, 2);
    assert.equal(h.parsers.docling.length, 1, 'the profile prefers docling and it parsed the stored original');
    assert.equal(h.parsers.llama.length, callsBefore);
    assert.deepEqual(new Uint8Array(h.parsers.docling[0]?.bytes ?? []), first.bytes);
    assert.equal(h.parsers.docling[0]?.filename, first.filename);
    assert.equal(changed.result.warnings.includes('parse_reused'), false);
    const next = await h.documentRow(changed.result.documentId as string);
    assert.equal(next.doc_type, 'scanned_image');
    assert.equal(next.parser_used, 'docling');
    const prefix = `u:${A}/${String(next.lineage_id)}/2/`;
    assert.ok(h.store.keys().includes(`${prefix}docling.json`), 'the Docling JSON of the new parse is stored next to it');
  });

  test('after the change retrieval sees only version 2, version 1 is superseded and its old chunks and citation still load', async () => {
    const first = await h.uploadPdf(A);
    const oldChunks = await h.chunksOf(first.id);
    assert.ok(oldChunks.length > 0);
    const changed = await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'product_technical', signal: signal() });
    assert.ok(changed.ok && changed.result.documentId);

    const old = await h.documentRow(first.id);
    assert.equal(old.is_current, false);
    assert.equal(old.superseded_by, changed.result.documentId);
    assert.equal(old.doc_type, 'general', 'the old row keeps its own type');
    const visible = await h.rows(
      `SELECT DISTINCT d.version FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.lineage_id = $1 AND c.is_current AND c.status = 'ready'`,
      [old.lineage_id],
    );
    assert.deepEqual(visible, [{ version: 2 }]);
    assert.deepEqual((await h.chunksOf(first.id)).map((chunk) => chunk.content), oldChunks.map((chunk) => chunk.content), 'the old chunks are kept so an old citation resolves');
    assert.ok((await h.chunksOf(first.id)).every((chunk) => chunk.is_current === false));
  });

  test('a document whose stored original is missing returns original_unavailable and creates no version', async () => {
    const first = await h.uploadPdf(A);
    const original = (await h.documentRow(first.id)).original_path as string;
    h.store.objects.delete(original);
    const before = Number((await h.rows('SELECT count(*)::int AS n FROM documents WHERE lineage_id = $1', [(await h.documentRow(first.id)).lineage_id]))[0]?.n);
    const callsBefore = h.parsers.llama.length + h.parsers.docling.length;

    const changed = await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'scanned_image', signal: signal() });

    assert.deepEqual(changed, { ok: false, reason: 'original_unavailable' });
    assert.equal(Number((await h.rows('SELECT count(*)::int AS n FROM documents WHERE lineage_id = $1', [(await h.documentRow(first.id)).lineage_id]))[0]?.n), before);
    assert.equal(h.parsers.llama.length + h.parsers.docling.length, callsBefore);

    await h.fixture.db.query('UPDATE documents SET original_path = NULL WHERE id = $1', [first.id]);
    assert.deepEqual(await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'contract_legal', signal: signal() }), {
      ok: false,
      reason: 'original_unavailable',
    });
  });

  test('another tenant, an unknown id, a superseded version and an invalid type are refused without writing a version', async () => {
    const first = await h.uploadPdf(A);
    const lineageCount = async () => Number((await h.rows('SELECT count(*)::int AS n FROM documents'))[0]?.n);
    const total = await lineageCount();

    assert.deepEqual(await h.m.change.changeDocumentType({ scope: await h.scopeOf(B), documentId: first.id, docType: 'contract_legal', signal: signal() }), { ok: false, reason: 'not_found' });
    assert.deepEqual(
      await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: '00000000-0000-4000-8000-0000000000aa', docType: 'contract_legal', signal: signal() }),
      { ok: false, reason: 'not_found' },
    );
    assert.deepEqual(await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: 'not-a-uuid', docType: 'contract_legal', signal: signal() }), { ok: false, reason: 'not_found' });
    assert.deepEqual(
      await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'memo' as never, signal: signal() }),
      { ok: false, reason: 'invalid_doc_type' },
    );
    assert.equal(await lineageCount(), total);

    const changed = await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'product_technical', signal: signal() });
    assert.ok(changed.ok);
    const total2 = await lineageCount();
    assert.deepEqual(await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'contract_legal', signal: signal() }), { ok: false, reason: 'not_changeable' });
    assert.equal(await lineageCount(), total2);
  });

  test('the type change keeps the origin fields and the caller metadata of the document it replaces', async () => {
    const first = await h.uploadPdf(A, {
      source: 'nango',
      extra: { options: { origin: { sourceProvider: 'google-drive', sourceFileId: 'drive-file-1', sourceConnectionId: 'conn-1' }, documentMetadata: { team: 'ops' } } },
    });
    const changed = await h.m.change.changeDocumentType({ scope: await h.scopeOf(A), documentId: first.id, docType: 'product_technical', signal: signal() });
    assert.ok(changed.ok && changed.result.documentId);
    const next = await h.documentRow(changed.result.documentId);
    assert.equal(next.source, 'nango');
    assert.equal(next.source_provider, 'google-drive');
    assert.equal(next.source_file_id, 'drive-file-1');
    assert.equal(next.source_connection_id, 'conn-1');
    assert.equal((next.metadata as Row).team, 'ops');
  });

  test('the begin function skips a same-hash upload as before, and starts a new version only when the flag is set; a forced retry resumes only the same type', async () => {
    const first = await h.uploadPdf(A);
    const sha = (await h.rows('SELECT file_sha256 FROM documents WHERE id = $1', [first.id]))[0]?.file_sha256 as string;
    const begin = async (docType: string, force: boolean | null) => {
      try {
        const forceArg = force === null ? '' : ', p_force_new_version => $9::boolean';
        const params: unknown[] = [`u:${A}`, A, `root/${first.filename}`, first.filename, sha, docType, 'picked', `${docType}@1`];
        if (force !== null) params.push(force);
        return (
          await h.rows(
            `SELECT * FROM rag_begin_document_version(p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL::uuid, p_source => 'config_upload', p_source_key => $3,
              p_filename => $4, p_file_sha256 => $5, p_doc_type => $6, p_doc_type_origin => $7, p_profile_id => $8, p_profile_version => 1::int${forceArg})`,
            params,
          )
        )[0] as Row;
      } catch (error) {
        return { outcome: `error: ${error instanceof Error ? error.message : String(error)}` } as Row;
      }
    };

    assert.equal((await begin('general', null)).outcome, 'skipped_duplicate', 'a user upload of unchanged bytes is a duplicate (D-10)');
    assert.equal((await begin('general', false)).outcome, 'skipped_duplicate');
    const forced = await begin('contract_legal', true);
    assert.equal(forced.outcome, 'created');
    assert.equal(forced.version, 2);
    assert.equal(forced.lineage_id, (await h.documentRow(first.id)).lineage_id);
    const again = await begin('contract_legal', true);
    assert.equal(again.outcome, 'resumed');
    assert.equal(again.document_id, forced.document_id);
    const other = await begin('financial_report', true);
    assert.equal(other.outcome, 'created', 'a processing row of another type is not resumed');
    assert.equal(other.version, 3);
  });

  test('a type-change run that stops at the deadline before the content check keeps its forced state and resumes as ready, not as a duplicate', async () => {
    const first = await h.uploadPdf(A);
    const real = h.m.supabase.getSupabaseAdmin() as unknown as RpcClient;
    let clock = 1_000_000;
    let armed = true;
    const wrapped: RpcClient = {
      rpc(fn, args) {
        const state = args.p_state as { lastCompleted?: string } | undefined;
        if (armed && fn === 'rag_save_ingest_state' && state?.lastCompleted === 'parse') {
          clock += 60_000;
          armed = false;
        }
        return real.rpc(fn, args);
      },
    };
    h.m.deps.setIngestDepsForTests({ db: () => wrapped, now: () => clock });
    const scope = await h.scopeOf(A);
    const interrupted = await h.m.change.changeDocumentType({ scope, documentId: first.id, docType: 'contract_legal', signal: signal() });
    assert.ok(interrupted.ok);
    assert.equal(interrupted.result.status, 'processing');
    assert.equal(interrupted.result.reason, 'deadline');
    assert.ok(interrupted.result.documentId);
    const saved = (await h.documentRow(interrupted.result.documentId)).processing_state as Row;
    assert.equal(saved.lastCompleted, 'parse');
    assert.deepEqual((saved.typeChange as Row).reuseParseOfVersion, 1);

    h.m.deps.resetIngestDepsForTests();
    h.m.deps.setIngestDepsForTests({ ingestEnv: () => ({}) });
    const resumed = await h.m.ingest.resumeIngest(scope, interrupted.result.documentId);
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.documentId, interrupted.result.documentId);
    const next = await h.documentRow(interrupted.result.documentId);
    assert.equal(next.is_current, true);
    assert.equal(next.doc_type, 'contract_legal');
    assert.equal((await h.documentRow(first.id)).is_current, false);
  });

  test('scopeForAdminDocument mints the document own tenant scope for an admin who administers it, and nothing otherwise', async () => {
    const personal = await h.uploadPdf(A);
    const org = await h.uploadPdf(A, { organizationId: ORG });
    const foreign = await h.uploadPdf(B);

    const own = await h.m.adminScope.scopeForAdminDocument({ documentId: personal.id, adminUserId: A, signal: signal() });
    assert.ok(own);
    assert.equal(h.m.scopes.scopeKey(own), `u:${A}`);
    assert.equal(own.userId, A);
    const orgScope = await h.m.adminScope.scopeForAdminDocument({ documentId: org.id, adminUserId: A.toUpperCase(), signal: signal() });
    assert.ok(orgScope);
    assert.equal(h.m.scopes.scopeKey(orgScope), `o:${ORG}`);
    assert.equal(orgScope.organizationId, ORG);
    assert.equal(orgScope.userId, A, 'the new version keeps the uploader as its owner');

    assert.equal(await h.m.adminScope.scopeForAdminDocument({ documentId: foreign.id, adminUserId: A, signal: signal() }), null, 'a tenant the admin does not administer');
    assert.equal(await h.m.adminScope.scopeForAdminDocument({ documentId: '00000000-0000-4000-8000-0000000000aa', adminUserId: A, signal: signal() }), null, 'unknown id');
    assert.equal(await h.m.adminScope.scopeForAdminDocument({ documentId: 'not-a-uuid', adminUserId: A, signal: signal() }), null);
    await assert.rejects(h.m.adminScope.scopeForAdminDocument({ documentId: personal.id, adminUserId: B, signal: signal() }), { name: 'AdminDocumentScopeError', reason: 'not_admin' });

    const viaScope = await h.m.change.changeDocumentType({ scope: orgScope, documentId: org.id, docType: 'product_technical', signal: signal() });
    assert.ok(viaScope.ok);
    const replaced = await h.documentRow(viaScope.result.documentId as string);
    assert.equal(replaced.user_id, A, 'the owner of the replaced version is kept, not the admin');
    assert.equal(replaced.organization_id, ORG);
  });

  test('only the type-change operation builds the forced-version state; the ingest entry point and the status reader only carry it', () => {
    const builders: string[] = [];
    const carriers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        const rel = path.relative(REPO_ROOT, full);
        if (/\btypeChange\s*:/.test(source)) builders.push(rel);
        if (/\.typeChange\s*=/.test(source)) carriers.push(rel);
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    assert.deepEqual(builders, ['src/lib/rag/ingest/change-doc-type.ts']);
    assert.deepEqual(carriers.sort(), ['src/lib/rag/ingest/index.ts', 'src/lib/rag/ingest/status.ts']);
  });
});
