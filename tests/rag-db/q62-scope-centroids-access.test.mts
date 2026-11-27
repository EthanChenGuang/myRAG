import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * Phase 6.2 R-4 (0987): while access groups are enforced, scope centroids are built only from documents open to every member of the
 * tenant (access_groups = {all}). A restricted document must not move a centroid, add a group key or change a member count, so the
 * in/out score a user outside the group gets cannot reveal it. With enforcement off the rebuild is unchanged.
 */

const LEGACY = 'openai-3-small-1536';
const GROUP_ID = '00000000-0000-4000-8000-0000000098a1';
const GROUP_KEY = `g:${GROUP_ID}`;

function sparse(dims: number, values: number[]): string {
  const out = new Array<number>(dims).fill(0);
  values.forEach((value, index) => {
    out[index] = value;
  });
  return `[${out.join(',')}]`;
}

async function asService<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

interface DocOptions {
  docType?: string;
  scopes?: string[];
  accessGroups?: string[];
}

async function insertDoc(db: PGlite, mode: DeploymentMode, options: DocOptions = {}): Promise<string> {
  const id = crypto.randomUUID();
  const cols = ['id', 'filename', 'content', 'metadata', 'lineage_id', 'source_key', 'status', 'is_current', 'doc_type', 'scopes', 'access_groups'];
  const vals: unknown[] = [
    id,
    `doc-${id}.md`,
    'A neutral synthetic paragraph.',
    '{}',
    id,
    `legacy:${id}`,
    'ready',
    true,
    options.docType ?? 'general',
    options.scopes ?? [],
    options.accessGroups ?? ['all'],
  ];
  if (mode === 'multi-tenant') {
    cols.push('user_id');
    vals.push(FIXTURE_USER_ID);
  }
  await db.query(`INSERT INTO documents (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  return id;
}

async function insertChunk(db: PGlite, documentId: string, vector: string): Promise<void> {
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, language, embedding, is_current, status)
     VALUES ($1, $2, 'A neutral synthetic sentence.', 0, '{}'::jsonb, 'en', $3::vector, true, 'ready')`,
    [crypto.randomUUID(), documentId, vector],
  );
}

interface Row {
  group_kind: string;
  group_key: string;
  centroid: string;
  member_count: number;
}

async function rebuildAndList(db: PGlite, tenant: string): Promise<Row[]> {
  return asService(db, async () => {
    await db.query('SELECT * FROM public.rag_scope_centroids_rebuild($1, $2)', [tenant, LEGACY]);
    const result = await db.query<Row>(
      'SELECT group_kind, group_key, centroid::text AS centroid, member_count FROM public.rag_scope_centroids_list($1, $2)',
      [tenant, LEGACY],
    );
    return result.rows;
  });
}

async function centroidCount(db: PGlite, tenant: string): Promise<number> {
  const result = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM public.rag_scope_centroids WHERE tenant_key = $1', [tenant]);
  return Number(result.rows[0]?.n ?? 0);
}

async function setEnforced(db: PGlite, enforced: boolean): Promise<void> {
  await db.query('UPDATE public.rag_access_group_settings SET enforced = $1', [enforced]);
}

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';

  describe(`scope centroids and access groups (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await setEnforced(db, false);
      await db.exec('DELETE FROM public.rag_scope_centroids; DELETE FROM chunk_embeddings; DELETE FROM document_chunks; DELETE FROM documents;');
    });

    async function seedOpen(): Promise<void> {
      const open = await insertDoc(db, mode, { docType: 'general', scopes: ['region:north'] });
      await insertChunk(db, open, sparse(1536, [0.5, 0.25]));
      await insertChunk(db, open, sparse(1536, [0.25, 0.5]));
    }

    async function seedRestricted(): Promise<string> {
      const restricted = await insertDoc(db, mode, { docType: 'contract_legal', scopes: ['region:south'], accessGroups: [GROUP_KEY] });
      await insertChunk(db, restricted, sparse(1536, [0, 0, 0, 1]));
      return restricted;
    }

    test('enforced: a restricted document leaves every centroid, group key and count as if it did not exist', async () => {
      await setEnforced(db, true);
      await seedOpen();
      const baseline = await rebuildAndList(db, tenant);
      assert.ok(baseline.length > 0);

      await seedRestricted();
      const withRestricted = await rebuildAndList(db, tenant);
      assert.deepEqual(withRestricted, baseline);
      const keys = withRestricted.map((row) => row.group_key);
      assert.ok(!keys.some((key) => key.startsWith('contract_legal/')), 'restricted doc type leaked as a group key');
      assert.ok(!keys.some((key) => key.startsWith('region:south/')), 'restricted scope tag leaked as a group key');
      assert.equal(withRestricted.find((row) => row.group_key === 'tenant/en')?.member_count, 2);
    });

    test('enforced: the rebuild source applies access_groups', async () => {
      const result = await db.query<{ src: string }>(
        "SELECT prosrc AS src FROM pg_proc WHERE oid = 'public.rag_scope_centroids_rebuild(text, text)'::regprocedure",
      );
      assert.match(result.rows[0]!.src, /access_groups/);
      assert.match(result.rows[0]!.src, /rag_access_enforced/);
    });

    test('not enforced: the rebuild is unchanged and still counts labelled documents', async () => {
      await seedOpen();
      await seedRestricted();
      const rows = await rebuildAndList(db, tenant);
      const keys = rows.map((row) => row.group_key);
      assert.ok(keys.includes('contract_legal/en'));
      assert.ok(keys.includes('region:south/en'));
      assert.equal(rows.find((row) => row.group_key === 'tenant/en')?.member_count, 3);
    });

    test('turning enforcement on clears centroids built while it was off', async () => {
      await seedOpen();
      await seedRestricted();
      await rebuildAndList(db, tenant);
      assert.ok((await centroidCount(db, tenant)) > 0);
      await db.query('UPDATE public.rag_access_group_settings SET updated_at = now()');
      assert.ok((await centroidCount(db, tenant)) > 0, 'a write that does not change enforced keeps the centroids');
      await setEnforced(db, true);
      assert.equal(await centroidCount(db, tenant), 0);
    });

    test('applying the migrations while enforced clears centroids built earlier; a rebuild excludes the restricted document', async () => {
      await seedOpen();
      await seedRestricted();
      await rebuildAndList(db, tenant);
      await db.exec('ALTER TABLE public.rag_access_group_settings DISABLE TRIGGER USER');
      try {
        await setEnforced(db, true);
      } finally {
        await db.exec('ALTER TABLE public.rag_access_group_settings ENABLE TRIGGER USER');
      }
      assert.ok((await centroidCount(db, tenant)) > 0, 'precondition: stale centroids built while access was off');
      await applyMigrations(db, mode);
      assert.equal(await centroidCount(db, tenant), 0);
      const rows = await rebuildAndList(db, tenant);
      assert.equal(rows.find((row) => row.group_key === 'tenant/en')?.member_count, 2);
    });

    test('applying the migrations while not enforced keeps the centroids', async () => {
      await seedOpen();
      const built = await rebuildAndList(db, tenant);
      await applyMigrations(db, mode);
      assert.equal(await centroidCount(db, tenant), built.length);
    });

    test('changing a document access label clears the tenant centroids', async () => {
      await setEnforced(db, true);
      await seedOpen();
      const restricted = await seedRestricted();
      await rebuildAndList(db, tenant);
      assert.ok((await centroidCount(db, tenant)) > 0);
      await db.query("UPDATE documents SET access_groups = '{all}' WHERE id = $1", [restricted]);
      assert.equal(await centroidCount(db, tenant), 0);
      const rows = await rebuildAndList(db, tenant);
      assert.equal(rows.find((row) => row.group_key === 'tenant/en')?.member_count, 3);
    });
  });
}
