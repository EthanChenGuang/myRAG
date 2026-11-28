import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Plan 03.2-45 (0819): the detector's bounded peer read and the "Replaces…" target check, in both deployment modes. Neutral samples only.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

interface Ctx {
  db: PGlite;
  tenant: Tenant;
  other: Tenant | null;
}

async function createCtx(mode: DeploymentMode): Promise<Ctx> {
  if (mode === 'single-tenant') {
    const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS });
    return { db: fixture.db, tenant: { key: 's:default', userId: null, orgId: null }, other: null };
  }
  const fixture = await createTwoTenantDatabase();
  return {
    db: fixture.db,
    tenant: { key: `o:${TWO_TENANT_IDS.orgO}`, userId: TWO_TENANT_IDS.userA, orgId: TWO_TENANT_IDS.orgO },
    other: { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB, orgId: null },
  };
}

let sequence = 0;

/** Publishes one document of `sourceKey` (a new version when the key exists) with the given type and content. */
async function publishDocument(ctx: Ctx, tenant: Tenant, sourceKey: string, docType: string, content: string): Promise<string> {
  sequence += 1;
  const label = `peer-${sequence}`;
  const begun = await ctx.db.query<Row>(
    `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, $7, 'fallback', 'general-1', 1)`,
    [tenant.key, tenant.userId, tenant.orgId, sourceKey, `${label}.md`, crypto.createHash('sha256').update(label).digest('hex'), docType],
  );
  const documentId = String(begun.rows[0]?.document_id);
  await ctx.db.query('SELECT * FROM rag_set_document_fields($1, $2, $3::jsonb)', [
    documentId,
    tenant.key,
    JSON.stringify({ content, content_hash: crypto.createHash('sha256').update(content).digest('hex') }),
  ]);
  const chunks = [{ chunk_index: 0, content, lexical_text: content, metadata: {} }];
  const embeddings = { [LEGACY_PROFILE]: [embedText(content)], [HALFVEC_PROFILE]: [embedText(content).slice(0, 1024)] };
  await ctx.db.query(
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
    [documentId, tenant.key, JSON.stringify(chunks), JSON.stringify(embeddings)],
  );
  await ctx.db.query('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);
  return documentId;
}

const peers = async (ctx: Ctx, key: string, documentId: string, limit = 100, texts = 10, chars = 20000) =>
  (await ctx.db.query<Row>('SELECT * FROM rag_supersession_peers($1, $2::uuid, $3, $4, $5)', [key, documentId, limit, texts, chars])).rows;

for (const mode of MODES) {
  describe(`0819 supersession peer reads (${mode})`, () => {
    let ctx: Ctx;
    const ids: Record<string, string> = {};

    before(async () => {
      ctx = await createCtx(mode);
      ids.self = await publishDocument(ctx, ctx.tenant, 'root/self.md', 'general', 'Self text about the blue widget. '.repeat(20));
      ids.peerOld = await publishDocument(ctx, ctx.tenant, 'root/peer-a.md', 'general', 'Peer text about the green widget.');
      ids.peerNew = await publishDocument(ctx, ctx.tenant, 'root/peer-b.md', 'general', 'Peer text about the red widget.');
      ids.otherType = await publishDocument(ctx, ctx.tenant, 'root/other-type.md', 'contract_legal', 'A text of another type.');
      ids.ownOldVersion = await publishDocument(ctx, ctx.tenant, 'root/self-lineage.md', 'general', 'First version of a lineage.');
      ids.ownNewVersion = await publishDocument(ctx, ctx.tenant, 'root/self-lineage.md', 'general', 'Second version of a lineage.');
      if (ctx.other) ids.foreign = await publishDocument(ctx, ctx.other, 'root/foreign.md', 'general', 'Text of another tenant.');
    });

    after(async () => {
      await ctx?.db.close();
    });

    test('returns the document itself and the newest same-type current documents of its tenant outside its lineage', async () => {
      const result = await peers(ctx, ctx.tenant.key, ids.self as string);
      const self = result.filter((row) => row.is_self === true);
      assert.equal(self.length, 1);
      assert.equal(self[0]?.document_id, ids.self);
      const others = result.filter((row) => row.is_self !== true).map((row) => String(row.document_id));
      // The fixture corpus adds older documents of the tenant after ours.
      assert.deepEqual(others.slice(0, 3), [ids.ownNewVersion, ids.peerNew, ids.peerOld], 'newest first');
      assert.ok(!others.includes(ids.otherType as string));
      assert.ok(!others.includes(ids.ownOldVersion as string));
      if (ids.foreign) assert.ok(!others.includes(ids.foreign));
    });

    test('excludes the versions of its own lineage', async () => {
      const result = await peers(ctx, ctx.tenant.key, ids.ownNewVersion as string);
      const others = result.filter((row) => row.is_self !== true).map((row) => String(row.document_id));
      assert.ok(!others.includes(ids.ownOldVersion as string));
      assert.ok(others.includes(ids.self as string));
    });

    test('bounds the rows and the text: content only for the first peers, cut to the character limit', async () => {
      const result = await peers(ctx, ctx.tenant.key, ids.self as string, 2, 1, 40);
      const self = result.find((row) => row.is_self === true) as Row;
      assert.equal(String(self.content).length, 40);
      const others = result.filter((row) => row.is_self !== true);
      assert.equal(others.length, 2);
      assert.ok(typeof others[0]?.content === 'string' && String(others[0]?.content).length <= 40);
      assert.equal(others[1]?.content, null);
      const noText = await peers(ctx, ctx.tenant.key, ids.self as string, 5, 0, 0);
      assert.ok(noText.every((row) => row.content === null), 'no text is loaded for the title rule alone');
      const huge = await peers(ctx, ctx.tenant.key, ids.self as string, 100000, 100000, 10_000_000);
      assert.ok(huge.length <= 501);
    });

    test('answers nothing for another tenant key, a non-current document, and rejects a malformed key', async () => {
      if (ctx.other) assert.deepEqual(await peers(ctx, ctx.other.key, ids.self as string), []);
      assert.deepEqual(await peers(ctx, ctx.tenant.key, ids.ownOldVersion as string), []);
      await assert.rejects(ctx.db.query('SELECT * FROM rag_supersession_peers($1, $2::uuid, 1, 1, 1)', ['bogus', ids.self]));
    });

    test('rag_supersession_replace_target names a current document of the tenant only', async () => {
      const target = (await ctx.db.query<Row>('SELECT * FROM rag_supersession_replace_target($1, $2::uuid)', [ctx.tenant.key, ids.peerOld])).rows;
      assert.equal(target.length, 1);
      assert.equal(target[0]?.source, 'config_upload');
      assert.equal(target[0]?.source_key, 'root/peer-a.md');
      assert.deepEqual((await ctx.db.query('SELECT * FROM rag_supersession_replace_target($1, $2::uuid)', [ctx.tenant.key, ids.ownOldVersion])).rows, []);
      if (ctx.other && ids.foreign) {
        assert.deepEqual((await ctx.db.query('SELECT * FROM rag_supersession_replace_target($1, $2::uuid)', [ctx.tenant.key, ids.foreign])).rows, []);
      }
    });

    test('both functions are SECURITY INVOKER, service_role only, with an empty search_path', async () => {
      const functions = (
        await ctx.db.query<Row>(
          `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                  array_to_string(p.proconfig, ',') AS config
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('rag_supersession_peers', 'rag_supersession_replace_target') ORDER BY 1`,
        )
      ).rows;
      assert.equal(functions.length, 2);
      for (const row of functions) {
        assert.equal(row.definer, false, `${row.sig}: invoker`);
        assert.equal(row.anon, false, `${row.sig}: anon cannot execute`);
        assert.equal(row.authenticated, false, `${row.sig}: authenticated cannot execute`);
        assert.equal(row.service, true, `${row.sig}: service_role executes`);
        assert.equal(row.config, 'search_path=""');
      }
    });
  });
}
