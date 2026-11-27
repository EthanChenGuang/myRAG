import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GoldenItemSchema, RagTraceSchema, type GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { runEval } from '../../eval/harness/run-eval.mts';
import { loadRunConfig } from '../../eval/harness/run-config.mts';

/**
 * 05.2-31 Task 3: the two gated Phase 5.2 run configs execute end to end on fixtures through the fake edge, which serves the
 * version columns and the supersession read without a recorded error, and the eval answer path writes the Phase 5.2 fields.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function goldenItems(ids: string[]): GoldenItem[] {
  const all = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
  return ids.map((id) => {
    const item = all.find((candidate) => candidate.id === id);
    assert.ok(item, `golden item ${id} missing`);
    return item;
  });
}

function writeItems(ids: string[]): { dir: string; goldenPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-p52-smoke-'));
  tmpDirs.push(dir);
  const goldenPath = path.join(dir, 'items.jsonl');
  fs.writeFileSync(goldenPath, goldenItems(ids).map((item) => JSON.stringify(item)).join('\n') + '\n');
  return { dir, goldenPath };
}

function readTraces(tracesPath: string) {
  return fs
    .readFileSync(tracesPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => RagTraceSchema.parse(JSON.parse(line)));
}

/** In process: one runEval per process, since a second in-process run keeps the first fake edge's embedder address. */
async function runInProcess(config: string, ids: string[]) {
  const { dir, goldenPath } = writeItems(ids);
  const runConfig = loadRunConfig(path.join(RUNS_DIR, config));
  const result = await runEval({ goldenPath, corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant', runConfig });
  return { edgeErrors: result.edgeErrors, generatorModel: runConfig.generatorModel, traces: readTraces(result.tracesPath) };
}

/** Through the CLI the gate uses (npm run test-rag), in a child process. */
function runCli(config: string, ids: string[], extra: string[] = []) {
  const { dir, goldenPath } = writeItems(ids);
  const out = path.join(dir, 'out');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--run-config', path.join(RUNS_DIR, config), '--golden', goldenPath, '--no-gate', '--out', out, ...extra],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 900_000 },
  );
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const run = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')) as { edge_errors?: number };
  return { edgeErrors: run.edge_errors, traces: readTraces(path.join(out, 'traces.jsonl')) };
}

describe('Phase 5.2 gated run configs on fixtures (05.2-31)', () => {
  test('p52-rules-on: no edge error, the rules reach the prompt and the trace carries the Phase 5.2 fields', async () => {
    const { edgeErrors, generatorModel, traces } = await runInProcess('p52-rules-on.json', ['en-compound-001', 'en-exact-term-001']);
    assert.equal(edgeErrors, 0);
    for (const trace of traces) {
      assert.equal(trace.effective_config.generator_model, generatorModel);
      assert.equal(trace.effective_config.rag_env.RAG_VERSION_LABELS, 'true');
      assert.equal(typeof trace.answer, 'string');
      assert.ok((trace.answer_rules_parts ?? []).includes('version'), JSON.stringify(trace.answer_rules_parts));
      assert.equal(trace.finish_reason, 'stop');
      assert.ok(trace.residual_output_findings, 'the flag-mode accounting pass ran');
      assert.ok((trace.sentences ?? []).length > 0, 'per-sentence records are on the trace');
    }
  });

  test('p52-sec-output-guard: no edge error and no link outside the allow rules is left in the answer', async () => {
    // Labelled blocks let the repeating fake repeat the block that carries the planted link
    const { edgeErrors, traces } = runCli('p52-sec-output-guard.json', ['it-general-003', 'zh-exact-term-001'], ['--citations']);
    assert.equal(edgeErrors, 0);
    for (const trace of traces) {
      assert.equal(trace.output_guard?.mode, 'enforce');
      assert.ok((trace.output_guard?.links_removed ?? 0) > 0, `${trace.item_id}: the repeated planted link was removed`);
      assert.deepEqual(trace.residual_output_findings, { links: 0, credential_matches: 0, rule_ids: [] });
      assert.ok((trace.answer_rules_parts ?? []).includes('output_policy'));
    }
  });
});
