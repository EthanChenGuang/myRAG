import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { GoldenItemSchema, type GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { configHash } from '../../src/lib/rag-eval/trace.ts';
import { prepareInProcessEval, shouldInstallFakeQueryLlm } from '../../eval/harness/run-eval.mts';
import { loadRunConfig, parseRunConfig, RunConfigError, RUN_CONFIG_ENV_ALLOWLIST, RUN_CONFIG_REJECT_MESSAGE } from '../../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TRANSFORMS_PATH = path.join(REPO_ROOT, 'eval/fixtures/query-llm/transforms.json');

const PHASE6_NAMES = [
  'RAG_QUERY_LAYER',
  'RAG_QUERY_FRAMEWORK',
  'RAG_QUERY_LLM_MODEL',
  'RAG_QUERY_CONDENSE',
  'RAG_QUERY_EXPAND',
  'RAG_QUERY_DECOMPOSE',
  'RAG_QUERY_TRANSLATE',
  'RAG_QUERY_DATE_NORMALIZE',
  'RAG_QUERY_HYDE',
  'RAG_QUERY_TRANSLATE_DISABLED_PROFILES',
  'RAG_QUERY_VOICE_TRANSFORMS',
  'RAG_SEMANTIC_CACHE',
  'RAG_SEMANTIC_CACHE_TTL',
  'RAG_SEMANTIC_CACHE_REFUSAL_TTL',
  'RAG_SEMANTIC_CACHE_MAX_DISTANCE',
  'RAG_SEMANTIC_CACHE_EMBED_STORE',
];

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-query-layer-overlay-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runConfigFile(name: string): string {
  const file = path.join(RUNS_DIR, name);
  assert.ok(fs.existsSync(file), `${name} exists`);
  return file;
}

function golden(): GoldenItem[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
}

function writeGolden(dir: string, items: GoldenItem[]): string {
  const file = path.join(dir, 'golden.jsonl');
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join('\n') + '\n');
  return file;
}

interface Trace {
  item_id: string;
  query: string;
  query_plan: null | { original: string; standalone: string; framework: string; gate: { transforms: string[] } };
  query_transforms: Array<{ kind: string; text: string; transform: string | null; status: string | null }>;
  candidates: Array<{ chunk_id: string; similarity: number; fused_score: number | null }>;
  kept: Array<{ chunk_id: string }>;
  refused: boolean;
  refusal_reason: string | null;
  context: string;
  stage_status: Record<string, string>;
  effective_config: { rag_env: Record<string, string> };
}

function readTraces(file: string): Trace[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Trace);
}

function scriptedCondense(): Map<string, string> {
  const table = JSON.parse(fs.readFileSync(TRANSFORMS_PATH, 'utf8')) as { entries: Array<{ transform: string; query: string; output?: { standalone?: string } }> };
  const out = new Map<string, string>();
  for (const entry of table.entries) {
    if (entry.transform === 'condense' && entry.output?.standalone) out.set(entry.query, entry.output.standalone);
  }
  return out;
}

describe('Phase 6 run-config overlay names', () => {
  test('the allow-list holds the 16 Phase 6 query-layer and semantic-cache names', () => {
    for (const name of PHASE6_NAMES) assert.ok(RUN_CONFIG_ENV_ALLOWLIST.includes(name), name);
  });

  test('a run config with RAG_QUERY_LAYER and RAG_QUERY_HYDE is accepted', () => {
    const config = parseRunConfig({ name: 'ql', env: { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_QUERY_HYDE: 'true' } }, 'inline');
    assert.deepEqual(config.env, { RAG_PIPELINE: 'v2', RAG_QUERY_HYDE: 'true', RAG_QUERY_LAYER: 'true' });
  });

  test('every Phase 6 name is accepted with a valid value', () => {
    const env = {
      RAG_PIPELINE: 'v2',
      RAG_QUERY_LAYER: 'true',
      RAG_QUERY_FRAMEWORK: 'langchain',
      RAG_QUERY_LLM_MODEL: 'openai/gpt-4.1-nano',
      RAG_QUERY_CONDENSE: 'true',
      RAG_QUERY_EXPAND: 'false',
      RAG_QUERY_DECOMPOSE: 'true',
      RAG_QUERY_TRANSLATE: 'false',
      RAG_QUERY_DATE_NORMALIZE: 'true',
      RAG_QUERY_HYDE: 'false',
      RAG_QUERY_TRANSLATE_DISABLED_PROFILES: '',
      RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,normalize_dates',
      RAG_SEMANTIC_CACHE: 'pgvector',
      RAG_SEMANTIC_CACHE_TTL: '3600',
      RAG_SEMANTIC_CACHE_REFUSAL_TTL: '600',
      RAG_SEMANTIC_CACHE_MAX_DISTANCE: '0.05',
      RAG_SEMANTIC_CACHE_EMBED_STORE: 'false',
    };
    assert.deepEqual(Object.keys(parseRunConfig({ name: 'all', env }, 'inline').env).sort(), Object.keys(env).sort());
  });

  test('an enumerated Phase 6 switch with an unknown value is rejected without echoing it', () => {
    for (const [name, value] of [
      ['RAG_QUERY_LAYER', 'maybe'],
      ['RAG_QUERY_FRAMEWORK', 'other'],
      ['RAG_SEMANTIC_CACHE', 'memcached'],
      ['RAG_QUERY_HYDE', 'yes'],
    ] as const) {
      assert.throws(
        () => parseRunConfig({ name: 'bad', env: { RAG_PIPELINE: 'v2', [name]: value } }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.message.includes(name) && !error.message.includes(value),
      );
    }
  });

  test('keys and other foreign names are still rejected', () => {
    for (const name of ['OPENROUTER_API_KEY', 'RAG_EVAL_SECRET', 'RAG_QUERY_ENHANCEMENT', 'RAG_CACHE_ENABLED', 'RAG_SEMANTIC_CACHE_REDIS_URL']) {
      assert.throws(
        () => parseRunConfig({ name: 'bad', env: { RAG_PIPELINE: 'v2', [name]: 'placeholder' } }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.message === RUN_CONFIG_REJECT_MESSAGE && error.names.includes(name),
      );
    }
    assert.ok(RUN_CONFIG_REJECT_MESSAGE.includes('Phase 6'), RUN_CONFIG_REJECT_MESSAGE);
  });
});

describe('Phase 6 run configs', () => {
  test('query-layer-off.json runs v2 with the layer off', () => {
    const config = loadRunConfig(runConfigFile('query-layer-off.json'));
    assert.equal(config.name, 'query-layer-off');
    assert.deepEqual(config.env, { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'false' });
    assert.equal(config.overrides, null);
  });

  test('query-layer-llamaindex.json runs v2 with the layer on and default sub-switches', () => {
    const config = loadRunConfig(runConfigFile('query-layer-llamaindex.json'));
    assert.equal(config.name, 'query-layer-llamaindex');
    assert.deepEqual(config.env, { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' });
    assert.equal(config.overrides, null);
  });

  test('query-layer-langchain.json is the same with RAG_QUERY_FRAMEWORK=langchain', () => {
    const config = loadRunConfig(runConfigFile('query-layer-langchain.json'));
    assert.equal(config.name, 'query-layer-langchain');
    assert.deepEqual(config.env, { RAG_PIPELINE: 'v2', RAG_QUERY_FRAMEWORK: 'langchain', RAG_QUERY_LAYER: 'true' });
    assert.equal(config.overrides, null);
  });
});

describe('fake query LLM install rule', () => {
  test('installs for v2 with the layer on from the overlay or the request options, never otherwise', () => {
    assert.equal(shouldInstallFakeQueryLlm({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' }), true);
    assert.equal(shouldInstallFakeQueryLlm({ RAG_PIPELINE: 'v2' }, { queryLayer: true }), true);
    assert.equal(shouldInstallFakeQueryLlm({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'false' }), false);
    assert.equal(shouldInstallFakeQueryLlm({ RAG_PIPELINE: 'legacy', RAG_QUERY_LAYER: 'true' }), false);
    assert.equal(shouldInstallFakeQueryLlm({ RAG_PIPELINE: 'v2' }), false);
  });

  test('prepareInProcessEval installs the fake query LLM when the overlay turns the layer on', async () => {
    const prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      envOverrides: { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' },
    });
    try {
      assert.ok(prepared.fakeQueryLlm, 'expected the fake query LLM on the session');
      const deps = await import('../../src/lib/rag/deps.ts');
      assert.equal(deps.getRagDeps().queryLlm(), prepared.fakeQueryLlm, 'the pipeline reads the fake, never the live client');

      const item = golden().find((entry) => entry.id === 'en-multi-turn-001');
      assert.ok(item);
      const req = new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
        body: JSON.stringify({ schema_version: 1, query: item.question, conversation: item.conversation, rag_mode: 'balanced', item_id: item.id }),
      });
      const res = await prepared.POST(req);
      assert.equal(res.status, 200);
      assert.deepEqual(
        prepared.fakeQueryLlm.calls.map((call) => call.transform),
        ['condense'],
      );
    } finally {
      await prepared.close();
    }
    const deps = await import('../../src/lib/rag/deps.ts');
    assert.equal('calls' in deps.getRagDeps().queryLlm(), false, 'close() removes the fake');
  });
});

/**
 * Each run is its own process: the app modules keep the fake edge URL of the first in-process session, so a second session in
 * this file (after the prepareInProcessEval case above) would embed against a closed edge.
 */
function runSmoke(configFile: string, items: GoldenItem[]): { traces: Trace[]; manifest: RunManifestBody; items: ReportItem[] } {
  const dir = makeTmpDir();
  const outDir = path.join(dir, 'out');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--run-config', configFile, '--golden', writeGolden(dir, items), '--no-gate', '--out', outDir],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000 },
  );
  assert.equal(result.status, 0, `${path.basename(configFile)}: ${result.stderr.slice(-2000)}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8')) as RunManifestBody;
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')) as { items: ReportItem[] };
  return { traces: readTraces(path.join(outDir, 'traces.jsonl')), manifest, items: report.items };
}

interface RunManifestBody {
  run_config?: { name: string; env: Record<string, string> };
  run_config_hash: string;
  effective_config_hash: string;
}

type ReportItem = Record<string, unknown> & { item_id: string };

describe('Phase 6 run configs through npm run test-rag', () => {
  test('query-layer-llamaindex records the overlay and condenses the multi_turn items with the fake', () => {
    const items = golden().filter((item) => item.category === 'multi_turn');
    assert.equal(items.length, 27);
    const { traces, manifest } = runSmoke(runConfigFile('query-layer-llamaindex.json'), items);

    assert.deepEqual(manifest.run_config?.env, { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' });
    assert.equal(traces.length, 27);
    assert.equal(manifest.effective_config_hash, configHash(traces[0].effective_config as never));
    assert.equal(traces[0].effective_config.rag_env.RAG_QUERY_LAYER, 'true');

    const scripted = scriptedCondense();
    const condensedLanguages = new Set<string>();
    for (const trace of traces) {
      assert.ok(trace.query_plan, `${trace.item_id} has a query plan`);
      assert.equal(trace.query_plan.framework, 'llamaindex');
      if (!trace.query_plan.gate.transforms.includes('condense_history')) continue;
      const expected = scripted.get(trace.query);
      assert.ok(expected, `${trace.item_id} has a scripted condense entry`);
      assert.equal(trace.query_plan.standalone, expected, trace.item_id);
      assert.ok(
        trace.query_transforms.some((entry) => entry.kind === 'condensed' && entry.transform === 'condense' && entry.status === 'ok'),
        trace.item_id,
      );
      condensedLanguages.add(trace.item_id.slice(0, 2));
    }
    // The pre-06-38 Italian follow-ups do not trip the gate (06-29-SUMMARY); the 06-38 ones do, so all three languages condense.
    for (const language of ['en', 'zh', 'it']) assert.ok(condensedLanguages.has(language), `a condensed ${language} multi_turn item`);
  });

  test('query-layer-off gives the same traces and per-item results as the v2-all-off run', () => {
    const items = golden()
      .filter((item) => item.review_status === 'approved')
      .filter((item, index) => item.category === 'multi_turn' || item.category === 'compound' || index % 10 === 0);
    const off = runSmoke(runConfigFile('query-layer-off.json'), items);
    const baseline = runSmoke(runConfigFile('v2-all-off.json'), items);

    assert.equal(off.traces.length, items.length);
    assert.equal(off.manifest.effective_config_hash, baseline.manifest.effective_config_hash);
    const strip = (trace: Trace) => ({
      item_id: trace.item_id,
      query_plan: trace.query_plan,
      query_transforms: trace.query_transforms,
      candidates: trace.candidates.map((row) => [row.chunk_id, row.similarity, row.fused_score]),
      kept: trace.kept.map((row) => row.chunk_id),
      refused: trace.refused,
      refusal_reason: trace.refusal_reason,
      context: trace.context,
      stage_status: trace.stage_status,
    });
    for (const trace of off.traces) assert.equal(trace.query_plan, null, trace.item_id);
    assert.deepEqual(off.traces.map(strip), baseline.traces.map(strip));
    assert.deepEqual(off.items, baseline.items);
  });
});
