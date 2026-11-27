import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gate = require('../config-server-rag-gate.js');
const { isSecretName } = require('../../src/lib/rag/config-gate/secret-name.cjs');
const { createRagGateRunner, CHECK_TIMEOUT_MS, CHILD_ENV_ALLOWLIST } = gate;

const PROMPT = 'Synthetic proposed instruction text without any directive 7f3a';
const SECRET_VALUE = 'placeholder-secret-value-0000';
const PROVIDER_KEY = 'placeholder-provider-key-1111';
const EVAL_SECRET = 'placeholder-eval-secret-2222-placeholder';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-gate-'));
  fs.mkdirSync(path.join(root, 'eval/fixtures'), { recursive: true });
  fs.mkdirSync(path.join(root, 'eval/reports/phase-05.3'), { recursive: true });
  const golden = [];
  for (const language of ['en', 'it', 'zh']) {
    for (let i = 0; i < 14; i += 1) golden.push({ id: `${language}-a-${i}`, language, answerable: true, question: `q ${i}` });
    for (let i = 0; i < 3; i += 1) golden.push({ id: `${language}-n-${i}`, language, answerable: false, question: `n ${i}` });
  }
  fs.writeFileSync(path.join(root, 'eval/fixtures/golden.jsonl'), `${golden.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const record = {
    schema_version: 1,
    tiers: [
      {
        name: 'smoke',
        stage: 'after',
        checks: [
          { check: 'false_answer_rate', slice: 'overall', result: 'passed' },
          { check: 'false_refusal_rate', slice: 'overall', result: 'failed' },
        ],
      },
      { name: 'smoke', stage: 'before', checks: [{ check: 'false_answer_rate', slice: 'overall', result: 'failed' }] },
    ],
  };
  fs.writeFileSync(path.join(root, 'eval/reports/phase-05.3/absolute-gate-measurement.json'), JSON.stringify(record));
  return root;
}

function row(check, slice, result) {
  return { check, slice, measured: result === 'failed' ? 0.4 : 0, numerator: 1, denominator: 10, limit: 0.05, limit_kind: 'max', result, reason: result === 'failed' ? `${check}_exceeded` : null };
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A fake child_process.spawn: each call is matched to a script and answered by the handler for it. */
function fakeSpawn(handlers = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, signal || 'SIGTERM'));
      return true;
    };
    const joined = args.join(' ');
    const script = joined.includes('run-smoke.mts')
      ? 'smoke'
      : joined.includes('run-nightly.mts')
        ? 'nightly'
        : joined.includes('pending-cli.ts')
          ? 'pending'
          : joined.includes('rag_eval.runner')
            ? 'score'
            : joined.includes('rag_eval.absolute_gate')
              ? 'absolute'
              : 'other';
    const call = { command, args: [...args], options, script, files: {} };
    for (const flag of ['--env-overlay', '--golden', '--run-config', '--current', '--proposed']) {
      const file = argAfter(args, flag);
      const resolved = file ? path.resolve(options.cwd || '.', file) : null;
      if (resolved && fs.existsSync(resolved)) call.files[flag] = fs.readFileSync(resolved, 'utf8');
    }
    calls.push(call);
    const handler = handlers[script] || defaultHandlers[script];
    setImmediate(() => {
      try {
        handler(call, child);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  };
  return { spawn, calls };
}

function exit(child, code) {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code, null);
}

function outOf(call) {
  return path.resolve(call.options.cwd || '.', argAfter(call.args, '--out'));
}

function writeGate(call, checks) {
  const out = outOf(call);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'gate.json'), JSON.stringify({ absolute: { passed: true, checks } }));
}

const defaultHandlers = {
  smoke(call, child) {
    const out = outOf(call);
    fs.mkdirSync(out, { recursive: true });
    if (call.args.includes('--base-url')) {
      fs.writeFileSync(path.join(out, 'report.json'), '{}');
      return exit(child, 0);
    }
    writeGate(call, [row('false_answer_rate', 'overall', 'passed')]);
    fs.writeFileSync(
      path.join(out, 'overlay-report.json'),
      JSON.stringify({ schema_version: 1, evaluated: ['RAG_PRE_CONTEXT'], not_evaluated: [{ name: 'NEXT_PUBLIC_OPENROUTER_MODELS', reason: 'fake_generator' }] }),
    );
    exit(child, 0);
  },
  nightly(call, child) {
    const out = outOf(call);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'traces.jsonl'), '');
    fs.writeFileSync(path.join(out, 'run.json'), '{}');
    exit(child, 0);
  },
  score(call, child) {
    const out = outOf(call);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.json'), '{}');
    exit(child, 0);
  },
  absolute(call, child) {
    const out = outOf(call);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'absolute.json'), JSON.stringify({ passed: true, checks: [row('false_answer_rate', 'overall', 'passed')] }));
    exit(child, 0);
  },
  pending(call, child) {
    child.stdout.write(JSON.stringify({ uncalibrated_cells: ['cohere|rerank-v3|en'] }));
    exit(child, 0);
  },
  other(call, child) {
    exit(child, 0);
  },
};

function baseEnv(extra = {}) {
  return {
    RAG_CONFIG_GATE: 'enforce',
    RAG_PRE_CONTEXT: 'Current instruction text',
    OPENROUTER_API_KEY: PROVIDER_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SECRET_VALUE,
    OPENAI_API_KEY: SECRET_VALUE,
    RAG_EVAL_SECRET: EVAL_SECRET,
    NEXT_PUBLIC_AI_PROVIDER: 'openrouter',
    NEXT_PUBLIC_OPENROUTER_MODELS: '[{"id":"vendor/model-a","displayName":"A","isDefault":true}]',
    ...extra,
  };
}

function makeRunner(root, { env = baseEnv(), handlers, timeoutMs, toolchain, processEnv, appBaseUrl } = {}) {
  const fake = fakeSpawn(handlers);
  let clock = Date.parse('2026-11-27T10:00:00Z');
  const runner = createRagGateRunner({
    repoRoot: root,
    spawn: fake.spawn,
    now: () => clock,
    readCurrentEnv: () => ({ ...env }),
    timeoutMs,
    toolchain: toolchain || (() => ({ tsx: true, uv: true })),
    processEnv: processEnv || { PATH: '/usr/bin', HOME: '/home/operator', LANG: 'C.UTF-8', AWS_SECRET_ACCESS_KEY: SECRET_VALUE, NODE_OPTIONS: '--require x' },
    appBaseUrl: appBaseUrl || (() => 'http://localhost:3000'),
  });
  return { runner, fake, advance: (ms) => (clock += ms) };
}

async function runToEnd(runner, input) {
  const started = await runner.start(input);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await runner.idle();
  return runner.get(started.body.check_id);
}

const promptChange = { kind: 'prompt', prompt: { preContext: PROMPT } };

test('constants', () => {
  assert.equal(CHECK_TIMEOUT_MS, 600000);
  assert.ok(CHILD_ENV_ALLOWLIST.includes('PATH'));
  assert.ok(!CHILD_ENV_ALLOWLIST.some((name) => isSecretName(name)));
});

test('mode off answers required false and spawns nothing', async () => {
  const root = tempRoot();
  const { runner, fake } = makeRunner(root, { env: baseEnv({ RAG_CONFIG_GATE: 'off' }) });
  const result = await runner.start(promptChange);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { required: false, mode: 'off' });
  assert.equal(fake.calls.length, 0);
});

test('a change of no RAG-affecting key answers required false and spawns nothing', async () => {
  const root = tempRoot();
  const { runner, fake } = makeRunner(root);
  const result = await runner.start({ kind: 'config', config: { NEXT_PUBLIC_THEME_SETTING_XYZ: 'dark' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.required, false);
  assert.equal(fake.calls.length, 0);
});

test('202, busy 409 while running, cached 200 afterwards, force starts a new run', async () => {
  const root = tempRoot();
  let release;
  const gateOpen = new Promise((resolve) => (release = resolve));
  const handlers = {
    smoke(call, child) {
      gateOpen.then(() => defaultHandlers.smoke(call, child));
    },
  };
  const { runner, fake } = makeRunner(root, { handlers });
  const first = await runner.start(promptChange);
  assert.equal(first.status, 202);
  assert.match(first.body.check_id, /^[0-9a-f-]{36}$/);
  const busy = await runner.start(promptChange);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'rag_gate_busy');
  assert.equal(typeof busy.body.running_since, 'string');
  release();
  await runner.idle();
  const done = runner.get(first.body.check_id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'pass');
  const smokeCalls = fake.calls.filter((call) => call.script === 'smoke').length;
  const cached = await runner.start(promptChange);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.cached, true);
  assert.equal(cached.body.check_id, first.body.check_id);
  assert.equal(fake.calls.filter((call) => call.script === 'smoke').length, smokeCalls);
  const forced = await runner.start({ ...promptChange, force: true });
  assert.equal(forced.status, 202);
  assert.notEqual(forced.body.check_id, first.body.check_id);
  await runner.idle();
});

test('deterministic layer: smoke child with overlay, gates and report mode, no shell', async () => {
  const root = tempRoot();
  const { runner, fake } = makeRunner(root);
  const check = await runToEnd(runner, promptChange);
  const smoke = fake.calls.find((call) => call.script === 'smoke');
  assert.equal(smoke.command, process.execPath);
  assert.deepEqual(smoke.args.slice(0, 3), ['--import', 'tsx', 'eval/harness/run-smoke.mts']);
  assert.equal(argAfter(smoke.args, '--gates'), 'eval/config/quality-gates.json');
  assert.equal(argAfter(smoke.args, '--gates-mode'), 'report');
  assert.notEqual(smoke.options.shell, true);
  assert.deepEqual(JSON.parse(smoke.files['--env-overlay']), { env: { RAG_PRE_CONTEXT: PROMPT } });
  for (const call of fake.calls) assert.ok(!call.args.join(' ').includes(PROMPT), 'no proposed value on a command line');
  assert.deepEqual(check.changed_keys, ['RAG_PRE_CONTEXT']);
  assert.equal(check.layers[0].layer, 'deterministic');
  assert.equal(check.layers[0].result, 'pass');
  assert.deepEqual(check.not_evaluated, [{ key: 'NEXT_PUBLIC_OPENROUTER_MODELS', reason: 'fake_generator' }]);
  assert.deepEqual(check.uncalibrated_cells, ['cohere|rerank-v3|en']);
});

test('a failed check the measurement record shows passing fails the check', async () => {
  const root = tempRoot();
  const handlers = {
    smoke(call, child) {
      writeGate(call, [row('false_answer_rate', 'overall', 'failed'), row('false_refusal_rate', 'overall', 'passed')]);
      exit(child, 0);
    },
  };
  const { runner } = makeRunner(root, { handlers });
  const check = await runToEnd(runner, promptChange);
  assert.equal(check.layers[0].result, 'fail');
  assert.equal(check.result, 'fail');
  const failed = check.layers[0].checks.find((entry) => entry.check === 'false_answer_rate');
  assert.equal(failed.result, 'failed');
});

test('a failure the measurement record already lists as failing is report_only baseline_failing', async () => {
  const root = tempRoot();
  const handlers = {
    smoke(call, child) {
      writeGate(call, [row('false_answer_rate', 'overall', 'passed'), row('false_refusal_rate', 'overall', 'failed')]);
      exit(child, 0);
    },
  };
  const { runner } = makeRunner(root, { handlers });
  const check = await runToEnd(runner, promptChange);
  const entry = check.layers[0].checks.find((item) => item.check === 'false_refusal_rate');
  assert.equal(entry.result, 'report_only');
  assert.equal(entry.reason, 'baseline_failing');
  assert.equal(check.layers[0].result, 'pass');
  assert.equal(check.result, 'pass');
});

test('a failure on a check the record does not list fails closed', async () => {
  const root = tempRoot();
  const handlers = {
    smoke(call, child) {
      writeGate(call, [row('no_answer_share', 'language:en', 'failed')]);
      exit(child, 0);
    },
  };
  const { runner } = makeRunner(root, { handlers });
  const check = await runToEnd(runner, promptChange);
  assert.equal(check.result, 'fail');
});

test('a child that never exits is killed after the timeout: error timeout', async () => {
  const root = tempRoot();
  let killed = false;
  const handlers = {
    smoke(call, child) {
      const kill = child.kill;
      child.kill = (signal) => {
        killed = true;
        return kill(signal);
      };
    },
  };
  const { runner } = makeRunner(root, { handlers, timeoutMs: 50 });
  const check = await runToEnd(runner, promptChange);
  assert.equal(killed, true);
  assert.equal(check.result, 'error');
  assert.equal(check.error_reason, 'timeout');
  assert.equal(check.status, 'done');
});

test('a spawn ENOENT is toolchain_missing; a missing toolchain spawns nothing', async () => {
  const root = tempRoot();
  const handlers = {
    smoke(call, child) {
      const error = new Error('spawn ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
    },
  };
  const { runner } = makeRunner(root, { handlers });
  const check = await runToEnd(runner, promptChange);
  assert.equal(check.result, 'error');
  assert.equal(check.error_reason, 'toolchain_missing');

  const root2 = tempRoot();
  const second = makeRunner(root2, { toolchain: () => ({ tsx: true, uv: false }) });
  const check2 = await runToEnd(second.runner, promptChange);
  assert.equal(check2.error_reason, 'toolchain_missing');
  assert.equal(second.fake.calls.length, 0);
});

test('a non-zero exit without gate.json is crashed', async () => {
  const root = tempRoot();
  const handlers = {
    smoke(call, child) {
      exit(child, 3);
    },
  };
  const { runner } = makeRunner(root, { handlers });
  const check = await runToEnd(runner, promptChange);
  assert.equal(check.result, 'error');
  assert.equal(check.error_reason, 'crashed');
});

test('live layer: switched_off, no_credentials, and the run when on', async () => {
  const off = makeRunner(tempRoot());
  const checkOff = await runToEnd(off.runner, promptChange);
  assert.equal(checkOff.layers[1].result, 'skipped');
  assert.equal(checkOff.layers[1].reason, 'switched_off');

  const noKey = makeRunner(tempRoot(), { env: baseEnv({ RAG_CONFIG_GATE_LIVE: 'true', OPENROUTER_API_KEY: '' }) });
  const checkNoKey = await runToEnd(noKey.runner, promptChange);
  assert.equal(checkNoKey.layers[1].result, 'skipped');
  assert.equal(checkNoKey.layers[1].reason, 'no_credentials');

  const on = makeRunner(tempRoot(), { env: baseEnv({ RAG_CONFIG_GATE_LIVE: 'true' }) });
  const checkOn = await runToEnd(on.runner, promptChange);
  assert.equal(checkOn.layers[1].result, 'pass');
  const nightly = on.fake.calls.find((call) => call.script === 'nightly');
  assert.equal(argAfter(nightly.args, '--generator'), 'live');
  assert.equal(argAfter(nightly.args, '--generator-model'), 'vendor/model-a');
  assert.ok(argAfter(nightly.args, '--env-overlay'));
  assert.equal(nightly.options.env.OPENROUTER_API_KEY, PROVIDER_KEY);
  const subset = nightly.files['--golden'].trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(subset.filter((item) => item.answerable === false).length, 9);
  for (const language of ['en', 'it', 'zh']) {
    assert.equal(subset.filter((item) => item.answerable === true && item.language === language).length, 10);
  }
  const absolute = on.fake.calls.find((call) => call.script === 'absolute');
  assert.equal(argAfter(absolute.args, '--tier'), 'nightly');
  assert.equal(argAfter(absolute.args, '--mode'), 'report');
});

test('a live failure fails the check', async () => {
  const handlers = {
    absolute(call, child) {
      const out = outOf(call);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'absolute.json'), JSON.stringify({ passed: false, checks: [row('false_refusal_rate', 'overall', 'failed')] }));
      exit(child, 0);
    },
  };
  const { runner } = makeRunner(tempRoot(), { env: baseEnv({ RAG_CONFIG_GATE_LIVE: 'true' }), handlers });
  const check = await runToEnd(runner, promptChange);
  assert.equal(check.layers[1].result, 'fail');
  assert.equal(check.result, 'fail');
});

test('real_set: no_real_set without a private set; runs each set with only expressible names', async () => {
  const none = makeRunner(tempRoot());
  const checkNone = await runToEnd(none.runner, promptChange);
  assert.equal(checkNone.layers[2].result, 'skipped');
  assert.equal(checkNone.layers[2].reason, 'no_real_set');

  const root = tempRoot();
  for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
    const dir = path.join(root, 'eval/golden/private/domain', hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'golden.jsonl'), '{"id":"x"}\n');
  }
  const { runner, fake } = makeRunner(root, { env: baseEnv({ RAG_EVAL_ENDPOINT_ENABLED: 'true' }) });
  const check = await runToEnd(runner, { kind: 'config', config: { RAG_PRE_CONTEXT: PROMPT, RAG_RETRIEVAL_BACKEND: 'qdrant' } });
  const realCalls = fake.calls.filter((call) => call.script === 'smoke' && call.args.includes('--base-url'));
  assert.equal(realCalls.length, 2);
  const runConfig = JSON.parse(realCalls[0].files['--run-config']);
  assert.deepEqual(runConfig.env, {});
  assert.equal(runConfig.overrides.backend, 'qdrant');
  assert.equal(realCalls[0].options.env.RAG_EVAL_SECRET, EVAL_SECRET);
  assert.equal(realCalls[0].options.env.OPENROUTER_API_KEY, undefined);
  assert.ok(check.not_evaluated_on_real_set.includes('RAG_PRE_CONTEXT'));
  assert.ok(!check.not_evaluated_on_real_set.includes('RAG_RETRIEVAL_BACKEND'));
  assert.equal(check.layers[2].result, 'pass');
  assert.ok(check.layers[2].checks.every((entry) => /^(a{8}|b{8}):/.test(entry.slice)));
});

test('child environments come from the allow-list; temporary value files are deleted; the check holds no value', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'eval/golden/private/domain', 'c'.repeat(64));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'golden.jsonl'), '{"id":"x"}\n');
  const { runner, fake } = makeRunner(root, { env: baseEnv({ RAG_CONFIG_GATE_LIVE: 'true', RAG_EVAL_ENDPOINT_ENABLED: 'true' }) });
  const check = await runToEnd(runner, promptChange);
  const allowedSecrets = { nightly: ['OPENROUTER_API_KEY'], smoke: [] };
  for (const call of fake.calls) {
    const env = call.options.env;
    assert.ok(env, 'every child gets an explicit environment');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    const secrets = Object.keys(env).filter((name) => isSecretName(name));
    const realSet = call.script === 'smoke' && call.args.includes('--base-url');
    const allowed = realSet ? ['RAG_EVAL_SECRET'] : allowedSecrets[call.script] || [];
    assert.deepEqual(secrets.sort(), [...allowed].sort(), `${call.script} secrets`);
    for (const name of Object.keys(env)) {
      assert.ok(CHILD_ENV_ALLOWLIST.includes(name) || allowed.includes(name), `${name} not allowed`);
    }
    for (const value of Object.values(env)) assert.notEqual(value, SECRET_VALUE);
  }
  for (const call of fake.calls) {
    for (const flag of ['--env-overlay', '--golden', '--run-config', '--current', '--proposed']) {
      const file = argAfter(call.args, flag);
      if (!file || file.includes('eval/golden/private')) continue;
      assert.equal(fs.existsSync(path.resolve(root, file)), false, `${flag} file still exists`);
    }
  }
  const stored = fs.readFileSync(path.join(root, 'eval/out/config-gate', `${check.check_id}.json`), 'utf8');
  assert.ok(!stored.includes(PROMPT));
  assert.ok(!stored.includes(PROVIDER_KEY));
  assert.ok(!stored.includes(EVAL_SECRET));
});

test('latest returns the newest check; get rejects a malformed id', async () => {
  const root = tempRoot();
  const { runner } = makeRunner(root);
  assert.equal(runner.latest(), null);
  const check = await runToEnd(runner, promptChange);
  assert.equal(runner.latest().check_id, check.check_id);
  assert.equal(runner.get('../etc/passwd'), null);
});
