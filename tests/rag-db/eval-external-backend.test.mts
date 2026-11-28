import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { VectorStore } from '../../src/lib/rag/sync/stores/types.ts';
import { runEval } from '../../eval/harness/run-eval.mts';
import { parseRunConfig, RunConfigError, RUN_CONFIG_REJECT_MESSAGE } from '../../eval/harness/run-config.mts';

// Plan 07-25 (D-06, D-12, D-17): an in-process fixture run that selects an external backend seeds it only through the outbox and the
// drain, reconciles it to ready and answers through resolveRetrievalBackend; the manifest records which implementation it measured.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ITEM_IDS = ['en-general-001', 'en-general-002', 'en-general-003'];
const WRITE_METHODS = new Set(['ensureCollection', 'ensureTenant', 'upsert', 'deleteIds', 'deleteDocument', 'deleteTenant', 'deleteDocuments']);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-external-backend-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function goldenFile(dir: string): string {
  const lines = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && ITEM_IDS.includes((JSON.parse(line) as { id: string }).id));
  assert.ok(lines.length > 0, 'fixture items exist');
  const file = path.join(dir, 'items.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

interface Write {
  method: string;
  viaSync: boolean;
}

/** Records every write method call on the store and whether it came from the drain or the reconcile path. */
function recorder(writes: Write[]): (store: VectorStore) => VectorStore {
  return (store) =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || typeof value !== 'function' || !WRITE_METHODS.has(prop)) {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args: unknown[]) => {
          const stack = new Error().stack ?? '';
          writes.push({ method: prop, viaSync: /sync[\\/](drain|reconcile|purge)\.ts/.test(stack) });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
}

function traces(file: string): Array<{ retrieval_backend?: { backend: string; fallback_reason: string | null } }> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const savedUrl = process.env.QDRANT_URL;

describe('D-17 overlay names', () => {
  test('accepts the D-17 switches no earlier phase allowed', () => {
    const config = parseRunConfig(
      { name: 'd17', env: { RAG_PIPELINE: 'v2', RAG_GROUNDEDNESS: 'true', RAG_INGEST_PIPELINE: 'unified', RAG_EMBEDDING_PROFILES: 'on' }, overrides: null },
      'inline',
    );
    assert.deepEqual(config.env, { RAG_EMBEDDING_PROFILES: 'on', RAG_GROUNDEDNESS: 'true', RAG_INGEST_PIPELINE: 'unified', RAG_PIPELINE: 'v2' });
  });

  test('still rejects an unknown name with the existing error, and a value outside the switch', () => {
    assert.throws(
      () => parseRunConfig({ name: 'unknown', env: { RAG_FOO: 'true' }, overrides: null }, 'inline'),
      (error: unknown) => error instanceof RunConfigError && error.message === RUN_CONFIG_REJECT_MESSAGE,
    );
    assert.throws(() => parseRunConfig({ name: 'bad', env: { RAG_INGEST_PIPELINE: 'other' }, overrides: null }, 'inline'), RunConfigError);
  });
});

describe('external backends in a fixture eval run (fake store)', { skip: savedUrl ? 'QDRANT_URL is set: the real-store suite runs' : false }, () => {
  test('qdrant without QDRANT_URL: fake store, seeded only through the outbox, every trace served by qdrant', async () => {
    const dir = makeTmpDir();
    const writes: Write[] = [];
    const runConfig = parseRunConfig({ name: 'qdrant-fake', env: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }, overrides: { backend: 'qdrant' } }, 'inline');
    const result = await runEval({
      goldenPath: goldenFile(dir),
      corpusDir: CORPUS_DIR,
      outDir: path.join(dir, 'out'),
      deploymentMode: 'multi-tenant',
      runConfig,
      externalBackendTestHooks: { wrapStore: recorder(writes) },
    });
    assert.equal(result.edgeErrors, 0);
    const rows = traces(result.tracesPath);
    assert.ok(rows.length > 0);
    for (const row of rows) assert.deepEqual(row.retrieval_backend && { backend: row.retrieval_backend.backend, fallback_reason: row.retrieval_backend.fallback_reason }, { backend: 'qdrant', fallback_reason: null });
    assert.ok(writes.some((write) => write.method === 'upsert'), 'the store was written');
    assert.deepEqual(writes.filter((write) => !write.viaSync), [], 'no store write outside the outbox and drain path');

    const snapshot = result.manifest.backend_snapshot;
    assert.equal(snapshot?.backend, 'qdrant');
    assert.equal(snapshot?.backend_impl, 'fake');
    assert.equal(snapshot?.hnsw_m, 64);
    assert.equal(snapshot?.hnsw_ef_construction, 200);
    assert.equal(snapshot?.quantization, 'none');
    assert.ok(snapshot?.collection && snapshot.collection.length > 0);
    assert.ok(snapshot?.lexical_mode);
    const manifestText = fs.readFileSync(result.runPath, 'utf8');
    assert.ok(!/api[_-]?key/i.test(manifestText), 'no key reaches the manifest');
  });

  test('backend_not_ready: a stale index state makes every trace fall back, and the regression marks the run invalid', async () => {
    const dir = makeTmpDir();
    const runConfig = parseRunConfig({ name: 'qdrant-stale', env: { RAG_PIPELINE: 'v2' }, overrides: { backend: 'qdrant' } }, 'inline');
    const result = await runEval({
      goldenPath: goldenFile(dir),
      corpusDir: CORPUS_DIR,
      outDir: path.join(dir, 'out'),
      deploymentMode: 'single-tenant',
      runConfig,
      externalBackendTestHooks: { indexStateForTests: 'stale' },
    });
    const rows = traces(result.tracesPath);
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.retrieval_backend?.fallback_reason, 'backend_not_ready');

    const script = [
      'import sys',
      'from pathlib import Path',
      'from rag_eval.traces import load_traces',
      'from rag_eval.regression_rules import RunSummary, run_invalid_reason',
      'fallbacks = {}',
      'for trace in load_traces(Path(sys.argv[1])):',
      '    backend = trace.retrieval_backend',
      '    if backend is not None and backend.fallback_reason is not None:',
      '        fallbacks[backend.fallback_reason] = fallbacks.get(backend.fallback_reason, 0) + 1',
      "print(run_invalid_reason(RunSummary(config_name='qdrant-stale', metrics={}, slices={}, fallbacks=fallbacks, backend='qdrant', backend_impl=sys.argv[2])))",
    ].join('\n');
    const decided = spawnSync('uv', ['run', '--directory', 'eval', 'python', '-c', script, result.tracesPath, String(result.manifest.backend_snapshot?.backend_impl)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(decided.status, 0, decided.stderr);
    assert.equal(decided.stdout.trim(), 'backend_fallback');
  });

  test('a pgvector run records the pgvector snapshot and selects no external backend', async () => {
    const dir = makeTmpDir();
    const runConfig = parseRunConfig({ name: 'pgvector', env: { RAG_PIPELINE: 'v2' }, overrides: null }, 'inline');
    const result = await runEval({
      goldenPath: goldenFile(dir),
      corpusDir: CORPUS_DIR,
      outDir: path.join(dir, 'out'),
      deploymentMode: 'single-tenant',
      runConfig,
    });
    assert.deepEqual(result.manifest.backend_snapshot, {
      backend: 'pgvector',
      backend_impl: 'real',
      collection: null,
      hnsw_m: 64,
      hnsw_ef_construction: 200,
      lexical_mode: 'postgres_fts',
      quantization: 'none',
    });
    for (const row of traces(result.tracesPath)) assert.notEqual(row.retrieval_backend?.backend, 'qdrant');
  });
});

describe('external backends in a fixture eval run (real Qdrant)', { skip: savedUrl ? false : 'QDRANT_URL is not set' }, () => {
  test('with QDRANT_URL the real store and adapter serve the run', async () => {
    const dir = makeTmpDir();
    const runConfig = parseRunConfig({ name: 'qdrant-real', env: { RAG_PIPELINE: 'v2' }, overrides: { backend: 'qdrant' } }, 'inline');
    const result = await runEval({
      goldenPath: goldenFile(dir),
      corpusDir: CORPUS_DIR,
      outDir: path.join(dir, 'out'),
      deploymentMode: 'multi-tenant',
      runConfig,
    });
    assert.equal(result.manifest.backend_snapshot?.backend_impl, 'real');
    for (const row of traces(result.tracesPath)) assert.equal(row.retrieval_backend?.backend, 'qdrant');
  });
});
