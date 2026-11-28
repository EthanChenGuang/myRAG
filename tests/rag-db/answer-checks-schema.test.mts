import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const CHECKS_MIGRATION = 'supabase/migrations/0940_rag_answer_checks.sql';
const VERSION_LABEL_MIGRATION = 'supabase/migrations/0941_documents_version_label.sql';

type Role = 'anon' | 'authenticated' | 'service_role';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createDocument(db: PGlite, mode: DeploymentMode, userId: string): Promise<{ id: string; tenantKey: string }> {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'fixture.txt', 'fixture body', $2)", [id, userId]);
  const tenantKey = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM documents WHERE id = $1', [id])).rows[0]?.tenant_key;
  assert.equal(tenantKey, mode === 'single-tenant' ? 's:default' : `u:${userId}`);
  return { id, tenantKey: tenantKey as string };
}

async function insertRecord(db: PGlite, userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const values: Record<string, unknown> = { id, user_id: userId, rag_mode: 'strict', ...extra };
  const columns = Object.entries(values);
  await db.query(
    `INSERT INTO rag_answer_records (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    columns.map(([, value]) => value),
  );
  return id;
}

async function catalog(db: PGlite, table: string): Promise<Record<string, string[]>> {
  const sorted = async (sql: string, params: unknown[] = []) =>
    (await db.query<Record<string, unknown>>(sql, params)).rows.map((row) => JSON.stringify(row)).sort();
  return {
    columns: await sorted(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    ),
    constraints: await sorted('SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass', [`public.${table}`]),
    functions: await sorted(
      `SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig::text AS config, p.proacl::text AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rag_set_document_version_label'`,
    ),
  };
}

async function label(db: PGlite, documentId: string): Promise<string | null> {
  return (await db.query<{ version_label: string | null }>('SELECT version_label FROM documents WHERE id = $1', [documentId])).rows[0]?.version_label ?? null;
}

async function setLabel(db: PGlite, tenantKey: string, documentId: string, value: string | null): Promise<boolean> {
  return asRole(db, 'service_role', async () => {
    const row = (
      await db.query<{ ok: boolean }>('SELECT public.rag_set_document_version_label($1, $2, $3) AS ok', [tenantKey, documentId, value])
    ).rows[0];
    return row?.ok === true;
  });
}

for (const mode of MODES) {
  describe(`0940 answer checks and 0941 version label (${mode})`, () => {
    let db: PGlite;
    let userId: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true })).db;
      userId = await createUser(db);
    });

    after(async () => {
      await db.close();
    });

    test('a record written without checks reads checks {} and texts_source null', async () => {
      const id = await insertRecord(db, userId);
      const row = (await db.query<{ checks: unknown; texts_source: string | null }>('SELECT checks, texts_source FROM rag_answer_records WHERE id = $1', [id]))
        .rows[0];
      assert.deepEqual(row?.checks, {});
      assert.equal(row?.texts_source, null);
    });

    test('checks must be a JSON object and texts_source registry or legacy', async () => {
      await rejectsWith(() => insertRecord(db, userId, { checks: JSON.stringify([1, 2]) }), '23514');
      await rejectsWith(() => insertRecord(db, userId, { checks: JSON.stringify('text') }), '23514');
      await rejectsWith(() => insertRecord(db, userId, { checks: null }), '23502');
      await rejectsWith(() => insertRecord(db, userId, { texts_source: 'other' }), '23514');
      for (const source of ['registry', 'legacy']) {
        const id = await insertRecord(db, userId, { checks: JSON.stringify({ sentences: [] }), texts_source: source });
        const row = (await db.query<{ texts_source: string }>('SELECT texts_source FROM rag_answer_records WHERE id = $1', [id])).rows[0];
        assert.equal(row?.texts_source, source);
      }
    });

    test('version_label is nullable, at most 40 characters and carries no control characters', async () => {
      const doc = await createDocument(db, mode, userId);
      assert.equal(await label(db, doc.id), null);
      await rejectsWith(() => db.query('UPDATE documents SET version_label = $1 WHERE id = $2', ['x'.repeat(41), doc.id]), '23514');
      await rejectsWith(() => db.query('UPDATE documents SET version_label = $1 WHERE id = $2', ['v2\nignore', doc.id]), '23514');
      await db.query('UPDATE documents SET version_label = $1 WHERE id = $2', ['x'.repeat(40), doc.id]);
      assert.equal(await label(db, doc.id), 'x'.repeat(40));
    });

    test('rag_set_document_version_label sets, trims and clears the label of the tenant document', async () => {
      const doc = await createDocument(db, mode, userId);
      assert.equal(await setLabel(db, doc.tenantKey, doc.id, '  v3.1  '), true);
      assert.equal(await label(db, doc.id), 'v3.1');
      assert.equal(await setLabel(db, doc.tenantKey, doc.id, '   '), true);
      assert.equal(await label(db, doc.id), null);
      assert.equal(await setLabel(db, doc.tenantKey, doc.id, 'r2'), true);
      assert.equal(await setLabel(db, doc.tenantKey, doc.id, null), true);
      assert.equal(await label(db, doc.id), null);
      await rejectsWith(() => setLabel(db, doc.tenantKey, doc.id, 'y'.repeat(41)), '22023');
      assert.equal(await label(db, doc.id), null);
    });

    test('a missing document or another tenant key changes nothing', async () => {
      const doc = await createDocument(db, mode, userId);
      assert.equal(await setLabel(db, doc.tenantKey, doc.id, 'kept'), true);
      assert.equal(await setLabel(db, doc.tenantKey, crypto.randomUUID(), 'other'), false);
      if (mode === 'multi-tenant') {
        const otherUser = await createUser(db);
        assert.equal(await setLabel(db, `u:${otherUser}`, doc.id, 'stolen'), false);
        assert.equal(await setLabel(db, `o:${crypto.randomUUID()}`, doc.id, 'stolen'), false);
        await rejectsWith(() => setLabel(db, 's:default', doc.id, 'stolen'), '22023');
      } else {
        await rejectsWith(() => setLabel(db, `u:${userId}`, doc.id, 'stolen'), '22023');
      }
      assert.equal(await label(db, doc.id), 'kept');
    });

    test('a malformed tenant key raises 22023', async () => {
      const doc = await createDocument(db, mode, userId);
      for (const key of ['', 'tenant', 'u:not-a-uuid', null]) {
        await rejectsWith(() => setLabel(db, key as string, doc.id, 'v1'), '22023');
      }
    });

    test('anon and authenticated cannot execute rag_set_document_version_label', async () => {
      const doc = await createDocument(db, mode, userId);
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith(
          () => asRole(db, role, () => db.query('SELECT public.rag_set_document_version_label($1, $2, $3)', [doc.tenantKey, doc.id, 'v9'])),
          '42501',
        );
      }
      const fn = (
        await db.query<{ prosecdef: boolean; config: string[] | null }>(
          "SELECT prosecdef, proconfig AS config FROM pg_proc WHERE oid = 'public.rag_set_document_version_label(text, uuid, text)'::regprocedure",
        )
      ).rows[0];
      assert.equal(fn?.prosecdef, false);
      assert.deepEqual(fn?.config, ['search_path=""']);
    });

    test('applying 0940 and 0941 a second time changes nothing', async () => {
      const before = { records: await catalog(db, 'rag_answer_records'), documents: await catalog(db, 'documents') };
      const existing = await insertRecord(db, userId, { checks: JSON.stringify({ truncated: false }), texts_source: 'legacy' });
      for (const file of [CHECKS_MIGRATION, VERSION_LABEL_MIGRATION]) await db.exec(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      assert.deepEqual({ records: await catalog(db, 'rag_answer_records'), documents: await catalog(db, 'documents') }, before);
      const row = (await db.query<{ checks: unknown; texts_source: string }>('SELECT checks, texts_source FROM rag_answer_records WHERE id = $1', [existing])).rows[0];
      assert.deepEqual(row?.checks, { truncated: false });
      assert.equal(row?.texts_source, 'legacy');
    });
  });
}

describe('0940 and 0941 stay out of the setup files', () => {
  test('neither setup file defines checks, texts_source, version_label or the label setter', () => {
    for (const file of ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql']) {
      const sql = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const marker of ['texts_source', 'version_label', 'rag_set_document_version_label', 'rag_answer_records_checks_object']) {
        assert.equal(sql.includes(marker), false, `${file} must not fold ${marker}`);
      }
    }
  });
});
