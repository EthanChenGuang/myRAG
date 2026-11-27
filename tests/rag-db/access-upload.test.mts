import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';

// Phase 4.3 plan 23 (SEC-12, D-16, D-19, RESEARCH Pitfall 7): an upload's access label is on the version (and its chunks) before
// rag_publish_document_version runs, a new version without a choice inherits it, and an explicit choice relabels the whole lineage.
// Fixtures are neutral synthetic sentences.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const IDS = {
  member: '00000000-0000-4000-8000-0000000230a1',
  org: '00000000-0000-4000-8000-0000000230c1',
  groupA: '00000000-0000-4000-8000-0000000230f1',
} as const;
const GROUP_KEY = `g:${IDS.groupA}`;

const body = (n: number) => `# Neutral record\n\nThe neutral synthetic record number ${n} lists a quiet amber cobalt sequence for testing.\n`;

type Row = Record<string, unknown>;

let sharedEdge: FakeEdge | null = null;
const savedEnv: Record<string, string | undefined> = {};

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await sharedEdge?.close();
});

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  describe(`upload access label before publish (${mode})`, () => {
    const multi = mode === 'multi-tenant';
    const tenantKey = multi ? `o:${IDS.org}` : 's:default';
    let db: PGlite;
    let ingestModule: typeof import('@/lib/rag/ingest');
    let depsModule: typeof import('@/lib/rag/ingest/deps');
    let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
    let fakeStoreModule: typeof import('../helpers/fake-object-store');
    let scopeModule: typeof import('@/lib/rag/tenant/scope');
    let supabaseModule: typeof import('@/lib/supabase');
    /** What the document and its chunks carried at the moment publish was called. */
    const atPublish: Array<{ documentId: string; status: string; documentLabel: string[]; chunkLabels: string[][] }> = [];

    const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

    before(async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, relex: false });
      db = fixture.db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [IDS.member, 'member@example.invalid']);
      if (multi) {
        await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
          IDS.org,
          'Neutral workspace',
          'neutral-workspace-23',
          IDS.member,
        ]);
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [IDS.org, IDS.member]);
        await db.query('INSERT INTO rag_access_groups (id, key, name, organization_id) VALUES ($1, $2, $3, $4)', [IDS.groupA, 'group-a', 'Group A', IDS.org]);
      } else {
        await db.query('INSERT INTO rag_access_groups (id, key, name) VALUES ($1, $2, $3)', [IDS.groupA, 'group-a', 'Group A']);
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [IDS.groupA, IDS.member]);

      if (sharedEdge === null) {
        sharedEdge = await startFakeEdge({ db });
        const names = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE', ...Object.keys(fixtureProcessEnv(sharedEdge.url))];
        for (const name of names) savedEnv[name] = process.env[name];
      } else {
        sharedEdge.useDatabase(db);
      }
      Object.assign(process.env, fixtureProcessEnv(sharedEdge.url));
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      ingestModule = await import('@/lib/rag/ingest');
      depsModule = await import('@/lib/rag/ingest/deps');
      objectStoreModule = await import('@/lib/rag/ingest/object-store');
      fakeStoreModule = await import('../helpers/fake-object-store');
      scopeModule = await import('@/lib/rag/tenant/scope');
      supabaseModule = await import('@/lib/supabase');
      (await import('@/lib/rag/embeddings/registry')).resetEmbeddingProvidersForTests();
      (await import('@/lib/rag/embeddings/active-profile')).resetActiveProfileForTests();
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(() => {
      objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
      const real = supabaseModule.getSupabaseAdmin();
      assert.ok(real, 'admin client');
      // Before publish runs, record the label the version and its chunks carry right then.
      const recording = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'rpc') {
            return (fn: string, args?: Record<string, unknown>, opts?: unknown) => {
              if (fn === 'rag_publish_document_version') {
                const documentId = String(args?.p_document_id);
                const pending = (async () => {
                  const doc = await rows('SELECT status, access_groups FROM documents WHERE id = $1', [documentId]);
                  const chunks = await rows('SELECT access_groups FROM document_chunks WHERE document_id = $1', [documentId]);
                  atPublish.push({
                    documentId,
                    status: String(doc[0]?.status),
                    documentLabel: doc[0]?.access_groups as string[],
                    chunkLabels: chunks.map((chunk) => chunk.access_groups as string[]),
                  });
                })();
                const builder = { abortSignal: (signal: AbortSignal) => pending.then(() => target.rpc(fn, args, opts as never).abortSignal(signal)) };
                return builder;
              }
              return target.rpc(fn, args, opts as never);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      depsModule.setIngestDepsForTests({ db: () => recording as never });
    });

    afterEach(() => {
      objectStoreModule.resetObjectStoreForTests();
      depsModule.resetIngestDepsForTests();
    });

    const scope = () => (multi ? scopeModule.mintScope('org', IDS.member, IDS.org) : scopeModule.mintScope('single', null, null));

    const upload = (n: number, accessKeys?: string[]) =>
      ingestModule.ingest({
        scope: scope(),
        source: 'config_upload',
        sourceKey: 'access-upload/neutral-record.md',
        uploaderId: IDS.member,
        text: body(n),
        filename: 'neutral-record.md',
        mimeType: 'text/markdown',
        ...(accessKeys ? { accessKeys } : {}),
        signal: new AbortController().signal,
      });

    let lineage = '';

    test('a restricted upload carries its label on the document and every chunk before publish, audited as an upload', async () => {
      atPublish.length = 0;
      const result = await upload(1, [GROUP_KEY]);
      assert.equal(result.status, 'ready');
      assert.ok(result.documentId);
      const seen = atPublish.find((entry) => entry.documentId === result.documentId);
      assert.ok(seen, 'publish was called for the version');
      assert.equal(seen.status, 'processing', 'not retrievable before publish');
      assert.deepEqual(seen.documentLabel, [GROUP_KEY]);
      assert.ok(seen.chunkLabels.length > 0, 'chunks were written before publish');
      for (const label of seen.chunkLabels) assert.deepEqual(label, [GROUP_KEY]);

      const stored = await rows('SELECT access_groups, lineage_id, tenant_key FROM documents WHERE id = $1', [result.documentId]);
      assert.deepEqual(stored[0]?.access_groups, [GROUP_KEY]);
      assert.equal(stored[0]?.tenant_key, tenantKey);
      lineage = String(stored[0]?.lineage_id);
      const audit = await rows(
        "SELECT actor::text AS actor, actor_kind, reason, after_groups FROM rag_access_audit WHERE action = 'document_set' AND lineage_id = $1",
        [lineage],
      );
      assert.deepEqual(audit, [{ actor: IDS.member, actor_kind: 'system', reason: 'upload', after_groups: [GROUP_KEY] }]);
    });

    test('a new version without a choice inherits the lineage label (D-19)', async () => {
      atPublish.length = 0;
      const result = await upload(2);
      assert.equal(result.status, 'ready');
      assert.equal(result.version, 2);
      const seen = atPublish.find((entry) => entry.documentId === result.documentId);
      assert.deepEqual(seen?.documentLabel, [GROUP_KEY], 'inherited before publish');
      const versions = await rows('SELECT version, access_groups FROM documents WHERE lineage_id = $1 ORDER BY version', [lineage]);
      assert.deepEqual(versions.map((row) => row.access_groups), [[GROUP_KEY], [GROUP_KEY]]);
      const audit = await rows("SELECT count(*)::int AS n FROM rag_access_audit WHERE action = 'document_set' AND lineage_id = $1", [lineage]);
      assert.equal(audit[0]?.n, 1, 'inheritance writes no audit row');
    });

    test('an explicit everyone choice relabels the whole lineage', async () => {
      atPublish.length = 0;
      const result = await upload(3, ['all']);
      assert.equal(result.status, 'ready');
      const seen = atPublish.find((entry) => entry.documentId === result.documentId);
      assert.deepEqual(seen?.documentLabel, ['all']);
      const versions = await rows('SELECT access_groups FROM documents WHERE lineage_id = $1 ORDER BY version', [lineage]);
      assert.equal(versions.length, 3);
      for (const row of versions) assert.deepEqual(row.access_groups, ['all']);
      const chunks = await rows(
        'SELECT DISTINCT c.access_groups FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.lineage_id = $1',
        [lineage],
      );
      assert.deepEqual(chunks.map((row) => row.access_groups), [['all']]);
    });

    test('a label the database refuses fails the version closed: it is never published', async () => {
      atPublish.length = 0;
      const unknown = 'g:00000000-0000-4000-8000-0000000230ff';
      const result = await ingestModule.ingest({
        scope: scope(),
        source: 'config_upload',
        sourceKey: 'access-upload/other-record.md',
        uploaderId: IDS.member,
        text: body(4),
        filename: 'other-record.md',
        mimeType: 'text/markdown',
        accessKeys: [unknown],
        signal: new AbortController().signal,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'unknown_group');
      assert.equal(atPublish.length, 0, 'publish was never called');
      const stored = await rows("SELECT status, is_current FROM documents WHERE filename = 'other-record.md'");
      for (const row of stored) assert.notEqual(row.status, 'ready');
    });

    test('a legacy insert that carries the label is restricted from its first moment, chunks included (Pitfall 7)', async () => {
      // The statement the legacy writers send (storeDocument, process-document, ai-to-rag), as the service role: one INSERT with the label.
      const content = 'The neutral legacy record lists a quiet teal cobalt sequence for testing.';
      const docId = '00000000-0000-4000-8000-0000000230d1';
      const plainId = '00000000-0000-4000-8000-0000000230d2';
      const orgColumn = multi ? ', organization_id' : '';
      await db.exec('SET ROLE service_role');
      try {
        await db.query(
          `INSERT INTO documents (id, filename, content, metadata, user_id, access_groups${orgColumn}) VALUES ($1, 'legacy-a.md', $2, '{}'::jsonb, $3, $4::text[]${multi ? ', $5' : ''})`,
          [docId, content, IDS.member, [GROUP_KEY], ...(multi ? [IDS.org] : [])],
        );
        await db.query(
          `INSERT INTO documents (id, filename, content, metadata, user_id${orgColumn}) VALUES ($1, 'legacy-b.md', $2, '{}'::jsonb, $3${multi ? ', $4' : ''})`,
          [plainId, content, IDS.member, ...(multi ? [IDS.org] : [])],
        );
        for (const id of [docId, plainId]) {
          await db.query(
            `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${orgColumn}) VALUES (gen_random_uuid(), $1, $2, $3::vector, 0, '{}'::jsonb${multi ? ', $4' : ''})`,
            [id, content, '[' + embedText(content).join(',') + ']', ...(multi ? [IDS.org] : [])],
          );
        }
      } finally {
        await db.exec('RESET ROLE');
      }
      const label = async (id: string) => ({
        doc: (await rows('SELECT access_groups FROM documents WHERE id = $1', [id]))[0]?.access_groups,
        chunks: (await rows('SELECT access_groups FROM document_chunks WHERE document_id = $1', [id])).map((row) => row.access_groups),
      });
      assert.deepEqual(await label(docId), { doc: [GROUP_KEY], chunks: [[GROUP_KEY]] });
      assert.deepEqual(await label(plainId), { doc: ['all'], chunks: [['all']] }, 'no label: the default, as today');
      const audit = await rows('SELECT count(*)::int AS n FROM rag_access_audit WHERE document_id = ANY($1::uuid[])', [[docId, plainId]]);
      assert.equal(audit[0]?.n, 0, 'no relabel after the insert');
    });
  });
}
