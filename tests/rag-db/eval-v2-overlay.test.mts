import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GoldenItemSchema, RetrievalOverridesSchema, type GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { configHash } from '../../src/lib/rag-eval/trace.ts';
import { itemRequestOptions, runEval } from '../../eval/harness/run-eval.mts';
import { loadRunConfig, parseRunConfig, RunConfigError, RUN_CONFIG_ENV_ALLOWLIST } from '../../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TRACER_ITEM_ID = 'en-general-001';
const REJECT_MESSAGE = '[Eval Harness] run-config may only set RAG_PIPELINE and Phase 4 RAG_* switches';
const DOC_ID = '11111111-1111-4111-8111-111111111111';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-v2-overlay-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function goldenItem(): GoldenItem {
  const line = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .find((entry) => entry.includes(`"id": "${TRACER_ITEM_ID}"`));
  assert.ok(line, 'tracer golden item exists');
  return GoldenItemSchema.parse(JSON.parse(line));
}

describe('run-config file contents', () => {
  test('v2-all-off.json sets RAG_PIPELINE=v2 and nothing else', () => {
    const config = loadRunConfig(path.join(RUNS_DIR, 'v2-all-off.json'));
    assert.equal(config.name, 'v2-all-off');
    assert.deepEqual(config.env, { RAG_PIPELINE: 'v2' });
    assert.equal(config.overrides, null);
  });

  test('v2-recommended.json turns on lexical, Cohere against the fake quality model, refusal and edge order', () => {
    const config = loadRunConfig(path.join(RUNS_DIR, 'v2-recommended.json'));
    assert.equal(config.name, 'v2-recommended');
    assert.deepEqual(config.env, {
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_RERANKER: 'cohere',
      RAG_REFUSAL_THRESHOLD: 'true',
      RAG_CONTEXT_EDGE_ORDER: 'true',
    });
    assert.equal(config.overrides?.rerank_model, 'fake-quality-v1');
  });
});

describe('run-config validation', () => {
  test('the allow-list is RAG_PIPELINE and the Phase 4 RAG_ switches', () => {
    assert.deepEqual([...RUN_CONFIG_ENV_ALLOWLIST].sort(), [
      'RAG_CONTEXT_COMPRESSION',
      'RAG_CONTEXT_EDGE_ORDER',
      'RAG_CONTEXT_TOKEN_BUDGET',
      'RAG_EXACT_SCAN_CUTOFF',
      'RAG_HNSW_ITERATIVE_SCAN',
      'RAG_LEXICAL_SEARCH',
      'RAG_LEXICAL_TRANSLATION',
      'RAG_PARENT_CHILD',
      'RAG_PIPELINE',
      'RAG_REFUSAL_THRESHOLD',
      'RAG_RERANKER',
      'RAG_RERANK_TIER_CHAT',
      'RAG_RERANK_TIER_VOICE',
      'RAG_RERANK_VOYAGE_MODEL_BY_LANG',
    ]);
  });

  for (const name of ['OPENROUTER_API_KEY', 'RAG_EVAL_SECRET', 'COHERE_API_KEY', 'NODE_ENV', 'RAG_RETRIEVAL_PARAMS_OVERRIDE', 'RAG_DISABLED_STAGES']) {
    test(`an overlay naming ${name} is rejected`, () => {
      assert.throws(
        () => parseRunConfig({ name: 'bad', env: { RAG_PIPELINE: 'v2', [name]: 'x' }, overrides: null }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.message === REJECT_MESSAGE,
      );
    });
  }

  test('an invalid override is rejected', () => {
    for (const overrides of [{ final_top_k: 0 }, { rerank_input_cap: 10 }, { unknown_knob: 1 }]) {
      assert.throws(
        () => parseRunConfig({ name: 'bad', env: {}, overrides }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.message.startsWith('[Eval Harness] run-config overrides are invalid'),
      );
    }
  });

  test('a malformed file is rejected', () => {
    for (const raw of [null, [], { env: {} }, { name: '', env: {} }, { name: 'x', env: { RAG_PIPELINE: 2 } }, { name: 'x', env: {}, extra: 1 }, { name: 'x', env: { RAG_PIPELINE: 'v3' } }]) {
      assert.throws(() => parseRunConfig(raw, 'inline'), RunConfigError);
    }
  });

  test('overrides are normalized through the generated schema', () => {
    const config = parseRunConfig({ name: 'ok', env: { RAG_PIPELINE: 'v2' }, overrides: { final_top_k: 5 } }, 'inline');
    assert.deepEqual(config.overrides, RetrievalOverridesSchema.parse({ final_top_k: 5 }));
  });
});

describe('per-item request options', () => {
  test('a golden item with retrieval_filters sends them as options.retrieval_filters', () => {
    const filters = { current_only: true as const, doc_types: ['contract_legal' as const], document_ids: [DOC_ID], languages: null, sources: null, date_range: null, invoice: null };
    const item = { ...goldenItem(), retrieval_filters: filters };
    const options = itemRequestOptions({ max_results: 5 }, item);
    assert.deepEqual(options.retrieval_filters, filters);
    assert.equal(options.max_results, 5);
  });

  test('a golden item without retrieval_filters leaves the options unchanged', () => {
    const base = { max_results: 5 };
    const options = itemRequestOptions(base, goldenItem());
    assert.deepEqual(options, { max_results: 5 });
    assert.equal('retrieval_filters' in options, false);
  });
});

describe('run-config through runEval', () => {
  test('the overlay and overrides are recorded in the manifest and the config hash', async () => {
    const dir = makeTmpDir();
    const goldenPath = path.join(dir, 'one.jsonl');
    fs.writeFileSync(goldenPath, `${JSON.stringify(goldenItem())}\n`);
    const runConfig = parseRunConfig({ name: 'overlay-test', env: { RAG_PIPELINE: 'v2' }, overrides: { final_top_k: 3 } }, 'inline');

    const result = await runEval({
      goldenPath,
      corpusDir: CORPUS_DIR,
      outDir: path.join(dir, 'out'),
      deploymentMode: 'single-tenant',
      runConfig,
    });

    assert.equal(result.edgeErrors, 0);
    assert.deepEqual(result.manifest.run_config, {
      name: 'overlay-test',
      env: { RAG_PIPELINE: 'v2' },
      overrides: RetrievalOverridesSchema.parse({ final_top_k: 3 }),
    });
    assert.equal(result.manifest.request_options.retrieval_overrides?.final_top_k, 3);

    const trace = JSON.parse(fs.readFileSync(result.tracesPath, 'utf8').trim().split('\n')[0]) as {
      effective_config: { rag_env: Record<string, string> };
      retrieval_config_hash: string | null;
    };
    assert.equal(trace.effective_config.rag_env.RAG_PIPELINE, 'v2');
    assert.match(trace.retrieval_config_hash ?? '', /^[a-f0-9]{64}$/);

    const legacyEquivalent = {
      ...trace.effective_config,
      rag_env: { ...trace.effective_config.rag_env, RAG_PIPELINE: 'legacy' },
    };
    assert.notEqual(result.manifest.effective_config_hash, configHash(legacyEquivalent));
    assert.equal(result.manifest.effective_config_hash, configHash(trace.effective_config));
  });
});

describe('run-config guards in runEval', () => {
  test('an env overlay is refused for a retained in-process session and for --base-url', async () => {
    const dir = makeTmpDir();
    const goldenPath = path.join(dir, 'one.jsonl');
    fs.writeFileSync(goldenPath, `${JSON.stringify(goldenItem())}\n`);
    const runConfig = parseRunConfig({ name: 'guard', env: { RAG_PIPELINE: 'v2' } }, 'inline');
    const common = { goldenPath, corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant' as const, runConfig };

    await assert.rejects(runEval({ ...common, retainInProcess: {} as never }), RunConfigError);
    await assert.rejects(runEval({ ...common, baseUrl: 'http://localhost:9' }), RunConfigError);
  });
});

describe('npm run test-rag --run-config', () => {
  function runSmoke(config: unknown, extra: string[] = []) {
    const dir = makeTmpDir();
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return spawnSync(process.execPath, ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--run-config', file, '--no-gate', '--out', path.join(dir, 'out'), ...extra], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  }

  test('an overlay naming a key or secret exits 2 with the allow-list message before any request', () => {
    for (const name of ['OPENROUTER_API_KEY', 'RAG_EVAL_SECRET']) {
      const result = runSmoke({ name: 'bad', env: { RAG_PIPELINE: 'v2', [name]: 'placeholder' } });
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes(REJECT_MESSAGE), result.stderr);
      assert.equal(result.stderr.includes('placeholder'), false);
    }
  });

  test('an invalid override exits 2 before any request', () => {
    const result = runSmoke({ name: 'bad', env: {}, overrides: { final_top_k: 0 } });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('run-config overrides are invalid'), result.stderr);
  });

  test('an env overlay cannot be combined with --base-url', () => {
    const result = runSmoke({ name: 'v2', env: { RAG_PIPELINE: 'v2' } }, ['--base-url', 'http://localhost:9']);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('in-process runs only'), result.stderr);
  });
});
