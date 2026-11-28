import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LiveCompareDeps, LiveProfile } from '../eval/harness/binding-compare-live.mts';
import type { RunEvalOptions, RunEvalResult } from '../eval/harness/run-eval.mts';

// quick-311 (EMB-10 gap 1): the --base-url mode runs on a real deployment; the global profile is never served by a fake.
const DOC = 'contract_legal';
const GLOBAL: LiveProfile = { id: 'openai-3-small-1536', provider: 'openai', model: 'text-embedding-3-small', status: 'active' };
const LAW: LiveProfile = { id: 'voyage-law-2-1024', provider: 'voyage', model: 'voyage-law-2', status: 'available' };
const RUN_ID = '00000000-0000-4000-8000-0000000000a1';
const BINDING_ID = '00000000-0000-4000-8000-0000000000b2';
const SERVED_ENV = { RAG_PIPELINE: 'v2', RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' };

interface Recorder {
  deps: LiveCompareDeps;
  npmCalls: Array<[string, string[]]>;
  evalCalls: RunEvalOptions[];
  pythonCalls: Array<[string, string[]]>;
}

function recorder(tmp: string, servedModel: (arm: string) => string = () => GLOBAL.model, servedEnv: Record<string, string> = SERVED_ENV): Recorder {
  const npmCalls: Array<[string, string[]]> = [];
  const evalCalls: RunEvalOptions[] = [];
  const pythonCalls: Array<[string, string[]]> = [];
  const deps: LiveCompareDeps = {
    listProfiles: async () => [GLOBAL, LAW],
    npm: (script, args) => {
      npmCalls.push([script, args]);
      if (script === 'rag:embedding' && args[0] === 'bind') {
        return { status: 0, stdout: `[Embedding] binding ${BINDING_ID} ${DOC} (deployment) → ${LAW.id} status=available\n` };
      }
      if (script === 'rag:reembed' && !args.includes('--dry-run')) {
        return { status: 0, stdout: `[Re-embed] completed: run ${RUN_ID} wrote 4 chunks in 1 batches, 40 tokens reported by the provider\n` };
      }
      return { status: 0, stdout: '' };
    },
    runEval: async (options) => {
      evalCalls.push(options);
      fs.mkdirSync(options.outDir, { recursive: true });
      const arm = path.basename(options.outDir);
      const tracesPath = path.join(options.outDir, 'traces.jsonl');
      const trace = { item_id: 'item-1', effective_config: { embedding_model: servedModel(arm), rag_env: servedEnv } };
      fs.writeFileSync(tracesPath, `${JSON.stringify(trace)}\n`);
      const runPath = path.join(options.outDir, 'run.json');
      fs.writeFileSync(runPath, '{}\n');
      return { tracesPath, runPath, manifest: { effective_config_hash: 'e'.repeat(64) } } as unknown as RunEvalResult;
    },
    python: (module, args) => {
      pythonCalls.push([module, args]);
      return 0;
    },
    catalogEntry: (provider, model) =>
      provider === 'voyage' && model === LAW.model ? { model, usdPerMillionTokens: 0.12, supportedLanguages: ['en'] } : undefined,
    catalogVersion: 1,
    log: () => undefined,
  };
  return { deps, npmCalls, evalCalls, pythonCalls };
}

describe('run-binding-compare --base-url (real deployment)', () => {
  let tmp: string;
  let golden: string;
  let live: typeof import('../eval/harness/binding-compare-live.mts');
  let harness: typeof import('../eval/harness/run-binding-compare.mts');

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-compare-live-'));
    golden = path.join(tmp, 'golden.jsonl');
    fs.writeFileSync(golden, '{"id":"item-1"}\n');
    live = await import('../eval/harness/binding-compare-live.mts');
    harness = await import('../eval/harness/run-binding-compare.mts');
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const args = (outDir: string, confirmCost = true) => ({
    docType: DOC,
    candidates: [LAW.id],
    golden,
    outDir,
    baseUrl: 'https://app.example.test',
    confirmCost,
    organizationId: null,
    userId: null,
  });

  test('argument parsing: --base-url needs --golden and --candidates and refuses --live and the baseline modes', () => {
    const parsed = harness.parseBindingCompareArgs([
      '--doc-type', DOC, '--base-url', 'https://app.example.test', '--golden', golden, '--candidates', LAW.id, '--confirm-cost',
    ]);
    assert.equal(parsed.baseUrl, 'https://app.example.test');
    assert.equal(parsed.live, false);
    assert.throws(() => harness.parseBindingCompareArgs(['--doc-type', DOC, '--base-url', 'https://a.test', '--candidates', LAW.id]), /--golden/);
    assert.throws(() => harness.parseBindingCompareArgs(['--doc-type', DOC, '--base-url', 'https://a.test', '--golden', golden]), /--candidates/);
    assert.throws(
      () => harness.parseBindingCompareArgs(['--doc-type', DOC, '--base-url', 'https://a.test', '--golden', golden, '--candidates', LAW.id, '--live']),
      /always live/,
    );
    assert.throws(() => harness.parseBindingCompareArgs(['--baseline-only', '--base-url', 'https://a.test']), /base-url|baseline/);
    assert.throws(() => harness.parseBindingCompareArgs(['--doc-type', DOC, '--org', '00000000-0000-4000-8000-000000000001']), /--base-url/);
  });

  test('without --confirm-cost: dry runs only, exit 4, nothing bound, re-embedded or evaluated', async () => {
    const rec = recorder(tmp);
    const code = await live.runLiveDeploymentCompare(args(path.join(tmp, 'dry'), false), rec.deps);
    assert.equal(code, live.EXIT_COST_NOT_CONFIRMED);
    assert.deepEqual(rec.npmCalls, [['rag:reembed', ['--profile', LAW.id, '--dry-run']]]);
    assert.equal(rec.evalCalls.length, 0);
    assert.equal(rec.pythonCalls.length, 0);
  });

  test('the global profile is never a fake: no fixture embedder, every arm through --base-url, the comparison is a live-deployment one', async () => {
    const rec = recorder(tmp);
    const out = path.join(tmp, 'run');
    const code = await live.runLiveDeploymentCompare(args(out), rec.deps);
    assert.equal(code, 0);

    assert.deepEqual(
      rec.npmCalls.map(([script, a]) => `${script} ${a.join(' ')}`),
      [
        `rag:reembed --profile ${LAW.id} --dry-run`,
        `rag:embedding bind ${DOC} ${LAW.id}`,
        `rag:embedding bind-status ${BINDING_ID} backfilling`,
        `rag:reembed --profile ${LAW.id}`,
        `rag:embedding bind-status ${BINDING_ID} available`,
      ],
    );
    assert.deepEqual(
      rec.evalCalls.map((call) => [path.basename(call.outDir), call.baseUrl, call.ingestFixture, call.retainInProcess, call.fixtureMode]),
      [
        ['baseline', 'https://app.example.test', undefined, undefined, undefined],
        ['control', 'https://app.example.test', undefined, undefined, undefined],
        [`candidate-${LAW.id}`, 'https://app.example.test', undefined, undefined, undefined],
      ],
    );
    assert.deepEqual(rec.evalCalls[0]!.requestOptions, {});
    assert.deepEqual(rec.evalCalls[1]!.requestOptions, { domain_control_leg: DOC });
    assert.deepEqual(rec.evalCalls[2]!.requestOptions, { embedding_bindings: { [DOC]: LAW.id } });

    const compareCall = rec.pythonCalls.find(([module]) => module === 'rag_eval.binding_compare_cli');
    assert.ok(compareCall, 'binding_compare_cli ran');
    const cliArgs = compareCall[1];
    assert.ok(cliArgs.includes('--live-deployment'));
    assert.ok(!cliArgs.includes('--fixture-embedder'));
    assert.equal(cliArgs[cliArgs.indexOf('--baseline-profile') + 1], GLOBAL.id);
    assert.equal(cliArgs[cliArgs.indexOf('--reembed-run') + 1], `${LAW.id}=${RUN_ID}`);
    assert.equal(rec.pythonCalls.filter(([module]) => module === 'rag_eval.runner').length, 3);
  });

  test('the live path never reaches a fixture database, fixture env or fixture embedder', () => {
    const liveSource = fs.readFileSync(path.join(process.cwd(), 'eval/harness/binding-compare-live.mts'), 'utf8');
    for (const name of [
      "'./fixture-embedder",
      "'./ingest-fakes",
      "'./ingest-mode",
      "'./process-env",
      'setEmbeddingProvidersForTests',
      'buildIngestFixtureDatabase',
      'setEvalScoreCalibration',
      "'--fixture-embedder'",
    ]) {
      assert.ok(!liveSource.includes(name), `binding-compare-live.mts does not reference ${name}`);
    }
    const harnessSource = fs.readFileSync(path.join(process.cwd(), 'eval/harness/run-binding-compare.mts'), 'utf8');
    const mainBody = harnessSource.slice(harnessSource.indexOf('async function main('));
    const liveBranch = mainBody.indexOf('if (args.baseUrl !== null) return liveDeploymentMain(args);');
    assert.ok(liveBranch > 0, 'main() branches to the live path');
    for (const name of ['installFixtureEmbedders()', 'buildIngestFixtureDatabase(', 'applyFixtureProcessEnv(', 'RAG_EVAL_SECRET = crypto']) {
      const at = mainBody.indexOf(name);
      assert.ok(at > liveBranch, `${name} comes after the live branch in main()`);
    }
    const liveMain = harnessSource.slice(harnessSource.indexOf('async function liveDeploymentMain('), harnessSource.indexOf('async function main('));
    for (const name of ['installFixtureEmbedders', 'buildIngestFixtureDatabase', 'applyFixtureProcessEnv', 'randomBytes', '--fixture-embedder']) {
      assert.ok(!liveMain.includes(name), `liveDeploymentMain does not reference ${name}`);
    }
  });

  test('a trace served by the fixture embedder, or by another model, refuses the comparison before binding_compare_cli', async () => {
    for (const model of ['fixture-ngram', 'some-other-model']) {
      const rec = recorder(tmp, (arm) => (arm === 'baseline' ? model : GLOBAL.model));
      await assert.rejects(live.runLiveDeploymentCompare(args(path.join(tmp, `fake-${model}`)), rec.deps), /not the active global model/);
      assert.equal(rec.pythonCalls.length, 0);
    }
  });

  test('a deployment not on v2 with domain bindings on refuses the comparison', async () => {
    const rec = recorder(tmp, () => GLOBAL.model, { ...SERVED_ENV, RAG_DOMAIN_EMBEDDINGS: 'off' });
    await assert.rejects(live.runLiveDeploymentCompare(args(path.join(tmp, 'off')), rec.deps), /RAG_DOMAIN_EMBEDDINGS=off/);
  });

  test('no single active global profile, or the global profile named as a candidate, is refused', async () => {
    const none = recorder(tmp);
    none.deps.listProfiles = async () => [LAW];
    await assert.rejects(live.runLiveDeploymentCompare(args(path.join(tmp, 'none')), none.deps), /0 active global profiles/);
    const self = recorder(tmp);
    await assert.rejects(live.runLiveDeploymentCompare({ ...args(path.join(tmp, 'self')), candidates: [GLOBAL.id] }, self.deps), /not a candidate/);
  });
});
