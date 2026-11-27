import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { FIXTURE_PINNED_NAMES, OverlayError, loadEnvOverlay, parseEnvOverlay } from '../../eval/harness/env-overlay.mts';
import { applyFixtureProcessEnv } from '../../eval/harness/process-env.mts';

// Phase 5.3 D-13: the fixture smoke tier answers with the instruction-sensitive fake generator (--answers) and runs proposed settings
// (--env-overlay). A prompt overlay without a refusal directive must fail the false-answer ceiling, with no model call.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const GATES = 'eval/config/quality-gates.json';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-gate-prompt-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeOverlay(name: string, env: Record<string, unknown>): string {
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ env }));
  return file;
}

function runSmoke(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'eval/harness/run-smoke.mts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface GateCheck {
  check: string;
  slice: string;
  result: string;
}

function overallFalseAnswer(outDir: string): GateCheck | undefined {
  const gate = JSON.parse(fs.readFileSync(path.join(outDir, 'gate.json'), 'utf8')) as { absolute?: { checks?: GateCheck[] } };
  return gate.absolute?.checks?.find((check) => check.check === 'false_answer_rate' && check.slice === 'overall');
}

const NO_DIRECTIVE = {
  RAG_PRE_CONTEXT: 'You are a helpful assistant with access to a knowledge base.',
  RAG_POST_CONTEXT: 'Answer concisely and cite the documents.',
};

describe('--answers with a prompt overlay (D-13, success criterion 2)', () => {
  test('without a refusal directive false_answer_rate fails on overall; the default prompt passes the same check', () => {
    const withOverlay = path.join(tmp, 'no-directive');
    const overlay = runSmoke([
      '--answers',
      '--env-overlay',
      writeOverlay('no-directive', NO_DIRECTIVE),
      '--gates',
      GATES,
      '--gates-mode',
      'report',
      '--out',
      withOverlay,
    ]);
    assert.ok(fs.existsSync(path.join(withOverlay, 'gate.json')), `no gate.json: ${overlay.stderr.slice(-2000)}`);
    assert.equal(overallFalseAnswer(withOverlay)?.result, 'failed');

    const report = JSON.parse(fs.readFileSync(path.join(withOverlay, 'overlay-report.json'), 'utf8'));
    assert.deepEqual(report, { schema_version: 1, evaluated: ['RAG_POST_CONTEXT', 'RAG_PRE_CONTEXT'], not_evaluated: [] });

    const withDefault = path.join(tmp, 'default-prompt');
    const plain = runSmoke(['--answers', '--gates', GATES, '--gates-mode', 'report', '--out', withDefault]);
    assert.ok(fs.existsSync(path.join(withDefault, 'gate.json')), `no gate.json: ${plain.stderr.slice(-2000)}`);
    assert.equal(overallFalseAnswer(withDefault)?.result, 'passed');
    assert.equal(fs.existsSync(path.join(withDefault, 'overlay-report.json')), false);

    const run = JSON.parse(fs.readFileSync(path.join(withDefault, 'run.json'), 'utf8')) as { request_options: { generator_model?: string } };
    assert.equal(run.request_options.generator_model, 'fake/instruction-sensitive-v1');
  });
});

describe('--env-overlay validation', () => {
  test('a name outside the RAG-affecting list is refused with exit 2 and the name listed', () => {
    const result = runSmoke(['--env-overlay', writeOverlay('outside', { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1' }), '--out', path.join(tmp, 'x')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not allowed in --env-overlay: NEXT_PUBLIC_SUPABASE_URL/);
  });

  test('a secret name is refused with exit 2 and the name listed', () => {
    const result = runSmoke(['--env-overlay', writeOverlay('secret', { COHERE_API_KEY: 'placeholder' }), '--out', path.join(tmp, 'y')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /secrets cannot be set/);
    assert.match(result.stderr, /COHERE_API_KEY/);
  });

  test('the overlay is refused together with --base-url', () => {
    const result = runSmoke(['--env-overlay', writeOverlay('base', NO_DIRECTIVE), '--base-url', 'https://example.invalid', '--out', path.join(tmp, 'z')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--env-overlay applies to in-process runs only/);
  });

  test('chat model, embedding model and reranker endpoint changes are listed as not evaluated with reason codes, not applied', () => {
    const overlay = parseEnvOverlay({
      env: {
        NEXT_PUBLIC_OPENROUTER_MODELS: '[]',
        OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
        COHERE_BASE_URL: 'https://api.cohere.com',
        NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant',
        RAG_PRE_CONTEXT: 'Synthetic preamble.',
      },
    });
    assert.deepEqual(overlay.env, { RAG_PRE_CONTEXT: 'Synthetic preamble.' });
    assert.deepEqual(overlay.evaluated, ['RAG_PRE_CONTEXT']);
    assert.deepEqual(overlay.notEvaluated, [
      { name: 'COHERE_BASE_URL', reason: 'no_credentials' },
      { name: 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', reason: 'fixture_pin' },
      { name: 'NEXT_PUBLIC_OPENROUTER_MODELS', reason: 'fake_generator' },
      { name: 'OPENAI_EMBEDDING_MODEL', reason: 'fixture_embedder' },
    ]);
  });

  test('every fixture pin is a not-evaluated name, never applied', () => {
    for (const name of FIXTURE_PINNED_NAMES) {
      const overlay = parseEnvOverlay({ env: { [name]: 'x' } }, new Set([name]));
      assert.deepEqual(overlay.env, {}, name);
      assert.equal(overlay.notEvaluated.length, 1, name);
    }
  });

  test('non-string values, URLs with credentials and unknown top-level keys are refused', () => {
    assert.throws(() => parseEnvOverlay({ env: { RAG_PIPELINE: 2 } }), OverlayError);
    assert.throws(() => parseEnvOverlay({ env: { QDRANT_URL: 'https://user:pass@example.invalid' } }), OverlayError);
    assert.throws(() => parseEnvOverlay({ env: {}, extra: {} }), OverlayError);
    const file = path.join(tmp, 'broken.json');
    fs.writeFileSync(file, '{');
    assert.throws(() => loadEnvOverlay(file), OverlayError);
  });

  test('the fixture pins are set again after the overlay', () => {
    const saved = { ...process.env };
    try {
      applyFixtureProcessEnv({
        edgeUrl: 'http://127.0.0.1:9',
        deploymentMode: 'single-tenant',
        extra: { OPENAI_EMBEDDING_MODEL: 'other', COHERE_BASE_URL: 'https://api.cohere.com', RAG_SUPPORTED_LANGUAGES: 'en' },
        reapplyFixturePins: true,
      });
      const fixture = fixtureProcessEnv('http://127.0.0.1:9');
      assert.equal(process.env.OPENAI_EMBEDDING_MODEL, 'text-embedding-3-small');
      assert.equal(process.env.COHERE_BASE_URL, fixture.COHERE_BASE_URL);
      assert.equal(process.env.RAG_SUPPORTED_LANGUAGES, fixture.RAG_SUPPORTED_LANGUAGES);
      assert.equal(process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE, 'single-tenant');
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
