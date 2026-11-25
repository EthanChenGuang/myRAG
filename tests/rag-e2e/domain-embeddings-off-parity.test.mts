import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Plan 03.1.1-14 (D-25): RAG_DOMAIN_EMBEDDINGS off, and on with no binding row, reproduce today's smoke runs. Each arm runs in its own
// process (tests/rag-e2e/domain-parity-arm.mts) because the app reads part of its environment at import time.

const REPO_ROOT = process.cwd();
const BASELINES = { prechunked: 'eval/baselines/fixture-baseline.json', ingest: 'eval/baselines/fixture-ingest-baseline.json' } as const;
const DOMAIN_ON = { RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' } as const;
const DOMAIN_MODELS = ['voyage-law-2', 'voyage-finance-2'];

type FixtureMode = keyof typeof BASELINES;
interface Arm {
  name: string;
  mode: FixtureMode;
  env: Record<string, string>;
}

const ARMS: Arm[] = [
  { name: 'prechunked-off', mode: 'prechunked', env: {} },
  { name: 'prechunked-on', mode: 'prechunked', env: { ...DOMAIN_ON } },
  // Without embedding profiles the config loader forces the switch off.
  { name: 'prechunked-domain-only', mode: 'prechunked', env: { RAG_DOMAIN_EMBEDDINGS: 'on' } },
  { name: 'ingest-off', mode: 'ingest', env: {} },
  { name: 'ingest-on', mode: 'ingest', env: { ...DOMAIN_ON } },
  { name: 'v2-off', mode: 'prechunked', env: { RAG_PIPELINE: 'v2' } },
  { name: 'v2-on', mode: 'prechunked', env: { RAG_PIPELINE: 'v2', ...DOMAIN_ON } },
];

interface Trace {
  item_id: string;
  retrieval_config_hash: string | null;
  effective_config: { rag_env: Record<string, string> };
  [key: string]: unknown;
}
interface SpiedRequest {
  url: string;
  model: string | null;
}
interface ArmResult {
  outDir: string;
  traces: Trace[];
  spy: SpiedRequest[];
}

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 3, output }));
  });
}

const python = (module: string, args: string[]) => run('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args]);

function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortedDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** A trace without its timings and the switch values it records: what a run returns for the item. */
const normalized = (trace: Trace): string => {
  const { stage_latency_ms: _latency, config_hash: _configHash, effective_config: _effectiveConfig, ...rest } = trace;
  return JSON.stringify(sortedDeep(rest));
};

describe('domain embeddings off and on without bindings equal today (D-25)', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-parity-'));
  const results = new Map<string, ArmResult>();

  before(async () => {
    await Promise.all(
      ARMS.map(async (arm) => {
        const outDir = path.join(workDir, arm.name);
        const { code, output } = await run(process.execPath, ['--import', 'tsx', 'tests/rag-e2e/domain-parity-arm.mts', arm.mode, outDir, JSON.stringify(arm.env)]);
        assert.equal(code, 0, `arm ${arm.name} failed:\n${output.slice(-4000)}`);
        const traces = fs
          .readFileSync(path.join(outDir, 'traces.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as Trace);
        const spy = JSON.parse(fs.readFileSync(path.join(outDir, 'fetch-spy.json'), 'utf8')) as SpiedRequest[];
        results.set(arm.name, { outDir, traces, spy });
      }),
    );
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const arm = (name: string): ArmResult => {
    const result = results.get(name);
    assert.ok(result, `arm ${name} ran`);
    return result;
  };

  test('each arm ran with the variables it asked for', () => {
    for (const { name, env } of ARMS) {
      const { traces } = arm(name);
      assert.ok(traces.length > 100, `${name} scored the smoke golden set (${traces.length} traces)`);
      const ragEnv = traces[0]!.effective_config.rag_env;
      assert.equal(ragEnv.RAG_DOMAIN_EMBEDDINGS, env.RAG_DOMAIN_EMBEDDINGS ?? 'off', `${name} RAG_DOMAIN_EMBEDDINGS`);
      assert.equal(ragEnv.RAG_EMBEDDING_PROFILES, env.RAG_EMBEDDING_PROFILES ?? 'off', `${name} RAG_EMBEDDING_PROFILES`);
      assert.equal(ragEnv.RAG_PIPELINE, env.RAG_PIPELINE ?? 'legacy', `${name} RAG_PIPELINE`);
    }
  });

  for (const mode of ['prechunked', 'ingest'] as const) {
    for (const name of [`${mode}-off`, `${mode}-on`]) {
      test(`${name}: the gate passes against ${BASELINES[mode]} with every paired difference zero`, async () => {
        const { outDir } = arm(name);
        const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'arm.json'), 'utf8')) as { tracesPath: string; runPath: string; goldenPath: string };
        const score = await python('rag_eval.runner', ['score', '--traces', manifest.tracesPath, '--golden', manifest.goldenPath, '--manifest', manifest.runPath, '--out', outDir]);
        assert.equal(score.code, 0, score.output.slice(-4000));
        const gate = await python('rag_eval.gate', [
          '--report',
          path.join(outDir, 'report.json'),
          '--baseline',
          path.join(REPO_ROOT, BASELINES[mode]),
          '--noise',
          path.join(REPO_ROOT, 'eval/config/noise.json'),
          '--out',
          outDir,
        ]);
        assert.equal(gate.code, 0, gate.output.slice(-4000));
        const verdict = JSON.parse(fs.readFileSync(path.join(outDir, 'gate.json'), 'utf8')) as { passed: boolean; paired?: { all_zero?: boolean } };
        assert.equal(verdict.passed, true);
        assert.equal(verdict.paired?.all_zero, true);
      });
    }
  }

  for (const [left, right] of [
    ['prechunked-off', 'prechunked-on'],
    ['prechunked-off', 'prechunked-domain-only'],
    ['ingest-off', 'ingest-on'],
    ['v2-off', 'v2-on'],
  ] as const) {
    test(`${left} and ${right} return identical per-item results`, () => {
      const a = arm(left).traces;
      const b = arm(right).traces;
      assert.deepEqual(
        b.map((trace) => trace.item_id),
        a.map((trace) => trace.item_id),
      );
      const differing = a.filter((trace, index) => normalized(trace) !== normalized(b[index]!)).map((trace) => trace.item_id);
      assert.deepEqual(differing, [], `items whose result differs between ${left} and ${right}`);
    });
  }

  test('v2: the retrieval config hash of every item is identical between off and on without bindings', () => {
    const off = arm('v2-off').traces;
    const on = arm('v2-on').traces;
    assert.ok(off.every((trace) => typeof trace.retrieval_config_hash === 'string' && trace.retrieval_config_hash.length > 0), 'v2 traces carry the hash');
    assert.deepEqual(
      on.map((trace) => trace.retrieval_config_hash),
      off.map((trace) => trace.retrieval_config_hash),
    );
  });

  test('v2 on consults the binding registry, finds no binding, and plans no leg', () => {
    const rpc = (name: string) => arm(name).spy.filter((request) => request.url.includes('/rest/v1/rpc/rag_list_embedding_bindings')).length;
    assert.ok(rpc('v2-on') > 0, 'the on arm read the binding registry');
    assert.equal(rpc('v2-off'), 0, 'the off arm never reads the binding registry');
    for (const trace of arm('v2-on').traces) {
      const raw = JSON.stringify(trace);
      assert.ok(!raw.includes('dense_domain:'), `${trace.item_id} has no domain leg`);
    }
  });

  test('no arm sends a request to a domain vendor model or the Voyage embeddings route', () => {
    for (const { name } of ARMS) {
      const { spy } = arm(name);
      assert.ok(spy.length > 0, `${name}: the fetch spy saw the run's requests`);
      const vendor = spy.filter(
        (request) => (request.model !== null && DOMAIN_MODELS.includes(request.model)) || /\/voyage\/v1\/embeddings|voyageai\.com/.test(request.url),
      );
      assert.deepEqual(vendor, [], `${name} sent a domain vendor request`);
    }
  });
});
