import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { CORPUS, ST_ADMIN, ST_PLAIN, harness, signal } from '../helpers/doc-type-change-harness.mts';

describe('single-tenant: changing the type of a document', () => {
  const h = harness('single-tenant');

  before(async () => {
    await h.setup(async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS, supabaseGrants: true });
      await fixture.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [ST_ADMIN, 'st-admin@example.invalid', ST_PLAIN, 'st-plain@example.invalid']);
      await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1)', [ST_ADMIN]);
      return fixture;
    });
  });
  after(() => h.teardown());
  beforeEach(() => h.each());
  afterEach(() => h.afterEachTest());

  test('general to product_technical: version 2 of the single tenant document, equal parser options, no parser call', async () => {
    const first = await h.uploadPdf(ST_ADMIN);
    const callsBefore = [h.parsers.llama.length, h.parsers.docling.length];
    const scope = await h.m.adminScope.scopeForAdminDocument({ documentId: first.id, adminUserId: ST_ADMIN, signal: signal() });
    assert.ok(scope);
    assert.equal(h.m.scopes.scopeKey(scope), 's:default');

    const changed = await h.m.change.changeDocumentType({ scope, documentId: first.id, docType: 'product_technical', signal: signal() });

    assert.ok(changed.ok);
    assert.equal(changed.result.status, 'ready');
    assert.equal(changed.result.version, 2);
    assert.deepEqual([h.parsers.llama.length, h.parsers.docling.length], callsBefore);
    const next = await h.documentRow(changed.result.documentId as string);
    assert.equal(next.doc_type, 'product_technical');
    assert.equal(next.doc_type_origin, 'picked');
    assert.equal((await h.documentRow(first.id)).is_current, false);
    assert.ok(h.store.keys().every((key) => key.startsWith('s:default/')));
  });

  test('a user who is not in admin_users gets no scope, and an unknown id gets none either', async () => {
    const first = await h.uploadPdf(ST_ADMIN);
    await assert.rejects(h.m.adminScope.scopeForAdminDocument({ documentId: first.id, adminUserId: ST_PLAIN, signal: signal() }), { name: 'AdminDocumentScopeError', reason: 'not_admin' });
    assert.equal(await h.m.adminScope.scopeForAdminDocument({ documentId: '00000000-0000-4000-8000-0000000000aa', adminUserId: ST_ADMIN, signal: signal() }), null);
  });
});
