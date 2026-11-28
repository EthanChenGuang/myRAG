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

const RUN_ID = 4242;
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN_ID}`;

function status(state, creator = BOT, extra = {}) {
  const target = creator === BOT ? { target_url: RUN_URL } : {};
  return { context: STATUS_CONTEXT, state, description: state === 'success' ? 'passed' : `${state}: x`, creator, ...target, ...extra };
}

/** A completed, successful rag-release-gate run on the default branch that gated SHA (T-05.3-391). */
function gateRun(extra = {}) {
  return {
    id: RUN_ID,
    path: '.github/workflows/rag-release-gate.yml',
    head_branch: 'main',
    head_sha: SHA,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    display_title: `rag-release-gate ${SHA}`,
    repository: { full_name: REPO },
    ...extra,
  };
}

function provenance(run = gateRun(), defaultBranch = 'main') {
  return {
    repo: REPO,
    sha: SHA,
    runOf: async (id) => (run && Number(id) === run.id ? run : null),
    defaultBranchOf: async () => defaultBranch,
  };
}

function deployment(extra = {}) {
  return { uid: 'dpl_placeholder1', readyState: 'READY', readySubstate: 'STAGED', target: 'production', meta: { githubCommitSha: SHA }, ...extra };
}

function json(code, body) {
  return { status: code, ok: code >= 200 && code < 300, json: async () => body };
}

/** One stub for both APIs; it records every call with method and host. */
function stub({ statuses = [status('success')], permissions = {}, deployments = [deployment()], promoteStatus = 201, runs = [gateRun()], defaultBranch = 'main' } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), host: u.host, method, path: u.pathname, search: u.searchParams, headers: init.headers ?? {} });
    if (u.host === 'api.github.com') {
      assert.equal(method, 'GET', 'GitHub is only read');
      if (u.pathname === `/repos/${REPO}/commits/${SHA}/statuses`) return json(200, Number(u.searchParams.get('page') ?? '1') === 1 ? statuses : []);
      if (u.pathname === `/repos/${REPO}`) return json(200, { full_name: REPO, default_branch: defaultBranch });
      const runMatch = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/);
      if (runMatch) {
        const found = runs.find((r) => r.id === Number(runMatch[1]));
        return found ? json(200, found) : json(404, { message: 'Not Found' });
      }
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
  const ctx = provenance();
  assert.equal((await acceptedStatus([status('success')], none, ctx)).accepted, true);
  assert.equal((await acceptedStatus([], none, ctx)).accepted, false);
  assert.equal((await acceptedStatus([{ ...status('success'), context: 'other' }], none, ctx)).accepted, false);
  assert.equal((await acceptedStatus([status('failure'), status('success')], none, ctx)).accepted, false);
  assert.equal((await acceptedStatus([status('success', WRITER)], async () => 'write', ctx)).accepted, false);
  assert.equal((await acceptedStatus([status('success', ADMIN)], async () => 'admin', ctx)).accepted, true);
  assert.equal((await acceptedStatus([status('success', { login: 'github-actions[bot]', type: 'User' })], none, ctx)).accepted, false);
  assert.equal((await acceptedStatus([status('success', { login: 'other-app[bot]', type: 'Bot' })], async () => 'admin', ctx)).accepted, false);
  assert.equal((await acceptedStatus([status('pending'), status('success')], none, ctx)).accepted, false);
});

test('acceptedStatus (T-05.3-391): a bot success without a run URL, or with a URL that is not this repository run, is refused', async () => {
  const none = async () => null;
  for (const target of [undefined, null, '', 'https://example.invalid/', `https://github.com/other-owner/other-repo/actions/runs/${RUN_ID}`,
    `${RUN_URL}/job/1`, `http://github.com/${REPO}/actions/runs/${RUN_ID}`, `https://github.com/${REPO}/actions/runs/abc`]) {
    const decision = await acceptedStatus([status('success', BOT, { target_url: target })], none, provenance());
    assert.equal(decision.accepted, false, String(target));
    assert.match(decision.reason, /run/, String(target));
  }
});

test('acceptedStatus (T-05.3-391): the bot status run must be the release gate workflow, on the default branch, push or dispatch, completed with success', async () => {
  const none = async () => null;
  const bad = {
    'another workflow': gateRun({ path: '.github/workflows/spoof.yml' }),
    'a feature branch': gateRun({ head_branch: 'feature' }),
    'a pull_request event': gateRun({ event: 'pull_request' }),
    'a schedule event': gateRun({ event: 'schedule' }),
    'still running': gateRun({ status: 'in_progress', conclusion: null }),
    'failed': gateRun({ conclusion: 'failure' }),
    'cancelled': gateRun({ conclusion: 'cancelled' }),
    'another repository': gateRun({ repository: { full_name: 'other-owner/other-repo' } }),
    'another gated sha': gateRun({ event: 'workflow_dispatch', head_sha: 'e'.repeat(40), display_title: `rag-release-gate ${'d'.repeat(40)}` }),
    'a push of another sha': gateRun({ head_sha: 'd'.repeat(40) }),
  };
  for (const [label, run] of Object.entries(bad)) {
    const decision = await acceptedStatus([status('success')], none, provenance(run));
    assert.equal(decision.accepted, false, label);
  }
  assert.equal((await acceptedStatus([status('success')], none, provenance(gateRun(), 'trunk'))).accepted, false, 'default branch differs');
  assert.equal((await acceptedStatus([status('success')], none, provenance(null))).accepted, false, 'run not readable');
  const throwing = { ...provenance(), runOf: async () => { throw new Error('boom'); } };
  assert.equal((await acceptedStatus([status('success')], none, throwing)).accepted, false, 'run lookup throws');
  const dispatched = gateRun({ event: 'workflow_dispatch', head_sha: 'e'.repeat(40) });
  assert.equal((await acceptedStatus([status('success')], none, provenance(dispatched))).accepted, true, 'dispatch of this sha from main');
  assert.equal((await acceptedStatus([status('success')], none, provenance(gateRun({ path: '.github/workflows/rag-release-gate.yml@main' })))).accepted, true, 'path with the default ref');
});

test('main (T-05.3-391): a spoofed bot success from another workflow run stops before any Vercel call', async () => {
  const r = await run({ runs: [gateRun({ path: '.github/workflows/spoof.yml' })] });
  assert.equal(r.code, EXIT_STOPPED, r.out.lines.join('\n'));
  assert.equal(r.vercelCalls().length, 0);
  const missing = await run({ statuses: [status('success', BOT, { target_url: undefined })] });
  assert.equal(missing.code, EXIT_STOPPED);
  assert.equal(missing.vercelCalls().length, 0);
});

test('main reads the run and the default branch with GET only', async () => {
  const r = await run();
  assert.equal(r.code, EXIT_OK, r.out.lines.join('\n'));
  const gh = r.calls.filter((c) => c.host === 'api.github.com');
  assert.ok(gh.some((c) => c.path === `/repos/${REPO}/actions/runs/${RUN_ID}`), 'run read');
  assert.ok(gh.some((c) => c.path === `/repos/${REPO}`), 'default branch read');
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
