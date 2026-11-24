import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const ZERO_VECTOR = `[${new Array(1536).fill(0).join(',')}]`;
const UPLOADER = '00000000-0000-4000-8000-0000000081a1';
const OTHER = '00000000-0000-4000-8000-0000000081b1';
const MEMBER = '00000000-0000-4000-8000-0000000081c1';
const ADMIN = '00000000-0000-4000-8000-0000000081d1';
const ORG = '00000000-0000-4000-8000-0000000081e1';
const QUARANTINED = '00000000-0000-4000-8000-0000000d0001';
const OTHERS_READY = '00000000-0000-4000-8000-0000000d0002';
const ORG_QUARANTINED = '00000000-0000-4000-8000-0000000d0003';
const CHUNK_OF = (doc: string): string => doc.replace('0d000', '0c000');

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [userId ?? '', role]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

async function attempt(db: PGlite, role: Role, userId: string | null, sql: string): Promise<{ ok: boolean; message: string }> {
  try {
    await asRole(db, role, userId, () => db.query(sql));
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function seedDocument(db: PGlite, mode: DeploymentMode, doc: string, status: string, current: boolean, user: string, org: string | null): Promise<void> {
  const multi = mode === 'multi-tenant';
  const columns = ['id', 'filename', 'content', 'status', 'is_current', 'source', 'source_key', 'lineage_id', ...(multi ? ['user_id', 'organization_id'] : [])];
  const values: unknown[] = [doc, `${doc}.md`, 'body', status, current, 'config_upload', `root/${doc}`, doc, ...(multi ? [user, org] : [])];
  await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`, values);
  if (!multi) await db.query('UPDATE documents SET user_id = $2 WHERE id = $1', [doc, user]);
  const chunkColumns = ['id', 'document_id', 'content', 'embedding', 'chunk_index', 'status', 'is_current', ...(multi ? ['organization_id'] : [])];
  const chunkValues: unknown[] = [CHUNK_OF(doc), doc, `chunk of ${doc}`, ZERO_VECTOR, 0, status, current, ...(multi ? [org] : [])];
  await db.query(`INSERT INTO document_chunks (${chunkColumns.join(', ')}) VALUES (${chunkValues.map((_, i) => `$${i + 1}`).join(', ')})`, chunkValues);
}

async function build(mode: DeploymentMode): Promise<PGlite> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true });
  const users = [UPLOADER, OTHER, MEMBER, ADMIN];
  await db.query(`INSERT INTO auth.users (id, email) VALUES ${users.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')} ON CONFLICT DO NOTHING`, users.flatMap((u, i) => [u, `u${i}@example.invalid`]));
  await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN]);
  if (mode === 'multi-tenant') {
    await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Org', 'org-guard', $2, false)", [ORG, OTHER]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [ORG, OTHER, MEMBER]);
    await seedDocument(db, mode, ORG_QUARANTINED, 'quarantined', false, OTHER, ORG);
  }
  await seedDocument(db, mode, QUARANTINED, 'quarantined', false, UPLOADER, null);
  await seedDocument(db, mode, OTHERS_READY, 'ready', true, OTHER, null);
  return db;
}

async function stateOf(db: PGlite, table: 'documents' | 'document_chunks', id: string): Promise<Row> {
  const result = await db.query<Row>(`SELECT status, is_current, version FROM ${table} WHERE id = $1`, [id]);
  return result.rows[0] as Row;
}

async function restore(db: PGlite): Promise<void> {
  await db.query(
    `UPDATE documents SET status = 'quarantined', is_current = false, version = 1, filename = id::text || '.md', metadata = '{}'::jsonb, processing_state = '{}'::jsonb, superseded_by = NULL, lineage_id = id WHERE id = $1`,
    [QUARANTINED],
  );
  await db.query("UPDATE document_chunks SET status = 'quarantined', is_current = false WHERE document_id = $1", [QUARANTINED]);
  await db.query("DELETE FROM documents WHERE lineage_id = $1 AND id <> $1", [QUARANTINED]);
}

const QUARANTINED_STATE = { status: 'quarantined', is_current: false, version: 1 };

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  describe(`authenticated users cannot change ingest state through the tables (${mode})`, () => {
    let shared: PGlite;
    before(async () => {
      shared = await build(mode);
    });
    after(async () => {
      await shared.close();
    });
    const uploaderId = UPLOADER;
    const actors: Array<{ label: string; user: string; doc: string }> =
      mode === 'single-tenant'
        ? [
            { label: 'uploader', user: uploaderId, doc: QUARANTINED },
            { label: 'admin', user: ADMIN, doc: QUARANTINED },
          ]
        : [
            { label: 'uploader', user: uploaderId, doc: QUARANTINED },
            { label: 'org member', user: MEMBER, doc: ORG_QUARANTINED },
          ];

    const flips: Array<{ label: string; set: string }> = [
      { label: 'status', set: "status = 'ready'" },
      { label: 'is_current', set: 'is_current = true' },
      { label: 'status and is_current', set: "status = 'ready', is_current = true" },
      { label: 'version', set: 'version = version + 1' },
      { label: 'lineage_id', set: 'lineage_id = gen_random_uuid()' },
      { label: 'superseded_by', set: 'superseded_by = gen_random_uuid()' },
    ];

    for (const actor of actors) {
      for (const flip of flips) {
        test(`${actor.label} cannot set documents ${flip.label} on a quarantined document`, async () => {
          const db = shared;
          try {
            const result = await attempt(db, 'authenticated', actor.user, `UPDATE documents SET ${flip.set}`);
            const row = await stateOf(db, 'documents', actor.doc);
            assert.deepEqual({ status: row.status, is_current: row.is_current, version: row.version }, QUARANTINED_STATE, `row changed (statement ok=${result.ok})`);
            assert.equal(result.ok, false, 'the statement must be refused');
            assert.match(result.message, /ingest state/);
          } finally {
            await restore(db);
          }
        });
      }
    }

    test('the uploader cannot release the chunks of a quarantined document', async () => {
      const db = shared;
      try {
        await attempt(db, 'authenticated', UPLOADER, "UPDATE document_chunks SET status = 'ready', is_current = true");
        const row = await stateOf(db, 'document_chunks', CHUNK_OF(QUARANTINED));
        assert.deepEqual({ status: row.status, is_current: row.is_current }, { status: 'quarantined', is_current: false });
        if (mode === 'single-tenant') {
          const refused = await attempt(db, 'authenticated', UPLOADER, "UPDATE document_chunks SET status = 'ready'");
          assert.equal(refused.ok, false);
          assert.match(refused.message, /ingest state/);
        }
      } finally {
        await restore(db);
      }
    });

    test('the uploader cannot change the tenant key or version of a chunk', async () => {
      const db = shared;
      try {
        if (mode === 'single-tenant') {
          const result = await attempt(db, 'authenticated', UPLOADER, "UPDATE document_chunks SET tenant_key = 'u:00000000-0000-4000-8000-0000000081b1'");
          assert.equal(result.ok, false);
          assert.match(result.message, /ingest state/);
        }
        const chunk = await db.query<Row>('SELECT tenant_key FROM document_chunks WHERE id = $1', [CHUNK_OF(QUARANTINED)]);
        assert.notEqual(chunk.rows[0]?.tenant_key, 'u:00000000-0000-4000-8000-0000000081b1');
      } finally {
        await restore(db);
      }
    });

    test('ordinary edits and no-op writes of the guarded columns still work for the owner', async () => {
      const db = shared;
      try {
        const rename = await attempt(db, 'authenticated', UPLOADER, "UPDATE documents SET filename = 'renamed.md', metadata = '{\"note\":1}'::jsonb");
        assert.equal(rename.ok, true, rename.message);
        const noop = await attempt(db, 'authenticated', UPLOADER, 'UPDATE documents SET status = status, is_current = is_current, version = version');
        assert.equal(noop.ok, true, noop.message);
        const renamed = await db.query<Row>('SELECT filename FROM documents WHERE id = $1', [QUARANTINED]);
        assert.equal(renamed.rows[0]?.filename, 'renamed.md');
      } finally {
        await restore(db);
      }
    });

    test('service_role and the database owner still change ingest state', async () => {
      const db = shared;
      try {
        const service = await attempt(db, 'service_role', null, `UPDATE documents SET status = 'ready', is_current = true, version = 2 WHERE id = '${QUARANTINED}'`);
        assert.equal(service.ok, true, service.message);
        const serviceChunk = await attempt(db, 'service_role', null, `UPDATE document_chunks SET status = 'ready', is_current = true WHERE document_id = '${QUARANTINED}'`);
        assert.equal(serviceChunk.ok, true, serviceChunk.message);
        assert.deepEqual(
          { status: (await stateOf(db, 'documents', QUARANTINED)).status, chunk: (await stateOf(db, 'document_chunks', CHUNK_OF(QUARANTINED))).status },
          { status: 'ready', chunk: 'ready' },
        );
        await db.query("UPDATE documents SET status = 'quarantined', is_current = false WHERE id = $1", [QUARANTINED]);
        assert.equal((await stateOf(db, 'documents', QUARANTINED)).status, 'quarantined');
      } finally {
        await restore(db);
      }
    });

    test('the admin release path (rag_release_quarantine, definer) still releases the document', async () => {
      const db = shared;
      try {
        const doc = QUARANTINED;
        await db.query(
          "UPDATE documents SET metadata = jsonb_build_object('quarantine', jsonb_build_object('rule_ids', jsonb_build_array('ignore-previous'))), processing_state = '{}'::jsonb WHERE id = $1",
          [doc],
        );
        if (mode === 'multi-tenant') await db.query('UPDATE documents SET user_id = $2 WHERE id = $1', [doc, ADMIN]);
        const released = await asRole(db, 'service_role', null, () => db.query<Row>('SELECT * FROM rag_release_quarantine($1, $2)', [doc, ADMIN]));
        assert.equal(released.rows[0]?.outcome, 'published');
        assert.deepEqual(
          { status: (await stateOf(db, 'documents', doc)).status, current: (await stateOf(db, 'documents', doc)).is_current },
          { status: 'ready', current: true },
        );
      } finally {
        await restore(db);
      }
    });
  });
}
