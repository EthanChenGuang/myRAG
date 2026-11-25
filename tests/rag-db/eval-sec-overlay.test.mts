import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GoldenItemSchema, RagTraceSchema, type GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { answersItemForInjectionMetrics, runEval, STUB_GENERATOR_MODEL } from '../../eval/harness/run-eval.mts';
import { loadRunConfig, parseRunConfig, RunConfigError, RUN_CONFIG_ENV_ALLOWLIST, RUN_CONFIG_REJECT_MESSAGE } from '../../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const BUDGETS_PATH = path.join(REPO_ROOT, 'eval/config/latency-budgets.json');
const SEC_SWITCHES = ['RAG_CONTEXT_TAGGING', 'RAG_INJECTION_CHECK', 'RAG_INJECTION_LAKERA', 'RAG_INJECTION_PROMPT_GUARD', 'RAG_TOOL_RESULT_GUARD'];

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sec-overlay-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function goldenItems(ids: string[]): GoldenItem[] {
  const byId = new Map<string, GoldenItem>();
  for (const line of fs.readFileSync(GOLDEN_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const item = GoldenItemSchema.parse(JSON.parse(line));
    byId.set(item.id, item);
  }
  return ids.map((id) => {
    const item = byId.get(id);
    assert.ok(item, `golden item ${id} exists`);
    return item;
  });
}

describe('SEC run-config files (D-14)', () => {
  test('sec-all-off.json sets every SEC switch to its default', () => {
    const config = loadRunConfig(path.join(RUNS_DIR, 'sec-all-off.json'));
    assert.equal(config.name, 'sec-all-off');
    assert.deepEqual(config.env, {
      RAG_CONTEXT_TAGGING: 'false',
      RAG_INJECTION_CHECK: 'off',
      RAG_INJECTION_LAKERA: 'false',
      RAG_INJECTION_PROMPT_GUARD: 'false',
      RAG_TOOL_RESULT_GUARD: 'off',
    });
    assert.equal(config.overrides, null);
  });

  test('sec-recommended.json is tagging on, check drop, both ML detectors off', () => {
    const config = loadRunConfig(path.join(RUNS_DIR, 'sec-recommended.json'));
    assert.equal(config.name, 'sec-recommended');
    assert.deepEqual(config.env, {
      RAG_CONTEXT_TAGGING: 'true',
      RAG_INJECTION_CHECK: 'drop',
      RAG_INJECTION_LAKERA: 'false',
      RAG_INJECTION_PROMPT_GUARD: 'false',
    });
    assert.equal(config.overrides, null);
  });

  test('sec-tagging-only.json is tagging on with the check off', () => {
    const config = loadRunConfig(path.join(RUNS_DIR, 'sec-tagging-only.json'));
    assert.equal(config.name, 'sec-tagging-only');
    assert.deepEqual(config.env, {
      RAG_CONTEXT_TAGGING: 'true',
      RAG_INJECTION_CHECK: 'off',
      RAG_INJECTION_LAKERA: 'false',
      RAG_INJECTION_PROMPT_GUARD: 'false',
    });
  });
});

describe('SEC run-config allow-list (T-05.1-58)', () => {
  test('the allow-list holds the five SEC switch names', () => {
    for (const name of SEC_SWITCHES) assert.ok(RUN_CONFIG_ENV_ALLOWLIST.includes(name), name);
  });

  for (const name of [
    'LAKERA_GUARD_API_KEY',
    'RAG_INJECTION_LAKERA_MULTI_TENANT_ACK',
    'RAG_INJECTION_LAKERA_REGION',
    'NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST',
    'RAG_SIDECAR_SECRET',
    'RAG_STAGE_TIMEOUTS',
  ]) {
    test(`an overlay naming ${name} is rejected`, () => {
      assert.throws(
        () => parseRunConfig({ name: 'bad', env: { RAG_INJECTION_CHECK: 'drop', [name]: 'x' } }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.message === RUN_CONFIG_REJECT_MESSAGE && error.names.includes(name),
      );
    });
  }

  for (const [name, value] of [
    ['RAG_INJECTION_CHECK', 'block'],
    ['RAG_CONTEXT_TAGGING', 'yes'],
    ['RAG_INJECTION_PROMPT_GUARD', 'on'],
    ['RAG_INJECTION_LAKERA', '1'],
    ['RAG_TOOL_RESULT_GUARD', 'drop'],
  ] as const) {
    test(`${name}=${value} is rejected as an invalid SEC switch value`, () => {
      assert.throws(
        () => parseRunConfig({ name: 'bad', env: { [name]: value } }, 'inline'),
        (error: unknown) => error instanceof RunConfigError && error.message.includes(name) && !error.message.includes(value),
      );
    });
  }

  test('a run config naming LAKERA_GUARD_API_KEY exits 2 before any request and never prints the value', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'bad', env: { RAG_INJECTION_CHECK: 'drop', LAKERA_GUARD_API_KEY: 'placeholder-value' } }));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--run-config', file, '--no-gate', '--out', path.join(dir, 'out')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes(RUN_CONFIG_REJECT_MESSAGE), result.stderr);
    assert.ok(result.stderr.includes('LAKERA_GUARD_API_KEY'), result.stderr);
    assert.equal(result.stderr.includes('placeholder-value'), false);
    assert.equal(fs.existsSync(path.join(dir, 'out', 'traces.jsonl')), false);
  });
});

describe('smoke-tier stub answers for injection items (D-14)', () => {
  test('only injection and injection_evasive items are answered, and only in the smoke tier', () => {
    const [general, injection, evasive] = goldenItems(['en-general-001', 'en-injection-001', 'en-injection-evasive-001']);
    assert.equal(answersItemForInjectionMetrics('smoke', general), false);
    assert.equal(answersItemForInjectionMetrics('smoke', injection), true);
    assert.equal(answersItemForInjectionMetrics('smoke', evasive), true);
    assert.equal(answersItemForInjectionMetrics('nightly', injection), false);
    assert.equal(answersItemForInjectionMetrics('live', injection), false);
  });

  test('under sec-recommended the overlay is recorded and only the injection item carries a stub answer', async () => {
    const dir = makeTmpDir();
    const goldenPath = path.join(dir, 'two.jsonl');
    const items = goldenItems(['en-general-001', 'en-injection-001']);
    fs.writeFileSync(goldenPath, items.map((item) => JSON.stringify(item)).join('\n') + '\n');
    const runConfig = loadRunConfig(path.join(RUNS_DIR, 'sec-recommended.json'));

    const result = await runEval({ goldenPath, corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant', runConfig });

    assert.equal(result.edgeErrors, 0);
    assert.deepEqual(result.manifest.run_config?.env, runConfig.env);
    assert.equal(result.manifest.request_options.generator_model ?? null, null);
    const traces = fs
      .readFileSync(result.tracesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => RagTraceSchema.parse(JSON.parse(line)));
    const [generalTrace, injectionTrace] = traces;
    for (const trace of traces) {
      assert.equal(trace.effective_config.rag_env.RAG_INJECTION_CHECK, 'drop');
      assert.equal(trace.effective_config.rag_env.RAG_CONTEXT_TAGGING, 'true');
    }
    assert.equal(generalTrace.answer, null);
    assert.equal(generalTrace.effective_config.generator_model, null);
    assert.equal(injectionTrace.effective_config.generator_model, STUB_GENERATOR_MODEL);
    assert.equal(typeof injectionTrace.answer, 'string');
    assert.equal(injectionTrace.injection?.mode, 'drop');
    assert.ok((injectionTrace.injection?.dropped.length ?? 0) > 0, 'the rule-caught attack chunk is dropped');
    const canary = items[1].attack?.canary ?? '';
    assert.ok(canary.length > 0);
    assert.equal(injectionTrace.context.includes(canary), false);
    assert.equal((injectionTrace.answer ?? '').includes(canary), false);
  });

  test('with every SEC switch at its default the non-injection trace has no answer and no injection record', async () => {
    const dir = makeTmpDir();
    const goldenPath = path.join(dir, 'two.jsonl');
    fs.writeFileSync(goldenPath, goldenItems(['en-general-001', 'en-injection-001']).map((item) => JSON.stringify(item)).join('\n') + '\n');

    const result = await runEval({ goldenPath, corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant' });

    const traces = fs
      .readFileSync(result.tracesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => RagTraceSchema.parse(JSON.parse(line)));
    assert.equal(traces[0].answer, null);
    assert.equal(traces[0].effective_config.generator_model, null);
    assert.equal(traces[0].injection ?? null, null);
    assert.equal(traces[1].injection ?? null, null);
    assert.equal(typeof traces[1].answer, 'string');
    assert.equal(result.manifest.request_options.generator_model ?? null, null);
    assert.equal(result.manifest.effective_config_hash.length, 64);
  });
});

describe('latency budgets (D-09)', () => {
  test('injection_check has chat p95 400 ms and voice p95 10 ms', () => {
    const budgets = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')) as { profiles: Record<string, { stages: Record<string, number> }> };
    assert.equal(budgets.profiles.chat.stages.injection_check, 400);
    assert.equal(budgets.profiles.embed.stages.injection_check, 400);
    assert.equal(budgets.profiles.voice.stages.injection_check, 10);
    const validate = spawnSync(
      'uv',
      ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', 'rag_sidecar.contracts.validate', '--model', 'LatencyBudgets', '--json', BUDGETS_PATH],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(validate.status, 0, validate.stderr || validate.stdout);
  });
});
