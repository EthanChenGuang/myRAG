import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { VectorStore } from '../../src/lib/rag/sync/stores/types.ts';
import { parseRunConfig, RunConfigError, RUN_CONFIG_REJECT_MESSAGE } from '../../eval/harness/run-config.mts';

// Plan 07-25 (D-06, D-12, D-17): an in-process fixture run that selects an external backend seeds it only through the outbox and the
// drain, reconciles it to ready and answers through resolveRetrievalBackend; the manifest records which implementation it measured.
// The app modules keep the first fixture edge's clients for the life of a process, so each eval run below runs in a child process of
// this same file (EVAL_EXTERNAL_SCENARIO selects it).

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ITEM_IDS = ['en-general-001', 'en-general-002', 'en-general-003'];
const WRITE_METHODS = new Set(['ensureCollection', 'ensureTenant', 'upsert', 'deleteIds', 'deleteDocument', 'deleteTenant', 'deleteDocuments']);
const RESULT_PREFIX = 'SCENARIO_RESULT ';

type ScenarioName = 'qdrant-fake' | 'qdrant-stale' | 'pgvector' | 'qdrant-real';

interface Write {
  method: string;
  viaSync: boolean;
}

interface ScenarioResult {
  tracesPath: string;
  runPath: string;
  edgeErrors: number;
  backends: Array<{ backend: string; fallback_reason: string | null } | null>;
  writes: Write[];
  snapshot: Record<string, unknown> | null;
}

/** Records every write method call on the store and whether it came from the drain, reconcile or purge path. */
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

function goldenFile(dir: string): string {
  const lines = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && ITEM_IDS.includes((JSON.parse(line) as { id: string }).id));
  if (lines.length === 0) throw new Error('fixture items missing');
  const file = path.join(dir, 'items.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function runScenario(name: ScenarioName, dir: string): Promise<ScenarioResult> {
  const { runEval } = await import('../../eval/harness/run-eval.mts');
  const writes: Write[] = [];
  const external = name !== 'pgvector';
  const runConfig = parseRunConfig(
    { name, env: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }, overrides: external ? { backend: 'qdrant' } : null },
    'inline',
  );
  const result = await runEval({
    goldenPath: goldenFile(dir),
    corpusDir: CORPUS_DIR,
    outDir: path.join(dir, 'out'),
    deploymentMode: 'multi-tenant',
    runConfig,
    ...(external
      ? { externalBackendTestHooks: { wrapStore: recorder(writes), ...(name === 'qdrant-stale' ? { indexStateForTests: 'stale' as const } : {}) } }
      : {}),
  });
  const backends = fs
    .readFileSync(result.tracesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const backend = (JSON.parse(line) as { retrieval_backend?: { backend: string; fallback_reason?: string | null } }).retrieval_backend;
      return backend ? { backend: backend.backend, fallback_reason: backend.fallback_reason ?? null } : null;
    });
  return {
    tracesPath: result.tracesPath,
    runPath: result.runPath,
    edgeErrors: result.edgeErrors,
    backends,
    writes,
    snapshot: (result.manifest.backend_snapshot as Record<string, unknown> | undefined) ?? null,
  };
}

const CHILD = process.env.EVAL_EXTERNAL_SCENARIO as ScenarioName | undefined;

if (CHILD) {
  const result = await runScenario(CHILD, process.env.EVAL_EXTERNAL_DIR as string);
  process.stdout.write(`\n${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  process.exit(0);
}

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function scenario(name: ScenarioName): ScenarioResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-external-backend-'));
  tmpDirs.push(dir);
  const child = spawnSync(process.execPath, ['--import', 'tsx', THIS_FILE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, EVAL_EXTERNAL_SCENARIO: name, EVAL_EXTERNAL_DIR: dir },
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (child.stdout ?? '').split('\n').find((entry) => entry.startsWith(RESULT_PREFIX));
  assert.ok(line, `scenario ${name} failed (exit ${child.status}): ${(child.stderr ?? '').slice(-2000)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as ScenarioResult;
}

const realQdrant = (process.env.QDRANT_URL ?? '').trim() !== '';

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

describe('external backends in a fixture eval run (fake store)', { skip: realQdrant ? 'QDRANT_URL is set: the real-store suite runs' : false }, () => {
  test('qdrant without QDRANT_URL: fake store, seeded only through the outbox, every trace served by qdrant', () => {
    const result = scenario('qdrant-fake');
    assert.equal(result.edgeErrors, 0);
    assert.ok(result.backends.length > 0);
    for (const backend of result.backends) assert.deepEqual(backend, { backend: 'qdrant', fallback_reason: null });
    assert.ok(result.writes.some((write) => write.method === 'upsert'), 'the store was written');
    assert.deepEqual(result.writes.filter((write) => !write.viaSync), [], 'no store write outside the outbox and drain path');

    const snapshot = result.snapshot;
    assert.equal(snapshot?.backend, 'qdrant');
    assert.equal(snapshot?.backend_impl, 'fake');
    assert.equal(snapshot?.hnsw_m, 64);
    assert.equal(snapshot?.hnsw_ef_construction, 200);
    assert.equal(snapshot?.quantization, 'none');
    assert.ok(typeof snapshot?.collection === 'string' && snapshot.collection.length > 0);
    assert.ok(typeof snapshot?.lexical_mode === 'string' && snapshot.lexical_mode.length > 0);
    assert.ok(!/api[_-]?key/i.test(fs.readFileSync(result.runPath, 'utf8')), 'no key reaches the manifest');
  });

  test('backend_not_ready: a stale index state makes every trace fall back, and the regression marks the run invalid', () => {
    const result = scenario('qdrant-stale');
    assert.ok(result.backends.length > 0);
    for (const backend of result.backends) assert.equal(backend?.fallback_reason, 'backend_not_ready');

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
    const decided = spawnSync('uv', ['run', '--directory', 'eval', 'python', '-c', script, result.tracesPath, String(result.snapshot?.backend_impl)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(decided.status, 0, decided.stderr);
    assert.equal(decided.stdout.trim().split('\n').at(-1), 'backend_fallback');
  });

  test('a pgvector run records the pgvector snapshot and selects no external backend', () => {
    const result = scenario('pgvector');
    assert.deepEqual(result.snapshot, {
      backend: 'pgvector',
      backend_impl: 'real',
      collection: null,
      hnsw_m: 64,
      hnsw_ef_construction: 200,
      lexical_mode: 'postgres_fts',
      quantization: 'none',
    });
    assert.deepEqual(result.writes, []);
    for (const backend of result.backends) assert.notEqual(backend?.backend, 'qdrant');
  });
});

describe('external backends in a fixture eval run (real Qdrant)', { skip: realQdrant ? false : 'QDRANT_URL is not set' }, () => {
  test('with QDRANT_URL the real store and adapter serve the run', () => {
    const result = scenario('qdrant-real');
    assert.equal(result.snapshot?.backend_impl, 'real');
    for (const backend of result.backends) assert.equal(backend?.backend, 'qdrant');
  });
});
