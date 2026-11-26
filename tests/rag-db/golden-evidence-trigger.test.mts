import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const USER_A = '00000000-0000-4000-8000-0000000009a1';
const USER_B = '00000000-0000-4000-8000-0000000009b1';
const SET = 'set-1';

type Role = 'anon' | 'authenticated' | 'service_role';

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

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

async function insertDoc(db: PGlite, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, version)
     VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $1, $4, 'ready', true, 1)`,
    [id, `doc-${id}.md`, userId, `legacy:${id}`],
  );
  return id;
}

async function register(db: PGlite, tenantKey: string, rows: unknown[]): Promise<{ stored: number; dropped: number }> {
  const r = await db.query<{ stored: number; dropped: number }>(
    'SELECT stored, dropped FROM public.rag_golden_evidence_register($1, $2, $3::jsonb)',
    [tenantKey, SET, JSON.stringify(rows)],
  );
  return r.rows[0]!;
}

async function flags(db: PGlite): Promise<Record<string, boolean>> {
  const r = await db.query<{ item_id: string; flagged: boolean }>(
    'SELECT item_id, bool_or(needs_check) AS flagged FROM public.rag_golden_evidence_index GROUP BY item_id ORDER BY item_id',
  );
  return Object.fromEntries(r.rows.map((row) => [row.item_id, row.flagged]));
}

async function pending(db: PGlite, tenantKey: string): Promise<string[]> {
  const r = await db.query<{ item_id: string }>('SELECT item_id FROM public.rag_golden_evidence_pending($1, $2) AS item_id', [tenantKey, SET]);
  return r.rows.map((row) => row.item_id).sort();
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const TENANT_A = multi ? `u:${USER_A}` : 's:default';
  const OTHER_MODE_KEY = multi ? 's:default' : `u:${USER_A}`;

  describe(`golden evidence index 0969 (${mode})`, () => {
    let db: PGlite;
    let docA1: string;
    let docA2: string;
    let docUnregistered: string;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
        USER_A,
        'tenant-a@example.invalid',
        USER_B,
        'tenant-b@example.invalid',
      ]);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM public.rag_golden_evidence_index');
      docA1 = await insertDoc(db, USER_A);
      docA2 = await insertDoc(db, USER_A);
      docUnregistered = await insertDoc(db, USER_A);
      const result = await register(db, TENANT_A, [
        { item_id: 'item-1', document_id: docA1, quote_sha256: sha('first synthetic quote') },
        { item_id: 'item-2', document_id: docA2, quote_sha256: sha('second synthetic quote') },
      ]);
      assert.deepEqual(result, { stored: 2, dropped: 0 });
    });

    test('the index stores hashes only, with no quote column', async () => {
      const cols = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_golden_evidence_index' ORDER BY column_name",
      );
      assert.deepEqual(
        cols.rows.map((c) => c.column_name),
        ['document_id', 'item_id', 'needs_check', 'quote_sha256', 'registered_at', 'set_id', 'tenant_key'],
      );
    });

    test('register replaces the rows of the set', async () => {
      const result = await register(db, TENANT_A, [{ item_id: 'item-3', document_id: docA1, quote_sha256: sha('third synthetic quote') }]);
      assert.deepEqual(result, { stored: 1, dropped: 0 });
      assert.deepEqual(await flags(db), { 'item-3': false });
    });

    test('register drops malformed rows and unknown documents and counts them', async () => {
      const result = await register(db, TENANT_A, [
        { item_id: 'ok', document_id: docA1, quote_sha256: sha('kept synthetic quote') },
        { item_id: 'bad-hash', document_id: docA1, quote_sha256: 'not-a-hash' },
        { item_id: 'bad-uuid', document_id: 'not-a-uuid', quote_sha256: sha('x') },
        { item_id: 'missing-doc', document_id: crypto.randomUUID(), quote_sha256: sha('y') },
      ]);
      assert.deepEqual(result, { stored: 1, dropped: 3 });
    });

    test('a key of the other deployment mode raises 22023', async () => {
      await assert.rejects(() => register(db, OTHER_MODE_KEY, []), (error: unknown) => codeOf(error) === '22023');
    });

    test('superseding a registered document flags its items only', async () => {
      const next = await insertDoc(db, USER_A);
      await db.query('UPDATE documents SET is_current = false, superseded_by = $2 WHERE id = $1', [docA1, next]);
      assert.deepEqual(await flags(db), { 'item-1': true, 'item-2': false });
      assert.deepEqual(await pending(db, TENANT_A), ['item-1']);
    });

    test('a status change to deleted or quarantined flags the item', async () => {
      await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [docA1]);
      await db.query("UPDATE documents SET status = 'deleted' WHERE id = $1", [docA2]);
      assert.deepEqual(await flags(db), { 'item-1': true, 'item-2': true });
    });

    test('deleting a registered document flags its item', async () => {
      await db.query('DELETE FROM documents WHERE id = $1', [docA2]);
      assert.deepEqual(await flags(db), { 'item-1': false, 'item-2': true });
    });

    test('an update of an unrelated column leaves the flag false', async () => {
      await db.query("UPDATE documents SET filename = 'renamed.md' WHERE id IN ($1, $2)", [docA1, docA2]);
      assert.deepEqual(await flags(db), { 'item-1': false, 'item-2': false });
    });

    test('a multi-row statement flags exactly the registered documents among its rows', async () => {
      await db.query("UPDATE documents SET status = 'failed' WHERE id IN ($1, $2)", [docA1, docUnregistered]);
      assert.deepEqual(await flags(db), { 'item-1': true, 'item-2': false });
    });

    test('writes on unregistered documents change nothing and raise no error', async () => {
      await db.query("UPDATE documents SET status = 'deleted' WHERE id = $1", [docUnregistered]);
      await db.query('DELETE FROM documents WHERE id = $1', [docUnregistered]);
      assert.deepEqual(await flags(db), { 'item-1': false, 'item-2': false });
    });

    test('clear resets the flag of the given items', async () => {
      await db.query("UPDATE documents SET status = 'deleted' WHERE id IN ($1, $2)", [docA1, docA2]);
      const cleared = await db.query<{ n: number }>('SELECT public.rag_golden_evidence_clear($1, $2, $3::text[]) AS n', [TENANT_A, SET, ['item-1']]);
      assert.equal(cleared.rows[0]!.n, 1);
      assert.deepEqual(await pending(db, TENANT_A), ['item-2']);
    });

    test('an authenticated owner deleting a document through the legacy path still fires the trigger', async () => {
      const deleted = await asRole(db, 'authenticated', USER_A, () => db.query('DELETE FROM documents WHERE id = $1', [docA1]));
      assert.equal(deleted.affectedRows, 1);
      assert.deepEqual(await flags(db), { 'item-1': true, 'item-2': false });
    });

    test('anon and authenticated are refused on the table and every function', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const sql of [
          'SELECT count(*) FROM public.rag_golden_evidence_index',
          `SELECT * FROM public.rag_golden_evidence_register('${TENANT_A}', 'set-1', '[]'::jsonb)`,
          `SELECT * FROM public.rag_golden_evidence_pending('${TENANT_A}', 'set-1')`,
          `SELECT public.rag_golden_evidence_clear('${TENANT_A}', 'set-1', ARRAY['item-1'])`,
          'SELECT public.rag_golden_evidence_on_documents_update()',
          'SELECT public.rag_golden_evidence_on_documents_delete()',
        ]) {
          await assert.rejects(
            () => asRole(db, role, USER_A, () => db.query(sql)),
            (error: unknown) => codeOf(error) === '42501',
            `${role}: ${sql}`,
          );
        }
      }
    });

    if (multi) {
      const TENANT_B = `u:${USER_B}`;

      test("register drops rows whose document belongs to another tenant", async () => {
        const docB = await insertDoc(db, USER_B);
        const result = await register(db, TENANT_A, [
          { item_id: 'item-1', document_id: docA1, quote_sha256: sha('first synthetic quote') },
          { item_id: 'item-b', document_id: docB, quote_sha256: sha('foreign synthetic quote') },
        ]);
        assert.deepEqual(result, { stored: 1, dropped: 1 });
      });

      test('writes on a tenant without index rows change nothing', async () => {
        const docB = await insertDoc(db, USER_B);
        await db.query("UPDATE documents SET status = 'deleted' WHERE id = $1", [docB]);
        await db.query('DELETE FROM documents WHERE id = $1', [docB]);
        assert.deepEqual(await flags(db), { 'item-1': false, 'item-2': false });
        assert.deepEqual(await pending(db, TENANT_B), []);
      });
    }
  });
}
