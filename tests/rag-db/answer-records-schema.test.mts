import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { migrationFiles } from '../../eval/harness/migrations.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ANSWER_RECORD_MIGRATION = /^supabase\/migrations\/050[12]_rag_answer_records/;

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code || (error instanceof Error && error.message.includes(code)));
}

async function hasColumn(db: PGlite, table: string, column: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present",
    [table, column],
  );
  return result.rows[0]?.present === true;
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createOrganization(db: PGlite, ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Fixture org', `fixture-${id.slice(0, 8)}`, ownerId]);
  return id;
}

async function createChat(db: PGlite, userId: string, organizationId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO chats (id, user_id, organization_id, title, messages) VALUES ($1, $2, $3, 'Fixture chat', '[]'::jsonb)", [id, userId, organizationId]);
  return id;
}

async function createDocument(db: PGlite, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  const withUser = await hasColumn(db, 'documents', 'user_id');
  await db.query(
    withUser
      ? "INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'fixture.txt', 'fixture body', $2)"
      : "INSERT INTO documents (id, filename, content) VALUES ($1, 'fixture.txt', 'fixture body')",
    withUser ? [id, userId] : [id],
  );
  return id;
}

interface RecordInput {
  userId: string;
  organizationId?: string | null;
  chatId?: string | null;
  extra?: Record<string, unknown>;
}

async function insertRecord(db: PGlite, input: RecordInput): Promise<string> {
  const id = crypto.randomUUID();
  const values: Record<string, unknown> = {
    id,
    user_id: input.userId,
    organization_id: input.organizationId ?? null,
    chat_id: input.chatId ?? null,
    rag_mode: 'strict',
    ...input.extra,
  };
  const columns = Object.entries(values);
  await db.query(
    `INSERT INTO rag_answer_records (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    columns.map(([, value]) => value),
  );
  return id;
}

async function recordCatalog(db: PGlite): Promise<Record<string, string[]>> {
  const sorted = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows.map((row) => JSON.stringify(row)).sort();
  return {
    columns: await sorted(
      `SELECT column_name, data_type, is_nullable, column_default, is_generated, generation_expression
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_answer_records'`,
    ),
    constraints: await sorted(
      "SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.rag_answer_records'::regclass",
    ),
    indexes: await sorted("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rag_answer_records'"),
    policies: await sorted("SELECT policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE tablename = 'rag_answer_records'"),
  };
}

for (const mode of MODES) {
  describe(`rag_answer_records schema (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db.close();
    });

    test('a minimal row takes the column defaults', async () => {
      const userId = await createUser(db);
      const id = await insertRecord(db, { userId });
      const row = (
        await db.query<{
          citations: unknown;
          groundedness: unknown;
          feedback: unknown;
          review_reasons: string[];
          invalid_citations: number;
          same_time: boolean;
          chat_id: string | null;
        }>(
          `SELECT citations, groundedness, feedback, review_reasons, invalid_citations, created_at = updated_at AS same_time, chat_id
           FROM rag_answer_records WHERE id = $1`,
          [id],
        )
      ).rows[0];
      assert.ok(row);
      assert.deepEqual(row.citations, []);
      assert.deepEqual(row.groundedness, {});
      assert.equal(row.feedback, null);
      assert.deepEqual(row.review_reasons, []);
      assert.equal(row.invalid_citations, 0);
      assert.equal(row.same_time, true);
      assert.equal(row.chat_id, null);
    });

    test('id has no default: the app mints the answerId', async () => {
      const userId = await createUser(db);
      await rejectsWith(() => db.query("INSERT INTO rag_answer_records (user_id, rag_mode) VALUES ($1, 'strict')", [userId]), '23502');
    });

    test('tenant_key is generated from the row and cannot be written', async () => {
      const userId = await createUser(db);
      const personal = await insertRecord(db, { userId });
      const key = async (id: string) =>
        (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM rag_answer_records WHERE id = $1', [id])).rows[0]?.tenant_key;
      if (mode === 'single-tenant') {
        assert.equal(await key(personal), 's:default');
      } else {
        assert.equal(await key(personal), `u:${userId}`);
        const organizationId = await createOrganization(db, userId);
        const shared = await insertRecord(db, { userId, organizationId });
        assert.equal(await key(shared), `o:${organizationId}`);
      }
      await assert.rejects(() =>
        db.query("INSERT INTO rag_answer_records (id, user_id, rag_mode, tenant_key) VALUES ($1, $2, 'strict', 's:default')", [crypto.randomUUID(), userId]),
      );
      await assert.rejects(() => db.query("UPDATE rag_answer_records SET tenant_key = 'u:forged' WHERE id = $1", [personal]));
    });

    test('check constraints refuse values outside the contract with 23514', async () => {
      const userId = await createUser(db);
      await rejectsWith(() => insertRecord(db, { userId, extra: { citation_strategy: 'other' } }), '23514');
      await rejectsWith(() => insertRecord(db, { userId, extra: { rag_mode: 'loose' } }), '23514');
      await rejectsWith(() => insertRecord(db, { userId, extra: { review_reasons: ['spam'] } }), '23514');
      await rejectsWith(() => insertRecord(db, { userId, extra: { invalid_citations: -1 } }), '23514');
      for (const strategy of ['claude-citations', 'chunk-alias', null]) {
        await insertRecord(db, { userId, extra: { citation_strategy: strategy } });
      }
      for (const ragMode of ['strict', 'balanced', 'flexible', 'bypass']) {
        await insertRecord(db, { userId, extra: { rag_mode: ragMode } });
      }
      await insertRecord(db, { userId, extra: { review_reasons: ['feedback_negative', 'groundedness_flagged'] } });
    });

    test('deleting the chat deletes its records', async () => {
      const userId = await createUser(db);
      const chatId = await createChat(db, userId);
      const id = await insertRecord(db, { userId, chatId });
      await db.query('DELETE FROM chats WHERE id = $1', [chatId]);
      const left = await db.query('SELECT 1 FROM rag_answer_records WHERE id = $1', [id]);
      assert.equal(left.rows.length, 0);
    });

    test('deleting a document leaves every record unchanged and no column references documents or chunks', async () => {
      const userId = await createUser(db);
      const documentId = await createDocument(db, userId);
      const citations = JSON.stringify([{ documentId, chunkId: crypto.randomUUID(), quote: 'fixture body' }]);
      const id = await insertRecord(db, { userId, extra: { citations } });
      const before = await db.query('SELECT * FROM rag_answer_records ORDER BY id');
      await db.query('DELETE FROM documents WHERE id = $1', [documentId]);
      const after = await db.query('SELECT * FROM rag_answer_records ORDER BY id');
      assert.deepEqual(after.rows, before.rows);
      assert.ok(after.rows.some((row) => (row as { id: string }).id === id));
      const references = await db.query<{ target: string }>(
        "SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid = 'public.rag_answer_records'::regclass AND contype = 'f'",
      );
      const targets = references.rows.map((row) => row.target).sort();
      assert.ok(!targets.some((target) => /document/.test(target)), `foreign keys: ${targets.join(', ')}`);
      assert.ok(targets.includes('chats'));
      assert.ok(targets.includes('auth.users'));
      if (mode === 'multi-tenant') assert.ok(targets.includes('organizations'));
    });

    test('the record indexes exist', async () => {
      const indexes = (await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'rag_answer_records'")).rows.map(
        (row) => row.indexdef,
      );
      assert.ok(indexes.some((def) => /\(chat_id\)/.test(def)));
      assert.ok(indexes.some((def) => /\(user_id, created_at\)/.test(def)));
      assert.ok(indexes.some((def) => /\(tenant_key, created_at\)/.test(def)));
    });

    test('applying 0501 and 0502 a second time leaves the catalog unchanged', async () => {
      const files = migrationFiles(mode).filter((file) => ANSWER_RECORD_MIGRATION.test(file));
      assert.equal(files.length, 2, `answer-record migrations for ${mode}: ${files.join(', ')}`);
      const once = await recordCatalog(db);
      for (const file of files) await db.exec(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      assert.deepEqual(await recordCatalog(db), once);
    });
  });
}
