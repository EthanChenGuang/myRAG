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
const MODES: DeploymentMode[] = ['multi-tenant'];
const HOUR_MS = 3_600_000;
const STALE_MS = 25 * HOUR_MS;

type Row = Record<string, unknown>;

let statusModule: typeof import('@/lib/rag/ingest/status');
let settingsModule: typeof import('@/lib/rag/ingest/routing/settings-snapshot');
let queueModule: typeof import('@/lib/rag/ingest/queue-config');
let routingModule: typeof import('@/lib/rag/ingest/routing/config');
let profilesModule: typeof import('@/lib/rag/ingest/profiles/load');
let depsModule: typeof import('@/lib/rag/ingest/deps');
let scopeModule: typeof import('@/lib/rag/tenant/scope');

async function loadModules(): Promise<void> {
  [statusModule, depsModule, scopeModule, settingsModule, queueModule, routingModule, profilesModule] = await Promise.all([
    import('@/lib/rag/ingest/status'),
    import('@/lib/rag/ingest/deps'),
    import('@/lib/rag/tenant/scope'),
    import('@/lib/rag/ingest/routing/settings-snapshot'),
    import('@/lib/rag/ingest/queue-config'),
    import('@/lib/rag/ingest/routing/config'),
    import('@/lib/rag/ingest/profiles/load'),
  ]);
}

function settingsJson(): string {
  return JSON.stringify(
    settingsModule.buildJobSettings({
      queueConfig: queueModule.loadQueueConfig({}),
      profile: profilesModule.getProcessingProfile('general'),
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig: routingModule.loadRoutingConfig(),
    }),
  );
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = normalizeValue(entry);
    return out;
  }
  return value;
}

function normalizeRow(row: Row | null | undefined): Row | null {
  if (!row) return null;
  return normalizeValue(row) as Row;
}

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
          if (single) return { data: normalizeRow(result.rows[0] ?? null), error: null };
          return { data: result.rows.map((row) => normalizeRow(row) as Row), error: null };
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

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;
}

async function beginDocument(db: PGlite, mode: DeploymentMode, sourceKey: string): Promise<string> {
  const tenant = tenantFor(mode);
  const userId = mode === 'single-tenant' ? null : TWO_TENANT_IDS.userA;
  const row = (
    await db.query<{ document_id: string }>(
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [tenant, userId, null, sourceKey, `${sourceKey}.md`, crypto.randomBytes(16).toString('hex')],
    )
  ).rows[0];
  assert.ok(row?.document_id);
  return row.document_id;
}

async function enqueueForDocument(db: PGlite, tenant: string, documentId: string, status = 'queued'): Promise<string> {
  const sourceKey = `reaper/${crypto.randomUUID()}`;
  const row = (
    await db.query<{ id: string }>(
      `SELECT id FROM rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', $2, NULL, NULL, NULL, NULL, $5::jsonb, 100, $3::uuid, NULL, $4)`,
      [tenant, sourceKey, documentId, status, settingsJson()],
    )
  ).rows[0];
  assert.ok(row?.id);
  return row.id;
}

async function ageDocument(db: PGlite, documentId: string, ageMs: number, nowMs: number): Promise<void> {
  const created = new Date(nowMs - ageMs).toISOString();
  await db.query('UPDATE documents SET created_at = $2 WHERE id = $1', [documentId, created]);
}

for (const mode of MODES) {
  describe(`ingest status reaper vs ledger (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let scope: TenantScope;
    const signal = new AbortController().signal;
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);

    before(async () => {
      await loadModules();
      fixture =
        mode === 'multi-tenant'
          ? await createTwoTenantDatabase()
          : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      await applyMigrations(db, mode);
      scope = scopeFor(mode);
      depsModule.setIngestDepsForTests({ db: () => pgliteRpc(db), now: () => now });
    });

    after(async () => {
      depsModule.resetIngestDepsForTests();
      await fixture.db.close();
    });

    test('skips the reaper when a non-terminal ledger row exists', async () => {
      const documentId = await beginDocument(db, mode, `queued-${crypto.randomUUID()}`);
      await ageDocument(db, documentId, STALE_MS, now);
      const jobId = await enqueueForDocument(db, tenantFor(mode), documentId, 'queued');
      const report = await statusModule.getIngestStatusReport(scope, documentId, { signal });
      assert.ok(report);
      assert.equal(report.view.status, 'processing');
      assert.equal(report.jobStatus, 'queued');
      assert.equal(report.jobId, jobId);
      const row = (await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [documentId])).rows[0];
      assert.equal(row?.status, 'processing');
    });

    test('still reaps inline processing documents without a ledger row', async () => {
      const documentId = await beginDocument(db, mode, `inline-${crypto.randomUUID()}`);
      await ageDocument(db, documentId, STALE_MS, now);
      const report = await statusModule.getIngestStatusReport(scope, documentId, { signal });
      assert.ok(report);
      assert.equal(report.view.status, 'failed');
      assert.equal(report.reason, statusModule.STALE_PROCESSING_REASON);
      assert.equal(report.jobId, undefined);
      const row = (await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [documentId])).rows[0];
      assert.equal(row?.status, 'failed');
    });

    test('reports terminal failed ledger jobs with error_class', async () => {
      const documentId = await beginDocument(db, mode, `failed-${crypto.randomUUID()}`);
      const jobId = await enqueueForDocument(db, tenantFor(mode), documentId, 'queued');
      await db.query(`UPDATE ingestion_jobs SET status = 'failed', error_class = 'parse_failed' WHERE id = $1`, [jobId]);
      const report = await statusModule.getIngestStatusReport(scope, documentId, { signal });
      assert.ok(report);
      assert.equal(report.view.status, 'failed');
      assert.equal(report.reason, 'parse_failed');
      assert.equal(report.jobId, jobId);
      assert.equal(report.jobStatus, 'failed');
    });
  });
}