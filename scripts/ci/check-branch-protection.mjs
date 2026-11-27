import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_NOT_REQUIRED = 1;
export const EXIT_UNREADABLE = 2;
export const REQUIRED_CHECK = 'pr-smoke';
export const INFO_CHECK = 'rag-release-gate';
export const DEFAULT_BRANCHES = ['main', 'claude/ecstatic-hamilton-86gtwv'];

const DEFAULT_API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;

function contextsOf(statusChecks) {
  if (!statusChecks || typeof statusChecks !== 'object') return [];
  const out = [];
  if (Array.isArray(statusChecks.contexts)) out.push(...statusChecks.contexts.filter((c) => typeof c === 'string'));
  if (Array.isArray(statusChecks.checks)) {
    for (const check of statusChecks.checks) if (check && typeof check.context === 'string') out.push(check.context);
  }
  return out;
}

/**
 * Union of the required status check contexts of classic branch protection (the protection endpoint, or the
 * `protection` field of the branch endpoint) and of the active ruleset rules of a branch (D-37).
 */
export function requiredContexts(protection, rules) {
  const found = new Set();
  const classic = protection && typeof protection === 'object' && protection.protection ? protection.protection : protection;
  if (classic && typeof classic === 'object') for (const c of contextsOf(classic.required_status_checks)) found.add(c);
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!rule || rule.type !== 'required_status_checks') continue;
      const checks = rule.parameters && rule.parameters.required_status_checks;
      if (!Array.isArray(checks)) continue;
      for (const check of checks) if (check && typeof check.context === 'string') found.add(check.context);
    }
  }
  return [...found].sort();
}

function parseArgs(argv) {
  const out = { repo: null, branches: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repo = argv[++i] ?? '';
    else if (argv[i] === '--branch') out.branches.push(argv[++i] ?? '');
  }
  return out;
}

function branchPath(branch) {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** The only request helper of this script: GET, never a write (D-38, O-7). */
async function get(fetchImpl, api, token, urlPath) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(`${api}${urlPath}`, { method: 'GET', headers });
    if (response.status !== 200) return { ok: false, status: response.status };
    return { ok: true, body: await response.json() };
  } catch (exc) {
    return { ok: false, status: exc && exc.name ? exc.name : 'Error' };
  }
}

async function readBranch(fetchImpl, api, token, repo, branch) {
  const base = `/repos/${repo}`;
  const b = branchPath(branch);
  let classic = await get(fetchImpl, api, token, `${base}/branches/${b}/protection`);
  if (!classic.ok) {
    const fallback = await get(fetchImpl, api, token, `${base}/branches/${b}`);
    classic = fallback.ok ? { ok: true, body: fallback.body && fallback.body.protection } : { ok: false, status: `${classic.status}/${fallback.status}` };
  }
  const rules = await get(fetchImpl, api, token, `${base}/rules/branches/${b}`);
  return { classic, rules };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const args = parseArgs(argv);
  const repo = String(args.repo ?? env.GITHUB_REPOSITORY ?? '');
  if (!REPO_RE.test(repo) || repo.includes('..')) {
    error('[Branch Protection] repository must be owner/name (--repo or GITHUB_REPOSITORY)');
    return EXIT_UNREADABLE;
  }
  const branches = args.branches.length ? args.branches : DEFAULT_BRANCHES;
  const bad = branches.find((b) => !BRANCH_RE.test(b) || b.includes('..'));
  if (bad !== undefined) {
    error('[Branch Protection] invalid branch name');
    return EXIT_UNREADABLE;
  }
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const api = String(env.GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, '');

  let unreadable = false;
  let missing = false;
  for (const branch of branches) {
    const { classic, rules } = await readBranch(fetchImpl, api, token, repo, branch);
    const contexts = requiredContexts(classic.ok ? classic.body : null, rules.ok ? rules.body : null);
    const has = (name) => contexts.includes(name);
    if (!classic.ok && !rules.ok) {
      error(`[Branch Protection] ${branch}: cannot read branch protection (${classic.status}) or rulesets (${rules.status})`);
      unreadable = true;
      continue;
    }
    if (has(REQUIRED_CHECK)) {
      log(`${branch}: ${REQUIRED_CHECK} required`);
    } else if (!classic.ok || !rules.ok) {
      const which = classic.ok ? `rulesets (${rules.status})` : `branch protection (${classic.status})`;
      error(`[Branch Protection] ${branch}: cannot read ${which}; ${REQUIRED_CHECK} not found in the readable settings`);
      unreadable = true;
    } else {
      log(`${branch}: ${REQUIRED_CHECK}: not required (required: ${contexts.join(', ') || 'none'})`);
      missing = true;
    }
    log(`${branch}: ${INFO_CHECK} ${has(INFO_CHECK) ? 'required' : 'not required'} (information)`);
  }
  if (unreadable) return EXIT_UNREADABLE;
  return missing ? EXIT_NOT_REQUIRED : EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
