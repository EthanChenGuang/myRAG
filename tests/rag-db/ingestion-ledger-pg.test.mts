import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFiles } from '../../eval/harness/migrations.mts';
import { SUPABASE_GRANTS_SQL, SUPABASE_SHIM_SQL } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function findPgCtl(): string | null {
  const fromPath = spawnSync('which', ['pg_ctl'], { encoding: 'utf8' });
  if (fromPath.status === 0 && fromPath.stdout.trim()) return fromPath.stdout.trim();
  const roots = ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt/postgresql@16/bin'];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) {
        const candidate = path.join(root, entry, 'bin', 'pg_ctl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore missing directories
    }
  }
  return null;
}

function psqlBin(pgCtl: string): string {
  return path.join(path.dirname(pgCtl), 'psql');
}

/** Why the real-Postgres check cannot run here, or null when it can. */
export function realPostgresUnavailable(pgCtl: string | null): string | null {
  if (!pgCtl) return 'pg_ctl not found';
  if (process.getuid?.() === 0) return 'initdb refuses to run as root';
  const pgConfig = path.join(path.dirname(pgCtl), 'pg_config');
  const shareDir = fs.existsSync(pgConfig)
    ? execFileSync(pgConfig, ['--sharedir'], { encoding: 'utf8' }).trim()
    : path.join(path.dirname(path.dirname(pgCtl)), 'share');
  const control = path.join(shareDir, 'extension', 'vector.control');
  if (!fs.existsSync(control)) return 'pgvector extension not installed for this PostgreSQL';
  const version = /default_version\s*=\s*'(\d+)\.(\d+)/.exec(fs.readFileSync(control, 'utf8'));
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
  if (major === 0 && minor < 7) return 'pgvector older than 0.7 (setup SQL needs halfvec)';
  return null;
}

describe('ingestion ledger claim on real PostgreSQL (optional)', () => {
  const pgCtl = findPgCtl();
  const unavailable = realPostgresUnavailable(pgCtl);
  const dataDir = unavailable ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-ingest-claim-'));
  const port = 55432;

  before(() => {
    if (!pgCtl || !dataDir) return;
    execFileSync(pgCtl, ['initdb', '-D', dataDir, '-o', '-A trust'], { stdio: 'pipe' });
    execFileSync(pgCtl, ['start', '-D', dataDir, '-l', path.join(dataDir, 'log'), '-o', `-p ${port}`], { stdio: 'pipe' });
    const psql = psqlBin(pgCtl);
    execFileSync(psql, ['-h', '127.0.0.1', '-p', String(port), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE myrag_claim;'], {
      stdio: 'pipe',
    });
    const sqlFiles = [
      ['shim.sql', SUPABASE_SHIM_SQL],
      ['setup.sql', fs.readFileSync(path.join(REPO_ROOT, 'supabase/single-tenant-setup.sql'), 'utf8')],
      ...migrationFiles('single-tenant')
        .filter((f) => f.includes('0351') || f.includes('0352'))
        .map((f) => [path.basename(f), fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')]),
      ['grants.sql', SUPABASE_GRANTS_SQL],
    ];
    for (const [name, sql] of sqlFiles) {
      const file = path.join(dataDir, `apply-${name}`);
      fs.writeFileSync(file, sql);
      execFileSync(psql, ['-h', '127.0.0.1', '-p', String(port), '-d', 'myrag_claim', '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], { stdio: 'pipe' });
    }
  });

  after(() => {
    if (!pgCtl || !dataDir) return;
    if (!fs.existsSync(path.join(dataDir, 'postmaster.pid'))) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    }
    try {
      execFileSync(pgCtl, ['stop', '-D', dataDir, '-m', 'immediate'], { stdio: 'pipe' });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('600 jobs claimed once across 8 concurrent sessions when pg_ctl is available', { skip: unavailable ?? false, timeout: 180_000 }, async () => {
    const psql = psqlBin(pgCtl!);
    for (let i = 0; i < 600; i++) {
      execFileSync(
        psql,
        [
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-d',
          'myrag_claim',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `SELECT rag_enqueue_ingestion_job('s:default', 'ingest', 'config_upload', 'bulk-${i}', NULL, NULL, NULL, NULL, '{}'::jsonb, 100, NULL, NULL, 'queued');`,
        ],
        { stdio: 'pipe' },
      );
    }
    const workers = Array.from({ length: 8 }, (_, w) =>
      execFileSync(
        psql,
        [
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-d',
          'myrag_claim',
          '-v',
          'ON_ERROR_STOP=1',
          '-t',
          '-A',
          '-c',
          `WITH RECURSIVE claim_loop AS (
             SELECT id FROM rag_claim_ingestion_jobs('pg-worker-${w}', 50, true, 'worker') LIMIT 1
             UNION ALL
             SELECT c.id FROM claim_loop prev
             JOIN LATERAL (SELECT id FROM rag_claim_ingestion_jobs('pg-worker-${w}', 1, true, 'worker') LIMIT 1) c ON true
             WHERE c.id IS NOT NULL
           )
           SELECT string_agg(id::text, ',') FROM (SELECT DISTINCT id FROM claim_loop WHERE id IS NOT NULL) s;`,
        ],
        { encoding: 'utf8' },
      ),
    );
    const claimed = new Set<string>();
    for (const out of workers) {
      for (const id of out.stdout.trim().split(',').filter(Boolean)) {
        assert.ok(!claimed.has(id), `duplicate claim ${id}`);
        claimed.add(id);
      }
    }
    assert.equal(claimed.size, 600);
  });

  test('skips cleanly when pg_ctl is missing', () => {
    assert.equal(realPostgresUnavailable(null), 'pg_ctl not found');
    if (!pgCtl) assert.equal(findPgCtl(), null);
  });
});