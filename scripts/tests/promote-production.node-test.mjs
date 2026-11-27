import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedStatus, findDeployment, promote, main, STATUS_CONTEXT, EXIT_OK, EXIT_STOPPED, EXIT_INVALID } from '../ci/promote-production.mjs';

const SHA = 'c'.repeat(40);
const REPO = 'example-owner/example-repo';
const GH = 'https://api.github.com';
const VERCEL = 'https://api.vercel.com';
const ENV = {
  GITHUB_REPOSITORY: REPO,
  GH_TOKEN: 'placeholder-gh-token',
  VERCEL_TOKEN: 'placeholder-vercel-token',
  VERCEL_PROJECT_ID: 'prj_placeholder',
  VERCEL_TEAM_ID: 'team_placeholder',
};
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const ADMIN = { login: 'octo-admin', type: 'User' };
const WRITER = { login: 'octo-writer', type: 'User' };

function status(state, creator = BOT, extra = {}) {
  return { context: STATUS_CONTEXT, state, description: state === 'success' ? 'passed' : `${state}: x`, creator, ...extra };
}

function deployment(extra = {}) {
  return { uid: 'dpl_placeholder1', readyState: 'READY', readySubstate: 'STAGED', target: 'production', meta: { githubCommitSha: SHA }, ...extra };
}

function json(code, body) {
  return { status: code, ok: code >= 200 && code < 300, json: async () => body };
}

/** One stub for both APIs; it records every call with method and host. */
function stub({ statuses = [status('success')], permissions = {}, deployments = [deployment()], promoteStatus = 201 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), host: u.host, method, path: u.pathname, search: u.searchParams, headers: init.headers ?? {} });
    if (u.host === 'api.github.com') {
      assert.equal(method, 'GET', 'GitHub is only read');
      if (u.pathname === `/repos/${REPO}/commits/${SHA}/statuses`) return json(200, Number(u.searchParams.get('page') ?? '1') === 1 ? statuses : []);
      const m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
      if (m) {
        const login = decodeURIComponent(m[1]);
        return login in permissions ? json(200, { permission: permissions[login] }) : json(403, { message: 'refused' });
      }
      return json(404, {});
    }
    if (u.host === 'api.vercel.com') {
      if (method === 'GET' && u.pathname === '/v7/deployments') return json(200, { deployments });
      if (method === 'POST' && u.pathname.startsWith('/v10/projects/')) return json(promoteStatus, {});
      return json(404, {});
    }
    throw new Error(`unexpected host ${u.host}`);
  };
  return { fetch, calls, vercelCalls: () => calls.filter((c) => c.host === 'api.vercel.com') };
}

function capture() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
}

async function run(opts, argv = ['--sha', SHA], env = ENV) {
  const s = stub(opts);
  const out = capture();
  const code = await main(argv, env, { fetch: s.fetch, ...out });
  return { code, out, ...s };
}

test('acceptedStatus: newest status of the context counts; bot success accepted, writer refused, admin accepted', async () => {
  const none = async () => null;
  assert.equal((await acceptedStatus([status('success')], none)).accepted, true);
  assert.equal((await acceptedStatus([], none)).accepted, false);
  assert.equal((await acceptedStatus([{ ...status('success'), context: 'other' }], none)).accepted, false);
  assert.equal((await acceptedStatus([status('failure'), status('success')], none)).accepted, false);
  assert.equal((await acceptedStatus([status('success', WRITER)], async () => 'write')).accepted, false);
  assert.equal((await acceptedStatus([status('success', ADMIN)], async () => 'admin')).accepted, true);
  assert.equal((await acceptedStatus([status('success', { login: 'github-actions[bot]', type: 'User' })], none)).accepted, false);
  assert.equal((await acceptedStatus([status('success', { login: 'other-app[bot]', type: 'Bot' })], async () => 'admin')).accepted, false);
  assert.equal((await acceptedStatus([status('pending'), status('success')], none)).accepted, false);
});

test('bot success and a READY staged deployment: one GET deployments and one POST promote, exit 0', async () => {
  const r = await run();
  assert.equal(r.code, EXIT_OK, r.out.lines.join('\n'));
  const v = r.vercelCalls();
  assert.equal(v.length, 2);
  assert.equal(v[0].method, 'GET');
  assert.equal(v[0].path, '/v7/deployments');
  assert.equal(v[0].search.get('projectId'), 'prj_placeholder');
  assert.equal(v[0].search.get('target'), 'production');
  assert.equal(v[0].search.get('sha'), SHA);
  assert.equal(v[0].search.get('teamId'), 'team_placeholder');
  assert.equal(v[1].method, 'POST');
  assert.equal(v[1].path, '/v10/projects/prj_placeholder/promote/dpl_placeholder1');
  assert.equal(v[1].search.get('teamId'), 'team_placeholder');
  assert.ok(v.every((c) => c.headers.Authorization === 'Bearer placeholder-vercel-token'));
  assert.ok(r.calls.filter((c) => c.host === 'api.github.com').every((c) => c.headers.Authorization === 'Bearer placeholder-gh-token'));
  assert.ok(r.out.lines.every((l) => !/placeholder-(gh|vercel)-token/.test(l)), 'tokens are never printed');
});

test('success posted by a write user: stops before any Vercel call, prints the login, exit 1', async () => {
  const r = await run({ statuses: [status('success', WRITER)], permissions: { 'octo-writer': 'write' } });
  assert.equal(r.code, EXIT_STOPPED);
  assert.equal(r.vercelCalls().length, 0);
  assert.ok(r.out.lines.some((l) => l.includes('octo-writer')), r.out.lines.join('\n'));
});

test('success posted by a user whose permission cannot be read: stops, exit 1', async () => {
  const r = await run({ statuses: [status('success', WRITER)] });
  assert.equal(r.code, EXIT_STOPPED);
  assert.equal(r.vercelCalls().length, 0);
});

test('success posted by an admin user: proceeds to promote', async () => {
  const r = await run({ statuses: [status('success', ADMIN)], permissions: { 'octo-admin': 'admin' } });
  assert.equal(r.code, EXIT_OK, r.out.lines.join('\n'));
  assert.equal(r.vercelCalls().filter((c) => c.method === 'POST').length, 1);
});

test('newest status failure (skipped: judge_keys_missing) or no status: stops before any Vercel call, exit 1', async () => {
  for (const statuses of [[status('failure', BOT, { description: 'skipped: judge_keys_missing' })], [], [{ ...status('success'), context: 'pr-smoke' }]]) {
    const r = await run({ statuses });
    assert.equal(r.code, EXIT_STOPPED, r.out.lines.join('\n'));
    assert.equal(r.vercelCalls().length, 0);
  }
});

test('an older success followed by a newer failure: stops', async () => {
  const r = await run({ statuses: [status('failure'), status('success')] });
  assert.equal(r.code, EXIT_STOPPED);
  assert.equal(r.vercelCalls().length, 0);
});

test('no READY production deployment for the sha: no POST, exit 1', async () => {
  for (const deployments of [[], [deployment({ readyState: 'BUILDING' })], [deployment({ readyState: 'ERROR' })], [deployment({ meta: { githubCommitSha: 'd'.repeat(40) } })], [deployment({ target: 'preview' })]]) {
    const r = await run({ deployments });
    assert.equal(r.code, EXIT_STOPPED, JSON.stringify(deployments));
    assert.equal(r.vercelCalls().filter((c) => c.method === 'POST').length, 0);
  }
});

test('already PROMOTED: no POST, exit 0 with a message', async () => {
  const r = await run({ deployments: [deployment({ readySubstate: 'PROMOTED' })] });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.vercelCalls().filter((c) => c.method === 'POST').length, 0);
  assert.ok(r.out.lines.some((l) => /already promoted/.test(l)), r.out.lines.join('\n'));
});

test('a 409 from promote: exit 1 with promotion in progress; 202 is success; 500 is exit 1', async () => {
  let r = await run({ promoteStatus: 409 });
  assert.equal(r.code, EXIT_STOPPED);
  assert.ok(r.out.lines.some((l) => l.includes('promotion in progress')), r.out.lines.join('\n'));
  r = await run({ promoteStatus: 202 });
  assert.equal(r.code, EXIT_OK);
  r = await run({ promoteStatus: 500 });
  assert.equal(r.code, EXIT_STOPPED);
});

test('a sha that is not 40 hex: exit 2 without any request', async () => {
  for (const argv of [['--sha', 'abc'], ['--sha', 'C'.repeat(40)], ['--sha', `${SHA}; rm -rf /`], []]) {
    const r = await run({}, argv);
    assert.equal(r.code, EXIT_INVALID, argv.join(' '));
    assert.equal(r.calls.length, 0);
  }
});

test('missing configuration: exit 2 without any request', async () => {
  for (const drop of ['GH_TOKEN', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'GITHUB_REPOSITORY']) {
    const env = { ...ENV };
    delete env[drop];
    const r = await run({}, ['--sha', SHA], env);
    assert.equal(r.code, EXIT_INVALID, drop);
    assert.equal(r.calls.length, 0);
  }
});

test('findDeployment and promote use the injected Vercel client', async () => {
  const seen = [];
  const vercel = {
    listDeployments: async (q) => {
      seen.push(['list', q]);
      return [deployment({ uid: 'dpl_a', readyState: 'BUILDING' }), deployment({ uid: 'dpl_b' })];
    },
    promoteDeployment: async (q) => {
      seen.push(['promote', q]);
      return 409;
    },
  };
  const found = await findDeployment(vercel, { projectId: 'prj_x', teamId: 'team_x', sha: SHA });
  assert.equal(found.uid, 'dpl_b');
  const result = await promote(vercel, { projectId: 'prj_x', teamId: 'team_x', deploymentId: 'dpl_b' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'promotion in progress');
  assert.deepEqual(seen[1], ['promote', { projectId: 'prj_x', teamId: 'team_x', deploymentId: 'dpl_b' }]);
});
