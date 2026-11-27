import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredContexts, main, EXIT_OK, EXIT_NOT_REQUIRED, EXIT_UNREADABLE } from '../ci/check-branch-protection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-branch-protection.mjs');
const TRUNK = 'claude/ecstatic-hamilton-86gtwv';
const REPO = 'example-owner/example-repo';
const API = 'https://api.github.com';
const ENV = { GITHUB_REPOSITORY: REPO, GH_TOKEN: 'placeholder-token-value' };

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** A GitHub stub keyed by path; any request method but GET fails the test. */
function stubGitHub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, headers: init.headers ?? {} });
    assert.equal(method, 'GET', `unexpected ${method} ${url}`);
    assert.equal(init.body, undefined, 'a GET carries no body');
    const p = String(url).slice(API.length);
    const route = routes[p];
    return route ? json(route[0], route[1]) : json(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}

function capture() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
}

const classic = (contexts, checks = []) => ({ required_status_checks: { strict: true, contexts, checks: checks.map((context) => ({ context, app_id: null })) } });
const ruleset = (contexts) => [
  { type: 'deletion', parameters: {} },
  { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context })) } },
];

function routesFor({ mainProtection, mainRules = [], trunkProtection, trunkRules = [] }) {
  const r = {};
  const b = (name) => `/repos/${REPO}/branches/${name}`;
  r[`${b('main')}/protection`] = mainProtection ?? [404, { message: 'Branch not protected' }];
  r[b('main')] = [200, { name: 'main', protected: Boolean(mainProtection), protection: mainProtection ? mainProtection[1] : { enabled: false } }];
  r[`/repos/${REPO}/rules/branches/main`] = [200, mainRules];
  r[`${b(TRUNK)}/protection`] = trunkProtection ?? [404, { message: 'Branch not protected' }];
  r[b(TRUNK)] = [200, { name: TRUNK, protected: Boolean(trunkProtection), protection: trunkProtection ? trunkProtection[1] : { enabled: false } }];
  r[`/repos/${REPO}/rules/branches/${TRUNK}`] = [200, trunkRules];
  return r;
}

test('requiredContexts unions classic contexts, classic checks and ruleset checks', () => {
  assert.deepEqual(requiredContexts(classic(['a'], ['b']), ruleset(['c', 'a'])), ['a', 'b', 'c']);
  assert.deepEqual(requiredContexts({ protection: classic(['x']) }, []), ['x']);
  assert.deepEqual(requiredContexts(null, null), []);
  assert.deepEqual(requiredContexts({ enabled: false }, [{ type: 'deletion' }]), []);
});

test('main through classic protection and trunk through a ruleset: both required, exit 0', async () => {
  const { fetch, calls } = stubGitHub(
    routesFor({ mainProtection: [200, classic(['pr-smoke', 'rag-release-gate'])], trunkRules: ruleset(['pr-smoke']) }),
  );
  const out = capture();
  const code = await main([], ENV, { fetch, ...out });
  assert.equal(code, EXIT_OK, out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes('main: pr-smoke required')), out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes(`${TRUNK}: pr-smoke required`)), out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes('main: rag-release-gate required')), out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes(`${TRUNK}: rag-release-gate not required`)), out.lines.join('\n'));
  assert.ok(calls.length > 0 && calls.every((c) => c.method === 'GET'));
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer placeholder-token-value'));
  assert.ok(out.lines.every((l) => !l.includes('placeholder-token-value')), 'the token is never printed');
});

test('trunk without the check: not required, exit 1', async () => {
  const { fetch } = stubGitHub(routesFor({ mainProtection: [200, classic(['pr-smoke'])], trunkRules: ruleset(['ts-vitest']) }));
  const out = capture();
  const code = await main([], ENV, { fetch, ...out });
  assert.equal(code, EXIT_NOT_REQUIRED, out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes(TRUNK) && l.includes('pr-smoke: not required')), out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes('main: pr-smoke required')));
});

test('protection refused falls back to the branch endpoint', async () => {
  const routes = routesFor({ trunkRules: ruleset(['pr-smoke']) });
  routes[`/repos/${REPO}/branches/main/protection`] = [403, { message: 'Resource not accessible by integration' }];
  routes[`/repos/${REPO}/branches/main`] = [200, { name: 'main', protected: true, protection: { enabled: true, required_status_checks: { contexts: ['pr-smoke'], checks: [] } } }];
  const { fetch, calls } = stubGitHub(routes);
  const out = capture();
  assert.equal(await main([], ENV, { fetch, ...out }), EXIT_OK, out.lines.join('\n'));
  assert.ok(calls.some((c) => c.url.endsWith(`/repos/${REPO}/branches/main`)));
});

for (const status of [403, 404]) {
  test(`every endpoint answering ${status} for a branch: exit 2 naming the branch`, async () => {
    const routes = routesFor({ mainProtection: [200, classic(['pr-smoke'])] });
    for (const suffix of [`/branches/${TRUNK}/protection`, `/branches/${TRUNK}`, `/rules/branches/${TRUNK}`]) {
      routes[`/repos/${REPO}${suffix}`] = [status, { message: 'refused' }];
    }
    const { fetch } = stubGitHub(routes);
    const out = capture();
    assert.equal(await main([], ENV, { fetch, ...out }), EXIT_UNREADABLE, out.lines.join('\n'));
    assert.ok(out.lines.some((l) => l.includes(TRUNK) && /cannot read/.test(l)), out.lines.join('\n'));
  });
}

test('a network error is unreadable, exit 2', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const out = capture();
  assert.equal(await main([], ENV, { fetch, ...out }), EXIT_UNREADABLE);
});

test('a repository that is not owner/name is exit 2 without a request', async () => {
  const { fetch, calls } = stubGitHub({});
  const out = capture();
  assert.equal(await main(['--repo', 'not a repo'], ENV, { fetch, ...out }), EXIT_UNREADABLE);
  assert.equal(await main([], { GH_TOKEN: 'x' }, { fetch, ...out }), EXIT_UNREADABLE);
  assert.equal(calls.length, 0);
});

test('--repo and --branch override the defaults; GITHUB_TOKEN is used when GH_TOKEN is absent', async () => {
  const other = 'other-owner/other-repo';
  const { fetch, calls } = stubGitHub({
    [`/repos/${other}/branches/release/protection`]: [200, classic(['pr-smoke'])],
    [`/repos/${other}/rules/branches/release`]: [200, []],
  });
  const out = capture();
  const code = await main(['--repo', other, '--branch', 'release'], { GITHUB_TOKEN: 'placeholder-other' }, { fetch, ...out });
  assert.equal(code, EXIT_OK, out.lines.join('\n'));
  assert.ok(calls.every((c) => c.url.includes(`/repos/${other}/`)));
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer placeholder-other'));
  assert.ok(out.lines.some((l) => l.includes('release: pr-smoke required')));
});

test('the script source issues GET requests only', () => {
  const source = fs
    .readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(source, /method:\s*['"](PUT|PATCH|POST|DELETE)['"]/);
  assert.match(source, /method:\s*'GET'/);
});
