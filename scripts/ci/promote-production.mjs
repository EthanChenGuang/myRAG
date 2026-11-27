import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS_CONTEXT = 'rag-release-gate';
export const ACTIONS_BOT = 'github-actions[bot]';
export const EXIT_OK = 0;
export const EXIT_STOPPED = 1;
export const EXIT_INVALID = 2;

const GITHUB_API = 'https://api.github.com';
const VERCEL_API = 'https://api.vercel.com';
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VERCEL_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const STATUS_PAGES = 10;

/**
 * Decides on the newest rag-release-gate status of a commit (statuses newest first). Only success counts, and only
 * when posted by the Actions bot or by a user whose repository permission is admin (O-5, research Pitfall 10).
 * `permissionOf(login)` resolves to the permission string, or null when it cannot be read (treated as not admin).
 */
export async function acceptedStatus(statuses, permissionOf) {
  const list = Array.isArray(statuses) ? statuses : [];
  const newest = list.find((s) => s && typeof s.context === 'string' && s.context.toLowerCase() === STATUS_CONTEXT);
  if (!newest) return { accepted: false, reason: `no ${STATUS_CONTEXT} status on this commit` };
  const state = String(newest.state ?? '');
  const login = String(newest.creator?.login ?? '');
  const type = String(newest.creator?.type ?? '');
  if (state !== 'success') return { accepted: false, state, creator: login, reason: `newest ${STATUS_CONTEXT} status is ${state || 'unknown'}` };
  if (type === 'Bot' && login === ACTIONS_BOT) return { accepted: true, state, creator: login };
  if (type !== 'User' || !LOGIN_RE.test(login)) {
    return { accepted: false, state, creator: login, reason: `status creator ${login || 'unknown'} is neither ${ACTIONS_BOT} nor a repository admin` };
  }
  let permission = null;
  try {
    permission = await permissionOf(login);
  } catch {
    permission = null;
  }
  if (permission === 'admin') return { accepted: true, state, creator: login };
  return {
    accepted: false,
    state,
    creator: login,
    reason: `status creator ${login} has permission ${permission ?? 'unreadable'}, not admin`,
  };
}

/** Newest READY production deployment built from exactly this sha, or null. */
export async function findDeployment(vercel, { projectId, teamId, sha }) {
  const deployments = await vercel.listDeployments({ projectId, teamId, sha });
  if (!Array.isArray(deployments)) return null;
  return (
    deployments.find(
      (d) =>
        d &&
        typeof d.uid === 'string' &&
        VERCEL_ID_RE.test(d.uid) &&
        d.readyState === 'READY' &&
        (d.target === undefined || d.target === 'production') &&
        d.meta?.githubCommitSha === sha,
    ) ?? null
  );
}

/** Points production traffic at the deployment; 201 and 202 are success, 409 is a promotion already in progress. */
export async function promote(vercel, { projectId, teamId, deploymentId }) {
  const code = await vercel.promoteDeployment({ projectId, teamId, deploymentId });
  if (code === 201 || code === 202) return { ok: true, status: code };
  if (code === 409) return { ok: false, status: code, reason: 'promotion in progress' };
  return { ok: false, status: code, reason: `promote answered HTTP ${code}` };
}

function githubClient(fetchImpl, api, token, repo) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return {
    async statuses(sha) {
      const all = [];
      for (let page = 1; page <= STATUS_PAGES; page += 1) {
        const response = await fetchImpl(`${api}/repos/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`, { method: 'GET', headers });
        if (response.status !== 200) throw new Error(`statuses answered HTTP ${response.status}`);
        const batch = await response.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.some((s) => s && typeof s.context === 'string' && s.context.toLowerCase() === STATUS_CONTEXT)) break;
      }
      return all;
    },
    async permission(login) {
      const response = await fetchImpl(`${api}/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { method: 'GET', headers });
      if (response.status !== 200) return null;
      const body = await response.json();
      return typeof body?.permission === 'string' ? body.permission : null;
    },
  };
}

function vercelClient(fetchImpl, api, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const team = (params, teamId) => {
    if (teamId) params.set('teamId', teamId);
    return params;
  };
  return {
    async listDeployments({ projectId, teamId, sha }) {
      const params = team(new URLSearchParams({ projectId, target: 'production', sha }), teamId);
      const response = await fetchImpl(`${api}/v7/deployments?${params}`, { method: 'GET', headers });
      if (response.status !== 200) throw new Error(`deployments answered HTTP ${response.status}`);
      const body = await response.json();
      return Array.isArray(body?.deployments) ? body.deployments : [];
    },
    async promoteDeployment({ projectId, teamId, deploymentId }) {
      const query = team(new URLSearchParams(), teamId).toString();
      const url = `${api}/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}${query ? `?${query}` : ''}`;
      const response = await fetchImpl(url, { method: 'POST', headers });
      return response.status;
    },
  };
}

function shaArg(argv) {
  const i = argv.indexOf('--sha');
  return i >= 0 ? String(argv[i + 1] ?? '') : '';
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sha = shaArg(argv);
  if (!SHA_RE.test(sha)) {
    error('[Promote] --sha must be a 40-character lowercase commit sha; nothing promoted');
    return EXIT_INVALID;
  }
  const repo = String(env.GITHUB_REPOSITORY ?? '');
  const ghToken = String(env.GH_TOKEN ?? '').trim();
  const vercelToken = String(env.VERCEL_TOKEN ?? '').trim();
  const projectId = String(env.VERCEL_PROJECT_ID ?? '').trim();
  const teamId = String(env.VERCEL_TEAM_ID ?? '').trim();
  const problems = [];
  if (!REPO_RE.test(repo) || repo.includes('..')) problems.push('GITHUB_REPOSITORY must be owner/name');
  if (!ghToken) problems.push('GH_TOKEN is not set');
  if (!vercelToken) problems.push('VERCEL_TOKEN is not set');
  if (!VERCEL_ID_RE.test(projectId)) problems.push('VERCEL_PROJECT_ID is not set or invalid');
  if (teamId && !VERCEL_ID_RE.test(teamId)) problems.push('VERCEL_TEAM_ID is invalid');
  if (problems.length) {
    for (const p of problems) error(`[Promote] ${p}; nothing promoted`);
    return EXIT_INVALID;
  }

  const github = deps.github ?? githubClient(fetchImpl, String(env.GITHUB_API_URL || GITHUB_API).replace(/\/+$/, ''), ghToken, repo);
  const vercel = deps.vercel ?? vercelClient(fetchImpl, VERCEL_API, vercelToken);
  const short = sha.slice(0, 12);

  let decision;
  try {
    decision = await acceptedStatus(await github.statuses(sha), (login) => github.permission(login));
  } catch (exc) {
    error(`[Promote] ${short}: cannot read the ${STATUS_CONTEXT} status (${exc && exc.message ? exc.message : 'Error'}); nothing promoted`);
    return EXIT_STOPPED;
  }
  if (!decision.accepted) {
    error(`[Promote] ${short}: ${decision.reason}; nothing promoted`);
    return EXIT_STOPPED;
  }
  log(`[Promote] ${short}: ${STATUS_CONTEXT} success by ${decision.creator}`);

  let deployment;
  try {
    deployment = await findDeployment(vercel, { projectId, teamId, sha });
  } catch (exc) {
    error(`[Promote] ${short}: cannot list deployments (${exc && exc.message ? exc.message : 'Error'}); nothing promoted`);
    return EXIT_STOPPED;
  }
  if (!deployment) {
    error(`[Promote] ${short}: no READY production deployment for this sha; nothing promoted`);
    return EXIT_STOPPED;
  }
  if (deployment.readySubstate === 'PROMOTED') {
    log(`[Promote] ${short}: deployment ${deployment.uid} is already promoted; nothing to do`);
    return EXIT_OK;
  }
  if (deployment.readySubstate === 'ROLLING') {
    error(`[Promote] ${short}: deployment ${deployment.uid} is rolling out; promotion in progress`);
    return EXIT_STOPPED;
  }

  let result;
  try {
    result = await promote(vercel, { projectId, teamId, deploymentId: deployment.uid });
  } catch (exc) {
    error(`[Promote] ${short}: promote request failed (${exc && exc.name ? exc.name : 'Error'})`);
    return EXIT_STOPPED;
  }
  if (!result.ok) {
    error(`[Promote] ${short}: deployment ${deployment.uid}: ${result.reason}`);
    return EXIT_STOPPED;
  }
  log(`[Promote] ${short}: deployment ${deployment.uid} promoted (HTTP ${result.status})`);
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
