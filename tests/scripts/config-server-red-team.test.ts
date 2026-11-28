import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * SEC-11 (plan 07-48): the Config UI server's red-team endpoints. Every test injects execFile and fetch, so no process starts and no
 * request leaves the test. Tenant keys, ids and technique labels are synthetic placeholders.
 */

const require = createRequire(import.meta.url);
const express = require('express');
const security = require('../../scripts/config-server-security.js');
const redTeam = require('../../scripts/config-server-red-team.js');

const ADMIN_ID = '00000000-0000-4000-8000-0000000048a1';
const RUN_A = '00000000-0000-4000-8000-0000000048b1';
const RUN_B = '00000000-0000-4000-8000-0000000048b2';
const RUN_C = '00000000-0000-4000-8000-0000000048b3';
const NESTED = '00000000-0000-4000-8000-0000000048c1';
const SECRET_TEXT = 'SYNTHETIC-QUESTION-TEXT-0748';

type ExecCall = { file: string; args: string[]; options: Record<string, unknown>; callback: (error: unknown) => void; child: FakeChild };
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
}

let root: string;
let execCalls: ExecCall[];
let fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
let fetchAnswer: () => Promise<Response>;
let ids: string[];

function writeFile(rel: string, content: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function report(runId: string, startedAt: string, cells: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: 1,
    run_id: runId,
    started_at: startedAt,
    finished_at: startedAt,
    corpus_sha256: 'a'.repeat(64),
    config_hash: 'b'.repeat(16),
    cells,
    successes: [{ item_id: 'item-secret', technique: 'hidden_text', language: 'en', trace_id: 'rt-trace-secret', signals: ['canary'] }],
    questions: [SECRET_TEXT],
    review_items_opened: 2,
    skipped_reason: null,
    ...extra,
  });
}

function makeRunner(overrides: Record<string, unknown> = {}) {
  return redTeam.createRedTeamRunner({
    repoRoot: root,
    execFile: (file: string, args: string[], options: Record<string, unknown>, callback: (error: unknown) => void) => {
      const child = new FakeChild();
      execCalls.push({ file, args, options, callback, child });
      return child;
    },
    fetch: async (url: string, init: Record<string, unknown>) => {
      fetchCalls.push({ url, init });
      return fetchAnswer();
    },
    appBaseUrl: () => 'http://localhost:3000',
    randomUUID: () => ids.shift() ?? RUN_C,
    nodePath: '/usr/bin/node',
    log: () => undefined,
    processEnv: { PATH: '/usr/bin' },
    ...overrides,
  });
}

function adminAnswer() {
  fetchAnswer = async () => new Response(JSON.stringify({ ok: true, adminId: ADMIN_ID }), { status: 200 });
}

function runDirs(): string[] {
  const dir = path.join(root, 'eval/out/red-team');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const adminReq = (body: unknown = {}) => ({ headers: { cookie: 'sb-session=synthetic' }, body });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-team-cs-'));
  execCalls = [];
  fetchCalls = [];
  ids = [RUN_A, RUN_B];
  adminAnswer();
  writeFile('eval/config/runs/sec-recommended.json', '{}');
  writeFile('eval/config/runs/legacy.json', '{}');
  fs.mkdirSync(path.join(root, 'eval/config/runs/nested-dir'), { recursive: true });
  writeFile(
    'config/rag/red-team-techniques.json',
    JSON.stringify({ schema_version: 1, techniques: [{ id: 'hidden_text', label: 'Hidden text' }, { id: 'direct_override' }] }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('startRun: authorize, then spawn', () => {
  it('admin: calls the authorize route with the forwarded session, then starts the runner with execFile and a fixed argument array', async () => {
    const runner = makeRunner();
    const answer = await runner.startRun(adminReq({ runConfig: 'sec-recommended.json' }));
    expect(answer.status).toBe(202);
    expect(answer.body.run).toMatchObject({ id: RUN_A, state: 'running', progress: { done: null, total: null } });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://localhost:3000/api/rag/admin/red-team/authorize');
    expect((fetchCalls[0].init.headers as Record<string, string>).Cookie).toBe('sb-session=synthetic');
    expect(execCalls).toHaveLength(1);
    const call = execCalls[0];
    expect(call.file).toBe('/usr/bin/node');
    expect(call.options.shell).toBe(false);
    expect(call.options.detached).toBe(true);
    expect(call.options.cwd).toBe(root);
    expect(call.args).toEqual([
      '--import',
      'tsx',
      path.join('eval', 'harness', 'run-red-team.mts'),
      'run',
      '--tenant',
      's:default',
      '--out',
      path.join('eval', 'out', 'red-team', RUN_A),
      '--run-config',
      path.join('eval', 'config', 'runs', 'sec-recommended.json'),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'eval/out/red-team', RUN_A, 'status.json'), 'utf8')).state).toBe('running');
  });

  it('the tenant comes from the runner settings file, never from the browser', async () => {
    writeFile(
      'eval/golden/private/red-team-runner.json',
      JSON.stringify({ tenant: 'o:00000000-0000-4000-8000-0000000048d1', deploymentMode: 'multi-tenant', organizationId: '00000000-0000-4000-8000-0000000048d1' }),
    );
    const runner = makeRunner();
    expect((await runner.startRun(adminReq({ tenant: 'u:00000000-0000-4000-8000-0000000048e1' }))).status).toBe(400);
    expect(execCalls).toHaveLength(0);
    const answer = await runner.startRun(adminReq({}));
    expect(answer.status).toBe(202);
    expect(execCalls[0].args.slice(4, 6)).toEqual(['--tenant', 'o:00000000-0000-4000-8000-0000000048d1']);
  });

  for (const [label, status, make] of [
    ['no session', 401, () => new Response('{}', { status: 401 })],
    ['non-admin', 403, () => new Response('{}', { status: 403 })],
    ['lookup failure', 503, () => new Response('{}', { status: 503 })],
    ['200 without an admin id', 503, () => new Response(JSON.stringify({ ok: true }), { status: 200 })],
    ['a redirect', 503, () => new Response(null, { status: 302, headers: { location: '/login' } })],
  ] as const) {
    it(`${label}: answers ${status}, spawns nothing and creates no directory`, async () => {
      fetchAnswer = async () => make();
      const runner = makeRunner();
      const answer = await runner.startRun(adminReq({}));
      expect(answer.status).toBe(status);
      expect(execCalls).toHaveLength(0);
      expect(runDirs()).toEqual([]);
    });
  }

  it('unreachable app: 503, spawns nothing and creates no directory', async () => {
    fetchAnswer = async () => {
      throw new Error('ECONNREFUSED');
    };
    const runner = makeRunner();
    expect((await runner.startRun(adminReq({}))).status).toBe(503);
    expect(execCalls).toHaveLength(0);
    expect(runDirs()).toEqual([]);
  });

  it('non-admin: the authorize answer arrives before any spawn', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchAnswer = () => new Promise<Response>((resolve) => (release = resolve));
    const runner = makeRunner();
    const pending = runner.startRun(adminReq({}));
    await new Promise((r) => setTimeout(r, 10));
    expect(execCalls).toHaveLength(0);
    release(new Response('{}', { status: 403 }));
    expect((await pending).status).toBe(403);
    expect(execCalls).toHaveLength(0);
  });

  for (const runConfig of ['../secret.json', 'nested-dir', 'eval/config/runs/legacy.json', 'missing.json', 7, '..\\legacy.json']) {
    it(`a run config outside eval/config/runs/ is refused with 400: ${String(runConfig)}`, async () => {
      const runner = makeRunner();
      const answer = await runner.startRun(adminReq({ runConfig }));
      expect(answer.status).toBe(400);
      expect(fetchCalls).toHaveLength(0);
      expect(execCalls).toHaveLength(0);
      expect(runDirs()).toEqual([]);
    });
  }

  it('409 while a run is active carries { code: run_active, runningRunId }', async () => {
    const runner = makeRunner();
    expect((await runner.startRun(adminReq({}))).status).toBe(202);
    const second = await runner.startRun(adminReq({}));
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'run_active', runningRunId: RUN_A });
    expect(execCalls).toHaveLength(1);
  });

  it('a finished child frees the slot and records finished; a failing child records failed with an error code', async () => {
    const runner = makeRunner();
    await runner.startRun(adminReq({}));
    writeFile(`eval/out/red-team/${RUN_A}/${NESTED}/report.json`, report(NESTED, '2026-11-01T10:00:00.000Z', [{ technique: 'hidden_text', language: 'en', n: 3, successes: 1 }]));
    execCalls[0].callback(null);
    const finished = runner.runStatus(RUN_A);
    expect(finished.state).toBe('finished');
    expect(finished.progress).toEqual({ done: 3, total: 3 });
    expect((await runner.startRun(adminReq({}))).status).toBe(202);
    execCalls[1].callback(Object.assign(new Error('exit'), { code: 2 }));
    expect(runner.runStatus(RUN_B)).toMatchObject({ state: 'failed', errorCode: 'runner_refused', cells: [] });
  });

  it('progress is counted from the runner output when it states one, else unknown', async () => {
    const runner = makeRunner();
    await runner.startRun(adminReq({}));
    expect(runner.runStatus(RUN_A).progress).toEqual({ done: null, total: null });
    execCalls[0].child.stdout.emit('data', Buffer.from('[Red Team] progress 4/10\n'));
    expect(runner.runStatus(RUN_A).progress).toEqual({ done: 4, total: 10 });
  });
});

describe('status and latest', () => {
  it('status of an unknown id answers null (404); a malformed id too', () => {
    const runner = makeRunner();
    expect(runner.runStatus(RUN_C)).toBeNull();
    expect(runner.runStatus('../../etc')).toBeNull();
  });

  it('status carries ids and counts only, never question, answer, item or trace text', () => {
    writeFile(`eval/out/red-team/${RUN_A}/report.json`, report(RUN_A, '2026-11-01T10:00:00.000Z', [{ technique: 'hidden_text', language: 'en', n: 4, successes: 2 }]));
    const runner = makeRunner();
    const run = runner.runStatus(RUN_A);
    const text = JSON.stringify(run);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain('item-secret');
    expect(text).not.toContain('rt-trace-secret');
    expect(text).not.toContain('a'.repeat(64));
    expect(Object.keys(run).sort()).toEqual(
      ['casesSkippedReason', 'cells', 'errorCode', 'finishedAt', 'id', 'progress', 'reviewCasesOpened', 'startedAt', 'state'].sort(),
    );
    expect(run.cells).toEqual([{ technique: 'hidden_text', techniqueLabel: 'Hidden text', language: 'en', attacks: 4, successes: 2 }]);
    expect(run.reviewCasesOpened).toBe(2);
  });

  it('label: each cell carries the technique label from the techniques file; a technique missing there falls back to its id', () => {
    writeFile(
      `eval/out/red-team/${RUN_A}/report.json`,
      report(RUN_A, '2026-11-01T10:00:00.000Z', [
        { technique: 'hidden_text', language: 'zh', n: 1, successes: 0 },
        { technique: 'direct_override', language: 'it', n: 2, successes: 1 },
        { technique: 'not_listed', language: 'en', n: 1, successes: 1 },
      ]),
    );
    const cells = makeRunner().runStatus(RUN_A).cells;
    expect(cells.map((c: { techniqueLabel: string }) => c.techniqueLabel)).toEqual(['Hidden text', 'direct_override', 'not_listed']);
  });

  it('latest is null (an answer, not an error) when no run directory exists', () => {
    expect(makeRunner().latestRun()).toBeNull();
  });

  it('latest with only finished runs returns the newest; a run left running by a stopped server reads as failed (interrupted)', () => {
    writeFile(`eval/out/red-team/${RUN_A}/report.json`, report(RUN_A, '2026-11-01T10:00:00.000Z', []));
    writeFile(`eval/out/red-team/${RUN_B}/report.json`, report(RUN_B, '2026-11-02T10:00:00.000Z', []));
    writeFile('eval/out/red-team/.workspace/ignored.txt', 'x');
    const runner = makeRunner();
    expect(runner.latestRun().id).toBe(RUN_B);
    writeFile(`eval/out/red-team/${RUN_C}/status.json`, JSON.stringify({ id: RUN_C, state: 'running', startedAt: '2026-11-03T10:00:00.000Z' }));
    expect(runner.latestRun()).toMatchObject({ id: RUN_C, state: 'failed', errorCode: 'interrupted' });
  });

  it('latest returns the running run (state running, progress) even when a newer finished directory exists', async () => {
    const runner = makeRunner({ now: () => Date.parse('2026-11-01T00:00:00.000Z') });
    await runner.startRun(adminReq({}));
    writeFile(`eval/out/red-team/${RUN_C}/report.json`, report(RUN_C, '2026-11-20T10:00:00.000Z', []));
    execCalls[0].child.stdout.emit('data', '[Red Team] progress 1/5\n');
    expect(runner.latestRun()).toMatchObject({ id: RUN_A, state: 'running', progress: { done: 1, total: 5 } });
  });

  it('runConfigs lists only file names, sorted, with no path separator, and ignores subdirectories', () => {
    writeFile('eval/config/runs/.hidden.json', '{}');
    expect(makeRunner().listRunConfigs()).toEqual(['legacy.json', 'sec-recommended.json']);
  });
});

describe('HTTP routes behind the loopback and CSRF checks', () => {
  let server: http.Server;
  let port: number;

  function call(method: string, url: string, options: { host?: string; ui?: boolean; body?: unknown } = {}) {
    const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}`, 'Content-Type': 'application/json' };
    if (options.ui !== false) {
      headers.Origin = `http://127.0.0.1:${port}`;
      headers['X-Config-UI'] = '1';
    }
    return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (options.body !== undefined) req.write(JSON.stringify(options.body));
      req.end();
    });
  }

  beforeEach(async () => {
    const app = express();
    app.use(security.securityMiddleware);
    app.use(express.json());
    redTeam.registerRedTeamRoutes(app, makeRunner());
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('a POST without the CSRF header is refused before the app is called', async () => {
    const reply = await call('POST', '/api/red-team/runs', { ui: false, body: {} });
    expect(reply.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });

  it('a non-loopback Host is refused before the app is called', async () => {
    const reply = await call('POST', '/api/red-team/runs', { host: `attacker.example.org:${port}`, body: {} });
    expect(reply.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });

  it('GET /api/red-team/runs answers 200 with latest null and the run configs; no Access-Control header', async () => {
    const reply = await call('GET', '/api/red-team/runs');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ latest: null, runConfigs: ['legacy.json', 'sec-recommended.json'] });
    expect(Object.keys(reply.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
  });

  it('POST starts a run; the 409 for a second start names the running run; GET of an unknown id is 404', async () => {
    expect((await call('POST', '/api/red-team/runs', { body: {} })).status).toBe(202);
    const second = await call('POST', '/api/red-team/runs', { body: {} });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'run_active', runningRunId: RUN_A });
    expect((await call('GET', `/api/red-team/runs/${RUN_A}`)).body.run.state).toBe('running');
    expect((await call('GET', `/api/red-team/runs/${RUN_C}`)).status).toBe(404);
  });
});
