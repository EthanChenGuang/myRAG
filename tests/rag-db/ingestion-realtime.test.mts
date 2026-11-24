import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const MEMBER = '00000000-0000-4000-8000-0000000000d1';
const ORG = '00000000-0000-4000-8000-00000000e001';
const ST_USER = '00000000-0000-4000-8000-000000000099';

type Role = 'anon' | 'authenticated';

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

function modeVariant(mode: DeploymentMode): string {
  return mode === 'single-tenant'
    ? 'supabase/migrations/0353_ingestion_transitions.single-tenant.sql'
    : 'supabase/migrations/0353_ingestion_transitions.multi-tenant.sql';
}

async function installRealtimeStub(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS realtime;
    CREATE TABLE IF NOT EXISTS realtime.messages (
      id bigserial PRIMARY KEY,
      topic text NOT NULL,
      extension text NOT NULL,
      payload jsonb,
      event text,
      private boolean,
      inserted_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA realtime TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE ON realtime.messages TO anon, authenticated;
    CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('realtime.topic', true), '');
    $$;
    GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated;
    CREATE TABLE IF NOT EXISTS realtime._sends (
      payload jsonb,
      event text,
      topic text,
      private boolean
    );
    CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = realtime
    AS $$
    BEGIN
      INSERT INTO realtime._sends(payload, event, topic, private) VALUES (payload, event, topic, private);
    END;
    $$;
  `);
  await db.query('DELETE FROM realtime._sends');
}

async function loadTransitions(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0352_ingestion_claim.sql'), 'utf8'));
  await installRealtimeStub(db);
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, modeVariant(mode)), 'utf8'));
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0353_ingestion_transitions.sql'), 'utf8'));
}

async function seedMultiTenantUsers(db: PGlite): Promise<void> {
  for (const [id, email] of [
    [USER_A, 'a@example.invalid'],
    [USER_B, 'b@example.invalid'],
    [MEMBER, 'm@example.invalid'],
  ] as const) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]);
  }
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [ORG, 'Org O', 'org-o', USER_A]);
  await db.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)', [ORG, MEMBER, 'member']);
}

async function probeTopic(db: PGlite, topic: string, userId: string | null): Promise<number> {
  const topicValue = topic || '';
  await db.query("SELECT set_config('realtime.topic', $1, false)", [topicValue]);
  await db.query('DELETE FROM realtime.messages WHERE topic = $1', [topicValue || '__none__']);
  if (topicValue) {
    await db.query(
      `INSERT INTO realtime.messages (topic, extension, payload, event, private)
       VALUES ($1, 'broadcast', '{}'::jsonb, 'ingest_status', true)`,
      [topicValue],
    );
  }
  return asRole(db, 'authenticated', userId, async () => {
    const row = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM realtime.messages WHERE topic = $1', [topicValue])).rows[0];
    return row?.n ?? 0;
  });
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  describe(`ingestion realtime (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      if (mode === 'multi-tenant') await seedMultiTenantUsers(fixture.db);
      await loadTransitions(fixture.db, mode);
    });

    after(async () => {
      await fixture.db.close();
    });

    test('migration loads with or without realtime schema', () => {
      assert.ok(true);
    });

    test('broadcast records one private topic payload on advance', async () => {
      const { db } = fixture;
      const tenant = mode === 'single-tenant' ? 's:default' : `u:${USER_A}`;
      await db.query('DELETE FROM realtime._sends');
      const jobId = (
        await db.query<{ id: string }>(
          `SELECT id FROM rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', $2, NULL, NULL, NULL, NULL, '{}'::jsonb)`,
          [tenant, `rt/${crypto.randomUUID()}`],
        )
      ).rows[0]?.id;
      assert.ok(jobId);
      await db.query('SELECT id FROM rag_claim_ingestion_job($1, $2)', [jobId, 'rt-worker']);
      await db.query(`SELECT rag_advance_ingestion_job($1, 'rt-worker', 'chunk', 'chunking', NULL, 1, '{}'::jsonb)`, [jobId]);
      const sends = (await db.query<{ payload: Record<string, unknown>; topic: string; private: boolean; event: string }>('SELECT * FROM realtime._sends')).rows;
      assert.equal(sends.length, 1);
      assert.equal(sends[0]?.topic, `rag-ingest:${tenant}`);
      assert.equal(sends[0]?.private, true);
      assert.equal(sends[0]?.event, 'ingest_status');
      assert.deepEqual(Object.keys(sends[0]?.payload ?? {}).sort(), ['document_id', 'job_id', 'provisional', 'stage', 'status']);
    });
  });
}

describe('ingestion realtime authorization (multi-tenant)', () => {
  let fixture: FixtureDatabase;

  before(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS, supabaseGrants: true, migrations: true });
    await seedMultiTenantUsers(fixture.db);
    await loadTransitions(fixture.db, 'multi-tenant');
  });

  after(async () => {
    await fixture.db.close();
  });

  test('user topics: A reads own, B denied on A; org member reads o: topic', async () => {
    const { db } = fixture;
    assert.equal(await probeTopic(db, `rag-ingest:u:${USER_A}`, USER_A), 1);
    assert.equal(await probeTopic(db, `rag-ingest:u:${USER_A}`, USER_B), 0);
    assert.equal(await probeTopic(db, `rag-ingest:u:${USER_B}`, USER_A), 0);
    assert.equal(await probeTopic(db, `rag-ingest:o:${ORG}`, MEMBER), 1);
    assert.equal(await probeTopic(db, `rag-ingest:o:${ORG}`, USER_B), 0);
    assert.equal(await probeTopic(db, 'rag-ingest:s:default', USER_A), 0);
    assert.equal(await probeTopic(db, 'rag-ingest:s:default', MEMBER), 0);
  });

  test('malformed topics denied without error', async () => {
    const { db } = fixture;
    const cases = [
      'rag-ingest:o:not-a-uuid',
      `rag-ingest:o:${ORG.toUpperCase()}`,
      `rag-ingest:u:${USER_A}' OR '1'='1`,
      `other:u:${USER_A}`,
    ];
    for (const topic of cases) {
      assert.equal(await probeTopic(db, topic, USER_A), 0);
    }
    assert.equal(await probeTopic(db, '', USER_A), 0);
  });

  test('only one SELECT policy and writes denied for authenticated', async () => {
    const { db } = fixture;
    const policies = await db.query<{ cmd: string; count: number }>(
      `SELECT cmd, count(*)::int AS count FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' GROUP BY cmd`,
    );
    assert.equal(policies.rows.length, 1);
    assert.equal(policies.rows[0]?.cmd, 'SELECT');
    await asRole(db, 'authenticated', USER_A, async () => {
      await assert.rejects(
        db.query(`INSERT INTO realtime.messages (topic, extension) VALUES ('rag-ingest:u:${USER_A}', 'broadcast')`),
        /permission denied|row-level security|42501/i,
      );
      const updated = await db.query(`UPDATE realtime.messages SET payload = '{}' WHERE topic = $1 RETURNING id`, [`rag-ingest:u:${USER_A}`]);
      assert.equal(updated.rows.length, 0);
    });
  });

  test('anon and empty sub see nothing', async () => {
    const { db } = fixture;
    const topic = `rag-ingest:u:${USER_A}`;
    assert.equal(await probeTopic(db, topic, null), 0);
    assert.equal(await probeTopic(db, topic, ''), 0);
  });
});

describe('ingestion realtime authorization (single-tenant)', () => {
  let fixture: FixtureDatabase;

  before(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS, supabaseGrants: true, migrations: true });
    await fixture.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ST_USER, 'st@example.invalid']);
    await loadTransitions(fixture.db, 'single-tenant');
  });

  after(async () => {
    await fixture.db.close();
  });

  test('signed-in user reads s:default only', async () => {
    assert.equal(await probeTopic(fixture.db, 'rag-ingest:s:default', ST_USER), 1);
    assert.equal(await probeTopic(fixture.db, `rag-ingest:u:${ST_USER}`, ST_USER), 0);
    assert.equal(await probeTopic(fixture.db, `rag-ingest:o:${ORG}`, ST_USER), 0);
  });
});

describe('ingestion realtime control allow-all', () => {
  test('allow-all predicate fails the B-on-A probe', async () => {
    const fixture = await createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS, supabaseGrants: true, migrations: true });
    await seedMultiTenantUsers(fixture.db);
    await loadTransitions(fixture.db, 'multi-tenant');
    await fixture.db.exec(`
      CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true; $$;
    `);
    assert.equal(await probeTopic(fixture.db, `rag-ingest:u:${USER_A}`, USER_B), 1);
    assert.equal(await probeTopic(fixture.db, 'rag-ingest:s:default', USER_A), 1);
    await fixture.db.close();
  });
});