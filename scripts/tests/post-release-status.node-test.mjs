import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusFromResult, postStatus, main, STATUS_CONTEXT } from '../ci/post-release-status.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'post-release-status.mjs');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const TOKEN = 'placeholder-token-value';

function part(name, result, reason) {
  return reason === undefined ? { part: name, result, reason: null } : { part: name, result, reason };
}

function result(overrides = {}) {
  return {
    sha: SHA,
    result: 'passed',
    skip_reason: null,
    parts: [
      part('nightly_absolute', 'passed'),
      part('judge_floors', 'passed'),
      part('ship_check', 'not_applicable'),
      part('pr_smoke', 'passed'),
    ],
    gate_file_hashes: {},
    changed_gate_files: [],
    source: 'ci',
    actor: null,
    override_reason: null,
    report_hashes: {},
    created_at: '2026-11-27T00:00:00Z',
    ...overrides,
  };
}

function overrideResult(overrides = {}) {
  return result({
    source: 'override',
    actor: 'octo-admin',
    override_reason: 'synthetic emergency reason for the test',
    parts: [part('nightly_absolute', 'skipped', 'overridden'), part('judge_floors', 'skipped', 'overridden')],
    ...overrides,
  });
}

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-release-status-'));
  const file = path.join(dir, 'release-gate.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

function fakeFetch(status = 201) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status };
  };
  return { fetch, calls };
}

function capture() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
}

const ENV = { GITHUB_REPOSITORY: 'example-owner/example-repo', GATE_SHA: SHA, GH_TOKEN: TOKEN, GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '4242' };
const RUN_URL = 'https://github.com/example-owner/example-repo/actions/runs/4242';

test('passed is success', () => {
  assert.deepEqual(statusFromResult(result(), SHA), { state: 'success', description: 'passed' });
});

test('a verified override is success naming the actor', () => {
  assert.deepEqual(statusFromResult(overrideResult(), SHA), { state: 'success', description: 'override by octo-admin' });
});

test('an override without actor or reason is not success', () => {
  assert.deepEqual(statusFromResult(overrideResult({ actor: null }), SHA), { state: 'failure', description: 'error: no result' });
  assert.deepEqual(statusFromResult(overrideResult({ override_reason: null }), SHA), { state: 'failure', description: 'error: no result' });
  assert.deepEqual(statusFromResult(overrideResult({ actor: 'bad actor; rm' }), SHA), { state: 'failure', description: 'error: no result' });
});

test('failed names the failed parts', () => {
  const failed = result({
    result: 'failed',
    parts: [
      part('nightly_absolute', 'failed', 'composition'),
      part('judge_floors', 'failed', 'floor_not_met'),
      part('ship_check', 'not_applicable'),
      part('pr_smoke', 'passed'),
    ],
  });
  assert.deepEqual(statusFromResult(failed, SHA), { state: 'failure', description: 'failed: nightly_absolute,judge_floors' });
});

test('skipped is failure with its reason', () => {
  const skipped = result({
    result: 'skipped',
    skip_reason: 'judge_keys_missing',
    parts: [
      part('nightly_absolute', 'skipped', 'judge_keys_missing'),
      part('judge_floors', 'skipped', 'judge_keys_missing'),
      part('ship_check', 'not_applicable'),
      part('pr_smoke', 'passed'),
    ],
  });
  assert.deepEqual(statusFromResult(skipped, SHA), { state: 'failure', description: 'skipped: judge_keys_missing' });
});

test('a passed result with a skipped or failed part is not success', () => {
  const inconsistent = result({ parts: [part('nightly_absolute', 'skipped', 'judge_keys_missing')] });
  assert.equal(statusFromResult(inconsistent, SHA).state, 'failure');
  const failedPart = result({ parts: [part('nightly_absolute', 'failed', 'composition')] });
  assert.equal(statusFromResult(failedPart, SHA).state, 'failure');
});

test('descriptions over 100 characters are cut', () => {
  const skipped = result({ result: 'skipped', skip_reason: 'x'.repeat(200), parts: [part('nightly_absolute', 'skipped', 'x')] });
  const status = statusFromResult(skipped, SHA);
  assert.equal(status.state, 'failure');
  assert.ok(status.description.length <= 100, `length ${status.description.length}`);
  assert.ok(status.description.startsWith('skipped: xxx'));
});

test('no result, a bad sha or another commit is error: no result', () => {
  const noResult = { state: 'failure', description: 'error: no result' };
  assert.deepEqual(statusFromResult(null, SHA), noResult);
  assert.deepEqual(statusFromResult('text', SHA), noResult);
  assert.deepEqual(statusFromResult(result({ sha: 'abc' }), 'abc'), noResult);
  assert.deepEqual(statusFromResult(result({ sha: 'A'.repeat(40) }), 'A'.repeat(40)), noResult);
  assert.deepEqual(statusFromResult(result({ sha: OTHER_SHA }), SHA), noResult);
  assert.deepEqual(statusFromResult(result({ result: 'unknown' }), SHA), noResult);
  assert.deepEqual(statusFromResult(result({ parts: [] }), SHA), noResult);
});

test('postStatus sends one statuses request with the context', async () => {
  const { fetch, calls } = fakeFetch(201);
  const status = await postStatus({ repo: 'example-owner/example-repo', sha: SHA, state: 'failure', description: 'error: no result', token: TOKEN, targetUrl: RUN_URL, fetch });
  assert.equal(status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/example-owner/example-repo/statuses/${SHA}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(calls[0].body, { state: 'failure', context: STATUS_CONTEXT, description: 'error: no result', target_url: RUN_URL });
  assert.equal(STATUS_CONTEXT, 'rag-release-gate');
});

test('main posts the mapped status once and returns 0 on 201', async () => {
  const file = tmpFile(JSON.stringify(result()));
  const { fetch, calls } = fakeFetch(201);
  const out = capture();
  const code = await main([file], ENV, { fetch, ...out });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { state: 'success', context: 'rag-release-gate', description: 'passed', target_url: RUN_URL });
  assert.ok(!out.lines.join('\n').includes(TOKEN));
});

test('main posts failure for a missing or invalid result file', async () => {
  for (const file of [tmpFile(undefined), tmpFile('{not json')]) {
    const { fetch, calls } = fakeFetch(201);
    const code = await main([file], ENV, { fetch, ...capture() });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.state, 'failure');
    assert.equal(calls[0].body.description, 'error: no result');
  }
});

test('main returns 1 on any answer other than 201 and never prints the token', async () => {
  const file = tmpFile(JSON.stringify(result()));
  for (const status of [200, 403, 422, 500]) {
    const { fetch, calls } = fakeFetch(status);
    const out = capture();
    assert.equal(await main([file], ENV, { fetch, ...out }), 1);
    assert.equal(calls.length, 1);
    assert.ok(!out.lines.join('\n').includes(TOKEN));
  }
  const out = capture();
  const throwing = async () => {
    throw new Error(`boom ${TOKEN}`);
  };
  assert.equal(await main([file], ENV, { fetch: throwing, ...out }), 1);
  assert.ok(!out.lines.join('\n').includes(TOKEN));
});

test('main refuses to post without token, repository or a valid GATE_SHA', async () => {
  const file = tmpFile(JSON.stringify(result()));
  for (const env of [
    { ...ENV, GH_TOKEN: '' },
    { ...ENV, GITHUB_REPOSITORY: '' },
    { ...ENV, GITHUB_REPOSITORY: 'not a repo/../x' },
    { ...ENV, GATE_SHA: 'main' },
    { ...ENV, GATE_SHA: '' },
    { ...ENV, GITHUB_RUN_ID: '' },
    { ...ENV, GITHUB_RUN_ID: '12; rm' },
    { ...ENV, GITHUB_SERVER_URL: 'http://github.com' },
  ]) {
    const { fetch, calls } = fakeFetch(201);
    assert.equal(await main([file], env, { fetch, ...capture() }), 1);
    assert.equal(calls.length, 0);
  }
});

test('the script posts the status of a result file when spawned', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const skipped = result({
    result: 'skipped',
    skip_reason: 'judge_keys_missing',
    parts: [part('nightly_absolute', 'skipped', 'judge_keys_missing'), part('judge_floors', 'skipped', 'judge_keys_missing')],
  });
  const file = tmpFile(JSON.stringify(skipped));
  const child = await new Promise((resolve) => {
    const proc = spawnSync; // keep the event loop free for the server below
    void proc;
    import('node:child_process').then(({ spawn }) => {
      const p = spawn(process.execPath, [SCRIPT, file], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, ...ENV, GITHUB_API_URL: `http://127.0.0.1:${port}` },
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  });
  server.close();
  assert.equal(child.status, 0, child.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/repos/example-owner/example-repo/statuses/${SHA}`);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { state: 'failure', context: 'rag-release-gate', description: 'skipped: judge_keys_missing', target_url: RUN_URL });
  assert.ok(!`${child.stdout}${child.stderr}`.includes(TOKEN));
});
