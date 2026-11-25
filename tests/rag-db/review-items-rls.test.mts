import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const TABLES = ['rag_review_items', 'rag_domain_experts', 'rag_tenant_feedback_settings'];

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function makeAdmin(db: PGlite, userId: string): Promise<void> {
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [userId]);
}

async function grantExpert(db: PGlite, tenantKey: string, userId: string): Promise<void> {
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2)', [tenantKey, userId]);
}

function fingerprint(): string {
  return crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
}

async function insertItem(db: PGlite, row: Row = {}): Promise<string> {
  const values: Row = {
    tenant_key: 's:default',
    trace_id: crypto.randomUUID(),
    query_masked: 'A synthetic question about the sample topic',
    query_fingerprint: fingerprint(),
    reasons: ['low_score'],
    mining_window: '2026-11-23T00:00:00Z',
    ...row,
  };
  const names = Object.keys(values);
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    names.map((name) => values[name]),
  );
  return (result.rows[0] as { id: string }).id;
}

async function visibleIds(db: PGlite, userId: string): Promise<string[]> {
  return asRole(db, 'authenticated', userId, async () =>
    (await db.query<{ id: string }>('SELECT id FROM rag_review_items ORDER BY id')).rows.map((row) => row.id),
  );
}

async function itemRow(db: PGlite, id: string): Promise<Row> {
  return (await db.query<Row>('SELECT * FROM rag_review_items WHERE id = $1', [id])).rows[0] as Row;
}

function orgKey(): string {
  return `o:${crypto.randomUUID()}`;
}

describe('rag_review_items RLS (multi-tenant, two tenants)', () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let expertA: string;
  let expertB: string;
  let admin: string;
  let plainUser: string;
  let itemsA: string[];
  let itemsB: string[];

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    tenantA = orgKey();
    tenantB = orgKey();
    expertA = await createUser(db);
    expertB = await createUser(db);
    admin = await createUser(db);
    plainUser = await createUser(db);
    await makeAdmin(db, admin);
    await grantExpert(db, tenantA, expertA);
    await grantExpert(db, tenantB, expertB);
    itemsA = [await insertItem(db, { tenant_key: tenantA }), await insertItem(db, { tenant_key: tenantA })].sort();
    itemsB = [await insertItem(db, { tenant_key: tenantB }), await insertItem(db, { tenant_key: tenantB })].sort();
  });

  after(async () => {
    await db.close();
  });

  test("an expert of tenant A sees exactly A's items, and the expert of B exactly B's", async () => {
    assert.deepEqual(await visibleIds(db, expertA), itemsA);
    assert.deepEqual(await visibleIds(db, expertB), itemsB);
  });

  test("reading a B item by id as A's expert returns zero rows", async () => {
    const rows = await asRole(db, 'authenticated', expertA, async () => (await db.query('SELECT id FROM rag_review_items WHERE id = $1', [itemsB[0]])).rows);
    assert.equal(rows.length, 0);
  });

  test("updating a B item by id as A's expert affects zero rows and leaves it unchanged", async () => {
    const result = await asRole(db, 'authenticated', expertA, () =>
      db.query("UPDATE rag_review_items SET status = 'labelled', label = '{\"answerable\": false}'::jsonb WHERE id = $1", [itemsB[0]]),
    );
    assert.equal(result.affectedRows ?? 0, 0);
    const row = await itemRow(db, itemsB[0] as string);
    assert.equal(row.status, 'open');
    assert.equal(row.label, null);
  });

  test('a user with no grant sees nothing', async () => {
    assert.deepEqual(await visibleIds(db, plainUser), []);
  });

  test('an operator admin without a grant sees nothing in multi-tenant mode', async () => {
    assert.deepEqual(await visibleIds(db, admin), []);
  });

  test('an operator admin without a grant does not see an s:default item in multi-tenant mode', async () => {
    const stray = await insertItem(db, { tenant_key: 's:default' });
    try {
      assert.deepEqual(await visibleIds(db, admin), []);
    } finally {
      await db.query('DELETE FROM rag_review_items WHERE id = $1', [stray]);
    }
  });

  test('rag_is_domain_expert answers only for the caller and is not executable by anon', async () => {
    const answers = await asRole(db, 'authenticated', expertA, async () =>
      (await db.query<{ a: boolean; b: boolean }>('SELECT public.rag_is_domain_expert($1) AS a, public.rag_is_domain_expert($2) AS b', [tenantA, tenantB])).rows[0],
    );
    assert.deepEqual(answers, { a: true, b: false });
    await rejectsWith(() => asRole(db, 'anon', null, () => db.query('SELECT public.rag_is_domain_expert($1)', [tenantA])), '42501');
  });

  test('revoking the grant removes visibility', async () => {
    const temporary = await createUser(db);
    await grantExpert(db, tenantA, temporary);
    assert.equal((await visibleIds(db, temporary)).length, 2);
    await db.query('DELETE FROM rag_domain_experts WHERE tenant_key = $1 AND user_id = $2', [tenantA, temporary]);
    assert.deepEqual(await visibleIds(db, temporary), []);
  });
});

describe('rag_review_items RLS (single-tenant)', () => {
  let db: PGlite;
  let admin: string;
  let plainUser: string;
  let item: string;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    admin = await createUser(db);
    plainUser = await createUser(db);
    await makeAdmin(db, admin);
    item = await insertItem(db, { tenant_key: 's:default' });
  });

  after(async () => {
    await db.close();
  });

  test('an admin sees s:default items without a grant row', async () => {
    assert.deepEqual(await visibleIds(db, admin), [item]);
  });

  test('a non-admin authenticated user sees none', async () => {
    assert.deepEqual(await visibleIds(db, plainUser), []);
  });

  test('a non-admin with an explicit grant sees the items', async () => {
    const granted = await createUser(db);
    await grantExpert(db, 's:default', granted);
    assert.deepEqual(await visibleIds(db, granted), [item]);
  });
});

for (const mode of MODES) {
  describe(`rag_review_items columns, labelling and immutability (${mode})`, () => {
    let db: PGlite;
    let tenant: string;
    let expert: string;
    let other: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      tenant = mode === 'single-tenant' ? 's:default' : orgKey();
      expert = await createUser(db);
      other = await createUser(db);
      await grantExpert(db, tenant, expert);
    });

    after(async () => {
      await db.close();
    });

    test('an expert labels an item: label and status labelled succeed and labelled_by becomes the caller', async () => {
      const id = await insertItem(db, { tenant_key: tenant, labelled_by: other });
      const result = await asRole(db, 'authenticated', expert, () =>
        db.query("UPDATE rag_review_items SET status = 'labelled', label = '{\"answerable\": true}'::jsonb, triage = '{golden}', labelled_at = now() WHERE id = $1", [id]),
      );
      assert.equal(result.affectedRows, 1);
      const row = await itemRow(db, id);
      assert.equal(row.status, 'labelled');
      assert.equal(row.labelled_by, expert);
      assert.deepEqual(row.label, { answerable: true });
    });

    test('an expert may skip an item', async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      await asRole(db, 'authenticated', expert, () => db.query("UPDATE rag_review_items SET status = 'skipped' WHERE id = $1", [id]));
      assert.equal((await itemRow(db, id)).status, 'skipped');
    });

    test('an expert cannot set labelled_by directly', async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query('UPDATE rag_review_items SET labelled_by = $2 WHERE id = $1', [id, other])), '42501');
    });

    test('status exported or open from an expert is rejected', async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query("UPDATE rag_review_items SET status = 'exported' WHERE id = $1", [id])), '42501');
      await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query("UPDATE rag_review_items SET label = '{}'::jsonb WHERE id = $1", [id])), '42501');
      assert.equal((await itemRow(db, id)).status, 'open');
    });

    test('an expert cannot change an exported item', async () => {
      const id = await insertItem(db, { tenant_key: tenant, status: 'exported' });
      await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query("UPDATE rag_review_items SET status = 'labelled' WHERE id = $1", [id])), '42501');
      assert.equal((await itemRow(db, id)).status, 'exported');
    });

    test('an expert cannot write split, split_group, tenant_key, query_masked or tags', async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      for (const assignment of ["split = 'dev'", "split_group = 'g1'", "tenant_key = 's:default'", "query_masked = 'x'", "tags = '{representative}'"]) {
        await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query(`UPDATE rag_review_items SET ${assignment} WHERE id = $1`, [id])), '42501');
      }
      const row = await itemRow(db, id);
      assert.equal(row.split, null);
      assert.deepEqual(row.tags, []);
    });

    test('the service role sets split once; afterwards no caller can change split or split_group', async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      await db.query("UPDATE rag_review_items SET split = 'dev', split_group = 'g-1' WHERE id = $1", [id]);
      await asRole(db, 'service_role', null, async () => {
        await rejectsWith(() => db.query("UPDATE rag_review_items SET split = 'test' WHERE id = $1", [id]), '23514');
        await rejectsWith(() => db.query("UPDATE rag_review_items SET split_group = 'g-2' WHERE id = $1", [id]), '23514');
        await rejectsWith(() => db.query('UPDATE rag_review_items SET split = NULL, split_group = NULL WHERE id = $1', [id]), '23514');
      });
      await rejectsWith(() => db.query("UPDATE rag_review_items SET split = 'test' WHERE id = $1", [id]), '23514');
      const row = await itemRow(db, id);
      assert.equal(row.split, 'dev');
      assert.equal(row.split_group, 'g-1');
      await asRole(db, 'service_role', null, () => db.query("UPDATE rag_review_items SET status = 'exported' WHERE id = $1", [id]));
      assert.equal((await itemRow(db, id)).status, 'exported');
    });

    test('split_group set alone also freezes split', async () => {
      const id = await insertItem(db, { tenant_key: tenant, split_group: 'g-only' });
      await rejectsWith(() => db.query("UPDATE rag_review_items SET split = 'dev' WHERE id = $1", [id]), '23514');
    });

    test('anon sees nothing on the three tables, and authenticated cannot read experts or settings', async () => {
      await db.query("INSERT INTO rag_tenant_feedback_settings (tenant_key, retrieval_log) VALUES ($1, 'ids') ON CONFLICT DO NOTHING", [tenant]);
      for (const table of TABLES) {
        await rejectsWith(() => asRole(db, 'anon', null, () => db.query(`SELECT * FROM ${table}`)), '42501');
      }
      for (const table of ['rag_domain_experts', 'rag_tenant_feedback_settings']) {
        await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query(`SELECT * FROM ${table}`)), '42501');
        await rejectsWith(
          () => asRole(db, 'authenticated', expert, () => db.query(`INSERT INTO ${table} (tenant_key, ${table === 'rag_domain_experts' ? 'user_id' : 'retrieval_log'}) VALUES ($1, $2)`, [orgKey(), table === 'rag_domain_experts' ? expert : 'off'])),
          '42501',
        );
      }
    });

    test('authenticated cannot insert or delete review items', async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query("INSERT INTO rag_review_items (tenant_key, query_masked) VALUES ($1, 'q')", [tenant])), '42501');
      await rejectsWith(() => asRole(db, 'authenticated', expert, () => db.query('DELETE FROM rag_review_items WHERE id = $1', [id])), '42501');
    });

    test('unique (tenant_key, query_fingerprint, mining_window) rejects a duplicate', async () => {
      const fp = fingerprint();
      await insertItem(db, { tenant_key: tenant, query_fingerprint: fp });
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, query_fingerprint: fp }), '23505');
      await insertItem(db, { tenant_key: tenant, query_fingerprint: fp, mining_window: '2026-11-30T00:00:00Z' });
    });

    test('tenant_key must match the tenant-key pattern', async () => {
      for (const key of ['tenant-a', 'o:not-a-uuid', 'S:default', '']) {
        await rejectsWith(() => insertItem(db, { tenant_key: key }), '23514');
      }
      await rejectsWith(() => db.query("INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ('x', $1)", [expert]), '23514');
      await rejectsWith(() => db.query("INSERT INTO rag_tenant_feedback_settings (tenant_key, retrieval_log) VALUES ('x', 'off')"), '23514');
      await rejectsWith(() => db.query("INSERT INTO rag_tenant_feedback_settings (tenant_key, retrieval_log) VALUES ($1, 'masked_query')", [orgKey()]), '23514');
    });

    test('status, triage and split accept only their values', async () => {
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, status: 'done' }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, triage: ['golden', 'other'] }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, split: 'train' }), '23514');
      await insertItem(db, { tenant_key: tenant, triage: ['dictionary', 'training', 'golden', 'kb_gap', 'not_a_failure'] });
    });

    test('tags (D-29): default empty, the service role stores a valid tag, and invalid tags are rejected', async () => {
      const plain = await insertItem(db, { tenant_key: tenant });
      assert.deepEqual((await itemRow(db, plain)).tags, []);
      const tagged = await insertItem(db, { tenant_key: tenant, tags: ['representative'] });
      assert.deepEqual((await itemRow(db, tagged)).tags, ['representative']);
      await insertItem(db, { tenant_key: tenant, tags: ['a', 'b_c'] });
      for (const bad of [['Representative'], ['two words'], ['a'.repeat(33)], [''], ['ok', null], ['a,b'], ['a;b']]) {
        await rejectsWith(() => insertItem(db, { tenant_key: tenant, tags: bad }), '23514');
      }
      await rejectsWith(
        () => db.query("INSERT INTO rag_review_items (tenant_key, query_masked, tags) VALUES ($1, 'q', '{{a},{b}}')", [tenant]),
        '23514',
      );
    });

    test('an item with an empty reasons array inserts (not every item is mined)', async () => {
      const id = await insertItem(db, { tenant_key: tenant, reasons: [], query_fingerprint: null, mining_window: null, tags: ['representative'] });
      assert.deepEqual((await itemRow(db, id)).reasons, []);
    });

    test('language snapshot (D-03a): the four columns accept and reject the same values as 0531', async () => {
      const id = await insertItem(db, {
        tenant_key: tenant,
        query_language: 'zh-Hant',
        query_language_confidence: 0.5,
        answer_language: 'en',
        chunk_languages: ['en', 'zh-Hant', 'und'],
      });
      const row = await itemRow(db, id);
      assert.equal(row.query_language, 'zh-Hant');
      assert.deepEqual(row.chunk_languages, ['en', 'zh-Hant', 'und']);
      assert.deepEqual((await itemRow(db, await insertItem(db, { tenant_key: tenant }))).chunk_languages, []);
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, query_language_confidence: 1.5 }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, answer_language: 'This is a sentence.' }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, query_language: 'English' }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, chunk_languages: ['en', null] }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, chunk_languages: ['en,zh'] }), '23514');
    });

    test('candidates must be a JSON array of at most 50 entries', async () => {
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, candidates: JSON.stringify({ a: 1 }) }), '23514');
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, candidates: JSON.stringify(Array.from({ length: 51 }, (_, rank) => ({ rank }))) }), '23514');
    });

    test('deleting a chat as its authenticated owner removes its log rows and review items', async () => {
      const owner = await createUser(db);
      const chatId = crypto.randomUUID();
      await db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 'Fixture chat', '[]'::jsonb)", [chatId, owner]);
      const log = await db.query<{ id: string; tenant_key: string }>(
        "INSERT INTO rag_retrieval_log (trace_id, user_id, chat_id, channel, pipeline, status) VALUES ($1, $2, $3, 'chat', 'legacy', 'ok') RETURNING id, tenant_key",
        [crypto.randomUUID(), owner, chatId],
      );
      const logRow = log.rows[0] as { id: string; tenant_key: string };
      const itemId = await insertItem(db, { tenant_key: logRow.tenant_key, user_id: owner, chat_id: chatId, retrieval_log_id: logRow.id });
      const unrelated = await insertItem(db, { tenant_key: tenant });
      const deleted = await asRole(db, 'authenticated', owner, () => db.query('DELETE FROM chats WHERE id = $1', [chatId]));
      assert.equal(deleted.affectedRows, 1);
      assert.equal((await db.query('SELECT 1 FROM rag_retrieval_log WHERE chat_id = $1', [chatId])).rows.length, 0);
      assert.equal((await db.query('SELECT 1 FROM rag_review_items WHERE id = $1', [itemId])).rows.length, 0);
      assert.equal((await db.query('SELECT 1 FROM rag_review_items WHERE id = $1', [unrelated])).rows.length, 1);
    });

    test('deleting the log row keeps the item with retrieval_log_id null; deleting the user deletes the item', async () => {
      const owner = await createUser(db);
      const log = await db.query<{ id: string; tenant_key: string }>(
        "INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status) VALUES ($1, $2, 'chat', 'legacy', 'ok') RETURNING id, tenant_key",
        [crypto.randomUUID(), owner],
      );
      const logRow = log.rows[0] as { id: string; tenant_key: string };
      const itemId = await insertItem(db, { tenant_key: logRow.tenant_key, user_id: owner, retrieval_log_id: logRow.id });
      await db.query('DELETE FROM rag_retrieval_log WHERE id = $1', [logRow.id]);
      assert.equal((await itemRow(db, itemId)).retrieval_log_id, null);
      await db.query('DELETE FROM auth.users WHERE id = $1', [owner]);
      assert.equal((await db.query('SELECT 1 FROM rag_review_items WHERE id = $1', [itemId])).rows.length, 0);
    });

    test('the chat-delete function stays SECURITY DEFINER with an empty search_path; the helper is STABLE SECURITY DEFINER', async () => {
      const rows = (
        await db.query<{ name: string; prosecdef: boolean; proconfig: string[] | null; provolatile: string }>(
          `SELECT p.proname AS name, p.prosecdef, p.proconfig, p.provolatile FROM pg_proc p
           WHERE p.oid IN ('public.rag_feedback_loop_on_chat_delete()'::regprocedure, 'public.rag_is_domain_expert(text)'::regprocedure)
           ORDER BY p.proname`,
        )
      ).rows;
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.prosecdef, true, row.name);
        assert.deepEqual(row.proconfig, ['search_path=""'], row.name);
      }
      assert.equal(rows.find((row) => row.name === 'rag_is_domain_expert')?.provolatile, 's');
      const trigger = (
        await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
          "SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = 'public.rag_review_items_guard()'::regprocedure",
        )
      ).rows[0];
      assert.equal(trigger?.prosecdef, false);
      assert.deepEqual(trigger?.proconfig, ['search_path=""']);
    });

    test('RLS is enabled on the three tables', async () => {
      const rows = (await db.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`,
        [TABLES],
      )).rows;
      assert.deepEqual(rows.map((row) => [row.relname, row.relrowsecurity]), [...TABLES].sort().map((name) => [name, true]));
    });

    test('0534 is idempotent: applying it again keeps policies, grants and the trigger', async () => {
      await applyMigrationFiles(db, ['supabase/migrations/0534_rag_feedback_review.sql']);
      const policies = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'rag_review_items'")).rows[0]?.n;
      assert.equal(policies, 2);
      const triggers = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.rag_review_items'::regclass AND NOT tgisinternal")).rows[0]?.n;
      assert.equal(triggers, 1);
      const id = await insertItem(db, { tenant_key: tenant });
      await asRole(db, 'authenticated', expert, () => db.query("UPDATE rag_review_items SET status = 'skipped' WHERE id = $1", [id]));
      assert.equal((await itemRow(db, id)).labelled_by, expert);
    });
  });
}
