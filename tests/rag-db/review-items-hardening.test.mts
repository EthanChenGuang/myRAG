import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

// 0990: review-queue hardening after the Phase 5.1.1 verification (G5, G6, G8, G9). Sampled items follow their user and chat on
// delete; re-running 0944 or 0950 after 0984 leaves one rag_enqueue_review_item; while access is enforced a NULL access_sets row is
// hidden from experts who do not administer the tenant and sourceless writes store '[]'; every rag_review_items writer in the catalog
// sets access_sets. Neutral synthetic data only.

type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0990_review_items_hardening.sql';
const GRANTS_MIGRATION = 'supabase/migrations/0410_security_definer_rpc_grants.sql';
const WINDOW = '2026-11-23T00:00:00Z';
const OWNER = '00000000-0000-4000-8000-00000000e2a0';
const MEMBER = '00000000-0000-4000-8000-00000000e2a1';
const OUTSIDER = '00000000-0000-4000-8000-00000000e2a2';
const ORG = '00000000-0000-4000-8000-00000000e2f1';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

// Writers that insert into rag_review_items without access_sets on purpose. Each entry states why its rows may stay NULL.
const SOURCELESS_WRITERS: Record<string, string> = {
  rag_red_team_open_cases:
    'Phase 7 red-team cases carry a synthetic question and no document or retrieval log source; under 0990 a NULL row is hidden from experts who do not administer the tenant while access is enforced (fail closed).',
};

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asUser<T = Row>(db: PGlite, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await tx.exec('SET LOCAL ROLE authenticated');
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function asService<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return (await tx.query<T>(sql, params)).rows;
  });
}

function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readMigration(relpath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf8');
}

async function setEnforced(db: PGlite, enforced: boolean): Promise<void> {
  await db.query('UPDATE public.rag_access_group_settings SET enforced = $1 WHERE id', [enforced]);
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantKey = multi ? `o:${ORG}` : 's:default';

  describe(`review items hardening 0990 (${mode})`, () => {
    let db: PGlite;
    let counter = 0;

    function question(): { query_masked: string; query_fingerprint: string } {
      counter += 1;
      const text = `Synthetic hardening question ${counter} about the sample topic`;
      return { query_masked: text, query_fingerprint: fingerprintOf(text) };
    }

    function queueRow(extra: Row = {}): Row {
      return { ...question(), language: 'en', mining_window: WINDOW, reasons: ['representative'], stratum: 'c1|en|chat', sampling_weight: 1, ...extra };
    }

    async function createUser(): Promise<string> {
      const id = crypto.randomUUID();
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(-4)}@example.invalid`]);
      if (multi) {
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [ORG, id]);
      }
      return id;
    }

    async function createChat(userId: string): Promise<string> {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO chats (id, user_id, organization_id, title, messages) VALUES ($1, $2, $3, 'Fixture chat', '[]'::jsonb)", [
        id,
        userId,
        multi ? ORG : null,
      ]);
      return id;
    }

    async function insertLog(fields: Row): Promise<string> {
      const values: Row = {
        trace_id: crypto.randomUUID(),
        user_id: OWNER,
        organization_id: multi ? ORG : null,
        channel: 'chat',
        pipeline: 'legacy',
        status: 'ok',
        outcome: 'answered',
        candidate_count: 0,
        top_score: 0.5,
        created_at: '2026-11-20T12:00:00Z',
        ...question(),
        ...fields,
      };
      const names = Object.keys(values);
      const inserted = await rows<{ id: string }>(
        db,
        `INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        names.map((name) => values[name]),
      );
      return inserted[0]!.id;
    }

    async function enqueue(row: Row): Promise<string> {
      const n = await asService<{ n: number }>(db, 'SELECT public.rag_review_items_enqueue($1, $2, $3::jsonb) AS n', [tenantKey, 'representative', JSON.stringify([row])]);
      assert.equal(n[0]!.n, 1);
      return (await rows<{ id: string }>(db, 'SELECT id FROM rag_review_items WHERE query_fingerprint = $1', [row.query_fingerprint]))[0]!.id;
    }

    async function itemExists(id: string): Promise<boolean> {
      return (await rows(db, 'SELECT 1 FROM rag_review_items WHERE id = $1', [id])).length === 1;
    }

    async function setsOf(id: string): Promise<unknown> {
      return (await rows<{ access_sets: unknown }>(db, 'SELECT access_sets FROM rag_review_items WHERE id = $1', [id]))[0]?.access_sets;
    }

    async function visibleTo(userId: string, id: string): Promise<boolean> {
      return (await asUser(db, userId, 'SELECT id FROM public.rag_review_items WHERE id = $1', [id])).length === 1;
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      for (const id of [OWNER, MEMBER, OUTSIDER]) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, `user-${id.slice(-4)}@example.invalid`]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'review-hardening', $2, false)", [ORG, OWNER]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member') ON CONFLICT DO NOTHING",
          [ORG, OWNER, MEMBER, OUTSIDER],
        );
      } else {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
      }
      await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($1, $3), ($1, $4) ON CONFLICT DO NOTHING', [tenantKey, MEMBER, OUTSIDER, OWNER]);
    });

    beforeEach(async () => {
      await db.query('DELETE FROM rag_review_items');
      await db.query('DELETE FROM rag_retrieval_log');
      await setEnforced(db, false);
    });

    after(async () => {
      await db?.close();
    });

    describe('G5: sampled items follow their user and chat on delete', () => {
      test('a sampled item copies user_id and chat_id from its retrieval log row', async () => {
        const user = await createUser();
        const chat = await createChat(user);
        const logId = await insertLog({ user_id: user, chat_id: chat });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        const [item] = await rows<{ user_id: string | null; chat_id: string | null }>(db, 'SELECT user_id, chat_id FROM rag_review_items WHERE id = $1', [id]);
        assert.deepEqual(item, { user_id: user, chat_id: chat });
      });

      test('deleting the chat removes the sampled item', async () => {
        const user = await createUser();
        const chat = await createChat(user);
        const logId = await insertLog({ user_id: user, chat_id: chat });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        await db.query('DELETE FROM chats WHERE id = $1', [chat]);
        assert.equal(await itemExists(id), false);
      });

      test('deleting the user removes the sampled item', async () => {
        const user = await createUser();
        const logId = await insertLog({ user_id: user });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        await db.query('DELETE FROM auth.users WHERE id = $1', [user]);
        assert.equal(await itemExists(id), false);
      });

      test('the log retention purge keeps the sampled item (its snapshot outlives the log row)', async () => {
        const user = await createUser();
        const logId = await insertLog({ user_id: user });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        await db.query('DELETE FROM rag_retrieval_log WHERE id = $1', [logId]);
        assert.equal(await itemExists(id), true);
      });

      test('re-applying 0990 backfills user_id and chat_id of existing sampled items', async () => {
        const user = await createUser();
        const chat = await createChat(user);
        const logId = await insertLog({ user_id: user, chat_id: chat });
        const id = await enqueue(queueRow({ retrieval_log_id: logId }));
        await db.query('ALTER TABLE rag_review_items DISABLE TRIGGER USER');
        await db.query('UPDATE rag_review_items SET user_id = NULL, chat_id = NULL WHERE id = $1', [id]);
        await db.query('ALTER TABLE rag_review_items ENABLE TRIGGER USER');
        await db.exec(readMigration(MIGRATION));
        const [item] = await rows<{ user_id: string | null; chat_id: string | null }>(db, 'SELECT user_id, chat_id FROM rag_review_items WHERE id = $1', [id]);
        assert.deepEqual(item, { user_id: user, chat_id: chat });
      });
    });

    describe('G6: re-running 0944 or 0950 after 0984 keeps one rag_enqueue_review_item', () => {
      after(async () => {
        for (const file of [
          'supabase/migrations/0984_review_items_access_sets.sql',
          'supabase/migrations/0988_review_items_writers_access_sets.sql',
          MIGRATION,
          GRANTS_MIGRATION,
        ]) {
          await db.exec(readMigration(file));
        }
      });
      for (const file of ['supabase/migrations/0944_rag_review_reasons_phase52.sql', 'supabase/migrations/0950_calc_review_reasons.sql']) {
        test(`re-running ${path.basename(file)} does not bring back the four-argument overload`, async () => {
          await db.exec(readMigration(file));
          const overloads = await rows<{ args: string }>(
            db,
            "SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_enqueue_review_item'",
          );
          assert.equal(overloads.length, 1, JSON.stringify(overloads));
          let code = '';
          try {
            await asService(db, "SELECT public.rag_enqueue_review_item($1, 'output_guard', $2::jsonb, $3::jsonb)", [tenantKey, '{}', '{}']);
          } catch (error) {
            code = String((error as { code?: unknown }).code ?? '');
          }
          assert.notEqual(code, '42725', 'a four-argument call must resolve to one function');
          assert.equal(code, '22023', 'the call reaches the five-argument body, which refuses an empty source');
        });
      }
    });

    describe('G8: NULL access_sets fail closed while access is enforced', () => {
      test('an item written with access off is hidden from non-admin experts once enforcement is on, and still visible to the tenant admin', async () => {
        const id = await enqueue(queueRow());
        assert.equal(await setsOf(id), null);
        assert.equal(await visibleTo(OUTSIDER, id), true);
        await setEnforced(db, true);
        assert.equal(await visibleTo(OUTSIDER, id), false);
        assert.equal(await visibleTo(MEMBER, id), false);
        assert.equal(await visibleTo(OWNER, id), true);
      });

      test("a sourceless item written while access is enforced stores '[]' and every expert of the tenant sees it", async () => {
        await setEnforced(db, true);
        const id = await enqueue(queueRow());
        assert.deepEqual(await setsOf(id), []);
        assert.equal(await visibleTo(OUTSIDER, id), true);
        assert.equal(await visibleTo(MEMBER, id), true);
      });

      test('with access off nothing changes: NULL is stored and every expert sees the item', async () => {
        const id = await enqueue(queueRow());
        assert.equal(await setsOf(id), null);
        for (const user of [OUTSIDER, MEMBER, OWNER]) assert.equal(await visibleTo(user, id), true);
      });
    });

    describe('G9: catalog guard over rag_review_items writers', () => {
      test('every function that inserts into rag_review_items sets access_sets, or is an allow-listed sourceless writer', async () => {
        const writers = await rows<{ name: string; body: string }>(
          db,
          "SELECT p.proname AS name, p.prosrc AS body FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\\s+into\\s+(public\\.)?rag_review_items\\M'",
        );
        assert.ok(writers.length >= 4, `expected the known writers, found ${writers.map((w) => w.name).join(', ')}`);
        const missing: string[] = [];
        for (const writer of writers) {
          const inserts = [...writer.body.matchAll(/insert\s+into\s+(?:public\.)?rag_review_items\b[^(]*\(([^)]*)\)/gi)];
          const lacking = inserts.some((match) => !/\baccess_sets\b/i.test(match[1] ?? ''));
          if (lacking && !(writer.name in SOURCELESS_WRITERS)) missing.push(writer.name);
        }
        assert.deepEqual(missing, []);
        for (const name of Object.keys(SOURCELESS_WRITERS)) {
          assert.ok(SOURCELESS_WRITERS[name]!.length > 20, `allow-list entry ${name} states its reason`);
        }
      });
    });

    describe('grants and re-apply', () => {
      test('0990 then 0410 re-apply cleanly, and no rag function is client-callable', async () => {
        await db.exec(readMigration(MIGRATION));
        await db.exec(readMigration(MIGRATION));
        await db.exec(readMigration(GRANTS_MIGRATION));
        await assertNoClientCallableRagFunctions(db);
        const [fn] = await rows<{ config: string[] | null; anon: boolean; authenticated: boolean; service: boolean }>(
          db,
          "SELECT p.proconfig AS config, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service FROM pg_catalog.pg_proc p WHERE p.oid = 'public.rag_review_items_fill_owner()'::regprocedure",
        );
        assert.deepEqual(fn, { config: ['search_path=""'], anon: false, authenticated: false, service: true });
      });
    });
  });
}
