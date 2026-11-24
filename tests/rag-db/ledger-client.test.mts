import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

Object.assign(process.env, fixtureProcessEnv('http://127.0.0.1:0'));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const M0352 = 'supabase/migrations/0352_ingestion_claim.sql';
const M0353 = 'supabase/migrations/0353_ingestion_transitions.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ADMIN = '00000000-0000-4000-8000-0000000000c1';

type Row = Record<string, unknown>;

type LedgerModule = typeof import('@/lib/rag/ingest/ledger');
type SettingsModule = typeof import('@/lib/rag/ingest/routing/settings-snapshot');
type QueueModule = typeof import('@/lib/rag/ingest/queue-config');
type RoutingModule = typeof import('@/lib/rag/ingest/routing/config');
type ProfilesModule = typeof import('@/lib/rag/ingest/profiles/load');
type ScopeModule = typeof import('@/lib/rag/tenant/scope');

let ledger: LedgerModule;
let settingsModule: SettingsModule;
let queueModule: QueueModule;
let routingModule: RoutingModule;
let profilesModule: ProfilesModule;
let scopeModule: ScopeModule;

async function loadModules(): Promise<void> {
  [ledger, settingsModule, queueModule, routingModule, profilesModule, scopeModule] = await Promise.all([
    import('@/lib/rag/ingest/ledger'),
    import('@/lib/rag/ingest/routing/settings-snapshot'),
    import('@/lib/rag/ingest/queue-config'),
    import('@/lib/rag/ingest/routing/config'),
    import('@/lib/rag/ingest/profiles/load'),
    import('@/lib/rag/tenant/scope'),
  ]);
}

function settingsSnapshot() {
  return settingsModule.buildJobSettings({
    queueConfig: queueModule.loadQueueConfig({}),
    profile: profilesModule.getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: routingModule.loadRoutingConfig(),
  });
}

/** PostgREST answers a non-SETOF composite function with one JSON object (null for no row), not an array. */
async function answersSingleObject(db: PGlite, fn: string): Promise<boolean> {
  const result = await db.query<{ single: boolean }>(
    `SELECT (NOT p.proretset AND t.typtype = 'c') AS single
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       JOIN pg_type t ON t.oid = p.prorettype
      WHERE p.proname = $1`,
    [fn],
  );
  return result.rows.length === 1 && result.rows[0].single === true;
}

function pgliteRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(sql, keys.map((key) => args[key]))
        .then(async (result): Promise<RpcResponse> => {
          const single = await answersSingleObject(db, fn);
          return { data: single ? (result.rows[0] ?? null) : result.rows, error: null };
        })
        .catch((error: unknown): RpcResponse => {
          const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : 'P0001';
          return { data: null, error: { code, message: error instanceof Error ? error.message : String(error) } };
        });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

function modeMigrationSuffix(mode: DeploymentMode): string {
  return mode === 'single-tenant'
    ? 'supabase/migrations/0353_ingestion_transitions.single-tenant.sql'
    : 'supabase/migrations/0353_ingestion_transitions.multi-tenant.sql';
}

async function applyMigrations(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0352), 'utf8'));
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, modeMigrationSuffix(mode)), 'utf8'));
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0353), 'utf8'));
}

function scopeFor(mode: DeploymentMode): TenantScope {
  if (mode === 'single-tenant') return scopeModule.mintScope('single', null, null);
  return scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null);
}

function foreignScope(mode: DeploymentMode): TenantScope {
  if (mode === 'single-tenant') return scopeModule.mintScope('personal', TWO_TENANT_IDS.userB, null);
  return scopeModule.mintScope('single', null, null);
}

function actorFor(mode: DeploymentMode): string {
  return mode === 'multi-tenant' ? TWO_TENANT_IDS.userA : ADMIN;
}

for (const mode of MODES) {
  describe(`ledger client (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let scope: TenantScope;
    const signal = new AbortController().signal;

    before(async () => {
      await loadModules();
      fixture = mode === 'multi-tenant'
        ? await createTwoTenantDatabase()
        : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      await applyMigrations(db);
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ADMIN, 'admin@example.invalid']);
      await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
      if (mode === 'multi-tenant') {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [TWO_TENANT_IDS.userA]);
      }
      scope = scopeFor(mode);
    });

    after(async () => {
      await fixture.db.close();
    });

    test('enqueue and getJobForScope round-trip; foreign scope reads null', async () => {
      const rpc = pgliteRpc(db);
      const sourceKey = `ledger/${crypto.randomUUID()}`;
      const job = await ledger.enqueueJob(
        scope,
        { source: 'config_upload', sourceKey, settings: settingsSnapshot() },
        { signal, deps: { db: () => rpc } },
      );
      assert.equal(job.tenant_key, scopeModule.scopeKey(scope));
      const read = await ledger.getJobForScope(scope, job.id, { signal, deps: { db: () => rpc } });
      assert.equal(read?.id, job.id);
      const foreign = await ledger.getJobForScope(foreignScope(mode), job.id, { signal, deps: { db: () => rpc } });
      assert.equal(foreign, null);
    });

    test('claim via SQL then advance with the ledger client', async () => {
      const rpc = pgliteRpc(db);
      const sourceKey = `advance/${crypto.randomUUID()}`;
      const job = await ledger.enqueueJob(
        scope,
        { source: 'config_upload', sourceKey, settings: settingsSnapshot() },
        { signal, deps: { db: () => rpc } },
      );
      await db.query('SELECT id FROM rag_claim_ingestion_job($1, $2)', [job.id, 'ledger-worker']);
      const advanced = await ledger.advanceJob(
        { jobId: job.id, worker: 'ledger-worker', stage: 'chunk', status: 'chunking', timingMs: 3 },
        { signal, deps: { db: () => rpc } },
      );
      assert.equal(advanced.status, 'chunking');
      assert.equal(advanced.stage, 'chunk');
    });

    test('listJobs, retry and delete round-trip', async () => {
      const rpc = pgliteRpc(db);
      const failedKey = `list-fail/${crypto.randomUUID()}`;
      const failed = await ledger.enqueueJob(
        scope,
        { source: 'config_upload', sourceKey: failedKey, settings: settingsSnapshot() },
        { signal, deps: { db: () => rpc } },
      );
      await db.query(`UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1`, [failed.id]);
      const listed = await ledger.listJobs({ scope, statuses: ['failed'], kind: 'ingest', limit: 20 }, { signal, deps: { db: () => rpc } });
      assert.ok(listed.some((row) => row.id === failed.id));

      const retryKey = `list-retry/${crypto.randomUUID()}`;
      const retryTarget = await ledger.enqueueJob(
        scope,
        { source: 'config_upload', sourceKey: retryKey, settings: settingsSnapshot() },
        { signal, deps: { db: () => rpc } },
      );
      await db.query(`UPDATE ingestion_jobs SET status = 'failed', retries = 3, attempts = '[]'::jsonb WHERE id = $1`, [retryTarget.id]);
      const retried = await ledger.retryJob(retryTarget.id, actorFor(mode), { signal, deps: { db: () => rpc } });
      assert.equal(retried.status, 'queued');
      assert.equal(retried.retries, 0);

      const deleteKey = `list-delete/${crypto.randomUUID()}`;
      const doomed = await ledger.enqueueJob(
        scope,
        { source: 'config_upload', sourceKey: deleteKey, settings: settingsSnapshot() },
        { signal, deps: { db: () => rpc } },
      );
      await db.query(`UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1`, [doomed.id]);
      const deleted = await ledger.deleteJob(doomed.id, actorFor(mode), { signal, deps: { db: () => rpc } });
      assert.ok(deleted.deleted_at);
    });
  });
}