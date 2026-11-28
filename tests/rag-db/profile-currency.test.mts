import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeploymentMode, FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { LEGACY_EMBEDDING, createFixture, helpers, vector, type Tenant } from '../helpers/chunking-profile-fixture.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0413_chunking_activation.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

for (const mode of MODES) {
  describe(`document_parents currency follows the document (${mode})`, () => {
    let fixture: FixtureDatabase;
    let a: Tenant;
    let b: Tenant | null;
    let h: ReturnType<typeof helpers>;

    before(async () => {
      ({ fixture, a, b } = await createFixture(mode));
      h = helpers(fixture, `parents-${mode}`);
      await h.insertProfile('p256-1024', 'contract_legal');
    });

    after(async () => {
      await fixture?.db.close();
    });

    const parentsOf = (documentId: string) =>
      h.query('SELECT id::text, is_current FROM document_parents WHERE document_id = $1 ORDER BY parent_index', [documentId]);
    const fetched = async (tenant: Tenant, ids: string[]) =>
      (await h.query('SELECT id::text FROM rag_fetch_parents($1, $2::uuid[])', [tenant.key, ids])).map((row) => String(row.id));

    test('a superseded version loses its parents: is_current flips with the document and rag_fetch_parents stops returning them', async () => {
      const first = await h.seed(a, 'ver', 'contract_legal', { sourceKey: 'versioned.md' });
      await h.fill(first, a, 'p256-1024', 'ver-1');
      const [v1] = await parentsOf(first);
      assert.equal(v1?.is_current, true, 'a published current document has current parents');
      assert.deepEqual(await fetched(a, [String(v1?.id)]), [String(v1?.id)]);

      const second = await h.seed(a, 'ver', 'contract_legal', { sourceKey: 'versioned.md' });
      await h.fill(second, a, 'p256-1024', 'ver-2');
      assert.equal((await h.query('SELECT is_current FROM documents WHERE id = $1', [first]))[0]?.is_current, false, 'the first version is superseded');

      assert.equal((await parentsOf(first))[0]?.is_current, false, 'the superseded version kept a current parent');
      assert.deepEqual(await fetched(a, [String(v1?.id)]), [], 'rag_fetch_parents returned a superseded parent');
      const [v2] = await parentsOf(second);
      assert.equal(v2?.is_current, true);
      assert.deepEqual(await fetched(a, [String(v2?.id)]), [String(v2?.id)]);
    });

    test('parents written before the version is published are not current until it is, and never for another tenant', async () => {
      const documentId = await h.seed(a, 'unpublished', 'contract_legal', { publish: false });
      await h.fill(documentId, a, 'p256-1024', 'unpublished');
      const [parent] = await parentsOf(documentId);
      assert.equal(parent?.is_current, false, 'an unpublished document has a current parent');
      assert.deepEqual(await fetched(a, [String(parent?.id)]), [], 'rag_fetch_parents returned the parent of an unpublished document');

      await h.query('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, a.key]);
      assert.equal((await parentsOf(documentId))[0]?.is_current, true, 'publishing makes the parent current');
      assert.deepEqual(await fetched(a, [String(parent?.id)]), [String(parent?.id)]);
      if (b) assert.deepEqual(await fetched(b, [String(parent?.id)]), [], 'another tenant fetched the parent');
    });

    test('a quarantined or soft-deleted document hides its parents', async () => {
      const quarantined = await h.seed(a, 'quarantined', 'contract_legal');
      await h.fill(quarantined, a, 'p256-1024', 'quarantined');
      const [parent] = await parentsOf(quarantined);
      assert.deepEqual(await fetched(a, [String(parent?.id)]), [String(parent?.id)]);
      await fixture.db.query(`UPDATE documents SET status = 'quarantined' WHERE id = $1`, [quarantined]);
      assert.deepEqual(await fetched(a, [String(parent?.id)]), [], 'rag_fetch_parents returned the parent of a quarantined document');

      const deleted = await h.seed(a, 'deleted', 'contract_legal');
      await h.fill(deleted, a, 'p256-1024', 'deleted');
      const [other] = await parentsOf(deleted);
      await fixture.db.query('UPDATE documents SET is_current = false WHERE id = $1', [deleted]);
      assert.equal((await parentsOf(deleted))[0]?.is_current, false, 'a document taken out of service kept a current parent');
      assert.deepEqual(await fetched(a, [String(other?.id)]), []);
      await fixture.db.query('UPDATE documents SET is_current = true WHERE id = $1', [deleted]);
      assert.equal((await parentsOf(deleted))[0]?.is_current, true, 'restoring the document restores its parent');
    });

    test('applying 0413 to a database that already holds stale parents corrects them', async () => {
      const stale = await h.seed(a, 'stale', 'contract_legal', { sourceKey: 'stale.md' });
      await h.fill(stale, a, 'p256-1024', 'stale-1');
      await h.seed(a, 'stale', 'contract_legal', { sourceKey: 'stale.md' });
      await fixture.db.exec('ALTER TABLE document_parents DISABLE TRIGGER USER');
      await fixture.db.query('UPDATE document_parents SET is_current = true WHERE document_id = $1', [stale]);
      await fixture.db.exec('ALTER TABLE document_parents ENABLE TRIGGER USER');
      assert.equal((await parentsOf(stale))[0]?.is_current, true, 'the fixture must hold a stale parent');
      assert.ok(fs.existsSync(MIGRATION), 'supabase/migrations/0413_chunking_activation.sql exists');
      await fixture.db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      assert.equal((await parentsOf(stale))[0]?.is_current, false);
    });
  });

  describe(`an active profile keeps image and invoice-header chunks retrievable (${mode})`, () => {
    let fixture: FixtureDatabase;
    let a: Tenant;
    let b: Tenant | null;
    let h: ReturnType<typeof helpers>;

    before(async () => {
      ({ fixture, a, b } = await createFixture(mode));
      h = helpers(fixture, `kinds-${mode}`);
      await h.insertProfile('p256-1024', 'contract_legal');
      await h.insertProfile('inv-256', 'invoice_receipt', 256, 'none', null, 'custom');
    });

    after(async () => {
      await fixture?.db.close();
    });

    const search = async (tenant: Tenant, override: Record<string, string> | null) =>
      (
        await h.query(
          `SELECT hs.chunk_id::text AS id, c.chunking_profile_id AS profile, c.chunk_kind AS kind, c.document_id::text AS document_id
           FROM hybrid_search_chunks(
             p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
             p_dense_limit => 0, p_lexical_limit => 50, p_chunking_override => $5::jsonb) hs
           JOIN document_chunks c ON c.id = hs.chunk_id`,
          [tenant.key, LEGACY_EMBEDDING, `[${vector(1536, 0).join(',')}]`, ['indemnity'], override === null ? null : JSON.stringify(override)],
        )
      ).map((row) => ({ id: String(row.id), profile: String(row.profile), kind: String(row.kind), documentId: String(row.document_id) }));

    const IMAGE = { content: 'figure of the indemnity diagram', chunk_kind: 'image', lexical_text: 'figure indemnity diagram caption', metadata: { image_url: 'https://example.invalid/figure.png' } };
    const HEADER = { content: 'invoice header indemnity supplier line', chunk_kind: 'invoice_header', lexical_text: 'invoice header indemnity supplier', metadata: {} };

    test('legacy image and invoice_header rows stay retrievable next to the profile children; legacy text rows are hidden; other tenants see nothing of them', async () => {
      const contract = await h.seed(a, 'with-figure', 'contract_legal', { extraLegacy: [IMAGE] });
      await h.fill(contract, a, 'p256-1024', 'with-figure');
      const invoice = await h.seed(a, 'with-header', 'invoice_receipt', { extraLegacy: [HEADER] });
      await h.fill(invoice, a, 'inv-256', 'with-header');
      const foreign = b ? await h.seed(b, 'foreign-figure', 'contract_legal', { extraLegacy: [IMAGE] }) : null;
      if (b && foreign) await h.fill(foreign, b, 'p256-1024', 'foreign-figure');

      const override = { contract_legal: 'p256-1024', invoice_receipt: 'inv-256' };
      const plain = await search(a, null);
      assert.ok(plain.every((hit) => hit.profile === 'legacy'), 'without an override only legacy rows are searched');
      assert.ok(plain.some((hit) => hit.kind === 'image' && hit.documentId === contract), 'the baseline finds the image chunk');
      assert.ok(plain.some((hit) => hit.kind === 'invoice_header' && hit.documentId === invoice), 'the baseline finds the invoice header chunk');

      const hits = await search(a, override);
      const ofContract = hits.filter((hit) => hit.documentId === contract);
      assert.ok(ofContract.some((hit) => hit.profile === 'p256-1024'), 'profile children are returned');
      assert.ok(
        ofContract.some((hit) => hit.profile === 'legacy' && hit.kind === 'image'),
        'the image chunk disappeared once the profile became effective',
      );
      assert.ok(
        ofContract.filter((hit) => hit.profile === 'legacy').every((hit) => hit.kind === 'image'),
        'a legacy text chunk is still returned next to its profile children',
      );
      const ofInvoice = hits.filter((hit) => hit.documentId === invoice);
      assert.ok(ofInvoice.some((hit) => hit.profile === 'inv-256'));
      assert.ok(
        ofInvoice.some((hit) => hit.profile === 'legacy' && hit.kind === 'invoice_header'),
        'the invoice header chunk disappeared once the profile became effective',
      );
      assert.ok(ofInvoice.filter((hit) => hit.profile === 'legacy').every((hit) => hit.kind === 'invoice_header'));

      if (b && foreign) {
        assert.ok(hits.every((hit) => hit.documentId !== foreign), 'tenant A received a chunk of tenant B');
        const theirs = await search(b, override);
        assert.ok(theirs.length > 0 && theirs.every((hit) => hit.documentId === foreign), 'tenant B received a chunk that is not its own');
        assert.ok(theirs.some((hit) => hit.kind === 'image'), 'tenant B lost its own image chunk');
      }
    });

    test('a document with no children in the profile still serves all its legacy rows', async () => {
      const bare = await h.seed(a, 'bare', 'contract_legal', { extraLegacy: [IMAGE] });
      const hits = (await search(a, { contract_legal: 'p256-1024' })).filter((hit) => hit.documentId === bare);
      assert.deepEqual(hits.map((hit) => hit.kind).sort(), ['image', 'text']);
    });
  });
}
