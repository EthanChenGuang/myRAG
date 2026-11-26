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
import { applyFixtureProcessEnv } from '../../eval/harness/process-env.mts';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TRACER_ITEM_ID = 'en-general-001';
const REJECT_MESSAGE =
  '[Eval Harness] run-config may only set RAG_PIPELINE, Phase 4 RAG_* switches, the Phase 5.1 SEC switches and the Phase 6 query-layer and semantic-cache switches';
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
    .find((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return false;
      return (JSON.parse(trimmed) as { id: string }).id === TRACER_ITEM_ID;
    });
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

describe('Phase 4.1 defaults-gate run configs', () => {
  const D01 = {
    RAG_PIPELINE: 'v2',
    RAG_LEXICAL_SEARCH: 'true',
    RAG_RERANKER: 'auto',
    RAG_REFUSAL_THRESHOLD: 'true',
    RAG_REFUSAL_FLOOR: 'legacy_rule',
  };
  const KEYLESS = { ...D01, COHERE_API_KEY: '' };
  const HOSTED = { ...D01, COHERE_API_KEY: 'fixture' };
  const expected: Record<string, { env: Record<string, string>; rerankModel: string | null }> = {
    legacy: { env: { RAG_PIPELINE: 'legacy' }, rerankModel: null },
    'v2-default': { env: KEYLESS, rerankModel: null },
    'v2-default-no-cells': { env: { ...KEYLESS, RAG_REFUSAL_THRESHOLD: 'false' }, rerankModel: null },
    'v2-default-hosted-fake': { env: HOSTED, rerankModel: 'fake-quality-v1' },
    'v2-default-hosted-fake-no-cells': { env: { ...HOSTED, RAG_REFUSAL_THRESHOLD: 'false' }, rerankModel: 'fake-quality-v1' },
    'v2-default-similarity-floor': { env: { ...KEYLESS, RAG_REFUSAL_FLOOR: 'similarity' }, rerankModel: null },
    'v2-default-similarity-floor-no-cells': {
      env: { ...KEYLESS, RAG_REFUSAL_FLOOR: 'similarity', RAG_REFUSAL_THRESHOLD: 'false' },
      rerankModel: null,
    },
    'v2-default-similarity-floor-hosted-fake': { env: { ...HOSTED, RAG_REFUSAL_FLOOR: 'similarity' }, rerankModel: 'fake-quality-v1' },
    'v2-default-similarity-floor-hosted-fake-no-cells': {
      env: { ...HOSTED, RAG_REFUSAL_FLOOR: 'similarity', RAG_REFUSAL_THRESHOLD: 'false' },
      rerankModel: 'fake-quality-v1',
    },
    'v2-default-fallback-none': { env: { ...KEYLESS, RAG_RERANKER: 'none' }, rerankModel: null },
    'v2-default-fallback-none-no-cells': {
      env: { ...KEYLESS, RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false' },
      rerankModel: null,
    },
  };

  for (const [name, want] of Object.entries(expected)) {
    test(`${name}.json loads with the registered settings`, () => {
      const config = loadRunConfig(path.join(RUNS_DIR, `${name}.json`));
      assert.equal(config.name, name);
      assert.deepEqual(config.env, Object.fromEntries(Object.entries(want.env).sort(([a], [b]) => a.localeCompare(b))));
      assert.equal(config.overrides?.rerank_model ?? null, want.rerankModel);
      for (const key of Object.keys(config.env)) assert.doesNotMatch(key, /MODE/);
    });
  }
});

describe('run-config validation', () => {
  test('the allow-list is RAG_PIPELINE, the Phase 4 RAG_ switches, the refusal floor, the eight Phase 4.2 tuning switches, the value-constrained vendor settings, the five Phase 5.1 SEC switches, the 16 Phase 6 names, the three terminology switches and the fourteen Phase 5.2 answer-rule switches', () => {
    assert.deepEqual([...RUN_CONFIG_ENV_ALLOWLIST].sort(), [
      'COHERE_API_KEY',
      'COHERE_BASE_URL',
      'RAG_CITATION_PER_SENTENCE',
      'RAG_CLAIM_CHECK',
      'RAG_CONTEXT_COMPRESSION',
      'RAG_CONTEXT_EDGE_ORDER',
      'RAG_CONTEXT_RELEVANCE_RULE',
      'RAG_CONTEXT_TAGGING',
      'RAG_CONTEXT_TOKEN_BUDGET',
      'RAG_DUP_CLUSTERS',
      'RAG_EXACT_SCAN_CUTOFF',
      'RAG_GROUNDEDNESS_JUDGE_MODEL',
      'RAG_GROUNDEDNESS_LLM_JUDGE',
      'RAG_HNSW_ITERATIVE_SCAN',
      'RAG_IDENTIFIER_FILTER',
      'RAG_IDENTIFIER_INDEX',
      'RAG_INJECTION_CHECK',
      'RAG_INJECTION_LAKERA',
      'RAG_INJECTION_PROMPT_GUARD',
      'RAG_LEXICAL_DICTIONARY',
      'RAG_LEXICAL_SEARCH',
      'RAG_LEXICAL_STEM_IT',
      'RAG_LEXICAL_TRANSLATION',
      'RAG_MAX_OUTPUT_TOKENS',
      'RAG_OUTPUT_GUARD',
      'RAG_PARENT_CHILD',
      'RAG_PARTIAL_ANSWER_RULE',
      'RAG_PIPELINE',
      'RAG_QUERY_CONDENSE',
      'RAG_QUERY_DATE_NORMALIZE',
      'RAG_QUERY_DECOMPOSE',
      'RAG_QUERY_EXPAND',
      'RAG_QUERY_FRAMEWORK',
      'RAG_QUERY_HYDE',
      'RAG_QUERY_LAYER',
      'RAG_QUERY_LLM_MODEL',
      'RAG_QUERY_TRANSLATE',
      'RAG_QUERY_TRANSLATE_DISABLED_PROFILES',
      'RAG_QUERY_VOICE_TRANSFORMS',
      'RAG_REFUSAL_FLOOR',
      'RAG_REFUSAL_THRESHOLD',
      'RAG_REGISTRY_TEXTS',
      'RAG_RERANKER',
      'RAG_RERANK_TIER_CHAT',
      'RAG_RERANK_TIER_VOICE',
      'RAG_RERANK_VOYAGE_MODEL_BY_LANG',
      'RAG_RESULT_DIVERSITY',
      'RAG_SECURITY_EVENTS',
      'RAG_SEMANTIC_CACHE',
      'RAG_SEMANTIC_CACHE_EMBED_STORE',
      'RAG_SEMANTIC_CACHE_MAX_DISTANCE',
      'RAG_SEMANTIC_CACHE_REFUSAL_TTL',
      'RAG_SEMANTIC_CACHE_TTL',
      'RAG_TABLE_LOOKUP',
      'RAG_TERMINOLOGY',
      'RAG_TERMINOLOGY_DENSE',
      'RAG_TERMINOLOGY_MINING',
      'RAG_TOOL_RESULT_GUARD',
      'RAG_UPLOADER_ALERT_THRESHOLD',
      'RAG_UPLOADER_ALERT_WINDOW_HOURS',
      'RAG_UPLOADER_HOLD',
      'RAG_VERSION_LABELS',
      'RAG_VERSION_SCOPE',
      'VOYAGE_API_KEY',
      'VOYAGE_BASE_URL',
    ]);
  });

  test('RAG_REFUSAL_FLOOR is accepted', () => {
    const config = parseRunConfig({ name: 'floor', env: { RAG_PIPELINE: 'v2', RAG_REFUSAL_FLOOR: 'legacy_rule' }, overrides: null }, 'inline');
    assert.equal(config.env.RAG_REFUSAL_FLOOR, 'legacy_rule');
  });

  test('the terminology switches are accepted and an unknown terminology name is rejected (D-29)', () => {
    const config = parseRunConfig(
      { name: 'terminology', env: { RAG_PIPELINE: 'v2', RAG_TERMINOLOGY: 'true', RAG_TERMINOLOGY_DENSE: 'false', RAG_TERMINOLOGY_MINING: 'false' }, overrides: null },
      'inline',
    );
    assert.equal(config.env.RAG_TERMINOLOGY, 'true');
    assert.throws(
      () => parseRunConfig({ name: 'terminology', env: { RAG_PIPELINE: 'v2', RAG_TERMINOLOGY_X: 'true' }, overrides: null }, 'inline'),
      (error: unknown) => error instanceof RunConfigError && error.message === REJECT_MESSAGE,
    );
  });

  test('key overlay only takes placeholders', () => {
    for (const name of ['COHERE_API_KEY', 'VOYAGE_API_KEY']) {
      for (const value of ['', 'proxy-injected', 'fixture']) {
        const config = parseRunConfig({ name: 'key', env: { RAG_PIPELINE: 'v2', [name]: value }, overrides: null }, 'inline');
        assert.equal(config.env[name], value);
      }
      for (const value of ['abc123', 'sk-live-0000', ' proxy-injected', 'FIXTURE']) {
        assert.throws(
          () => parseRunConfig({ name: 'key', env: { RAG_PIPELINE: 'v2', [name]: value }, overrides: null }, 'inline'),
          (error: unknown) =>
            error instanceof RunConfigError && error.names.includes(name) && !error.message.includes(value === 'abc123' || value === 'sk-live-0000' ? value : '\u0000'),
        );
      }
    }
  });

  test('base url overlay only takes vendor hosts', () => {
    const allowed: Record<string, string[]> = {
      COHERE_BASE_URL: ['', 'https://api.cohere.com'],
      VOYAGE_BASE_URL: ['', 'https://api.voyageai.com/v1'],
    };
    for (const [name, values] of Object.entries(allowed)) {
      for (const value of values) {
        const config = parseRunConfig({ name: 'url', env: { [name]: value }, overrides: null }, 'inline');
        assert.equal(config.env[name], value);
      }
    }
    for (const [name, value] of [
      ['COHERE_BASE_URL', 'https://evil.example'],
      ['COHERE_BASE_URL', 'http://api.cohere.com'],
      ['COHERE_BASE_URL', 'https://api.voyageai.com/v1'],
      ['VOYAGE_BASE_URL', 'https://api.cohere.com'],
      ['VOYAGE_BASE_URL', 'https://api.voyageai.com.evil.example/v1'],
    ]) {
      assert.throws(
        () => parseRunConfig({ name: 'url', env: { [name]: value }, overrides: null }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.names.includes(name),
      );
    }
  });

  for (const name of ['OPENROUTER_API_KEY', 'RAG_EVAL_SECRET', 'OPENAI_API_KEY', 'NODE_ENV', 'RAG_RETRIEVAL_PARAMS_OVERRIDE', 'RAG_DISABLED_STAGES']) {
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

describe('fixture process env and the vendor-key overlay', () => {
  const EDGE = 'http://127.0.0.1:9';
  const fixtureKey = fixtureProcessEnv(EDGE).COHERE_API_KEY;

  function withProcessEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const saved = { ...process.env };
    try {
      applyFixtureProcessEnv({ edgeUrl: EDGE, deploymentMode: 'single-tenant', extra });
      return { ...process.env };
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  }

  test('empty key overlay clears the fixture key', () => {
    const env = withProcessEnv({ RAG_PIPELINE: 'v2', RAG_RERANKER: 'cohere', COHERE_API_KEY: '' });
    assert.equal(env.COHERE_API_KEY, '');
  });

  test('auto runs keyless unless asked', () => {
    assert.ok(fixtureKey.length > 0);
    const keyless = withProcessEnv({ RAG_PIPELINE: 'v2', RAG_RERANKER: 'auto' });
    assert.equal(keyless.COHERE_API_KEY ?? '', '');
    const asked = withProcessEnv({ RAG_PIPELINE: 'v2', RAG_RERANKER: 'auto', COHERE_API_KEY: 'fixture' });
    assert.equal(asked.COHERE_API_KEY, fixtureKey);
    const explicit = withProcessEnv({ RAG_PIPELINE: 'v2', RAG_RERANKER: 'cohere' });
    assert.equal(explicit.COHERE_API_KEY, fixtureKey);
    const none = withProcessEnv({ RAG_PIPELINE: 'v2', RAG_RERANKER: 'none' });
    assert.equal(none.COHERE_API_KEY, fixtureKey);
  });

  test('the fixture token keeps the fixture Voyage key too', () => {
    const env = withProcessEnv({ RAG_PIPELINE: 'v2', VOYAGE_API_KEY: 'fixture' });
    assert.equal(env.VOYAGE_API_KEY, fixtureProcessEnv(EDGE).VOYAGE_API_KEY);
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
