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
export const GATE_WORKFLOW_PATH = '.github/workflows/rag-release-gate.yml';
const GATE_EVENTS = new Set(['push', 'workflow_dispatch']);
const DEFAULT_SERVER = 'https://github.com';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The run id of a target_url that points at a workflow run of this repository, or null. */
export function runIdFromTargetUrl(targetUrl, repo, serverUrl = DEFAULT_SERVER) {
  if (typeof targetUrl !== 'string' || typeof repo !== 'string' || !REPO_RE.test(repo)) return null;
  const server = String(serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(server)) return null;
  const match = targetUrl.match(new RegExp(`^${escapeRegExp(server)}/${escapeRegExp(repo)}/actions/runs/([1-9][0-9]{0,19})$`));
  return match ? match[1] : null;
}

/**
 * T-05.3-391: why a bot status's run does not prove a release gate run of this sha on the default branch, or null when it does.
 * The run must be rag-release-gate.yml of this repository on the default branch, started by push or workflow_dispatch, completed
 * with success; its run-name names the gated sha, and a push run's head is that sha.
 */
export function runProblem(run, { repo, sha, defaultBranch, runId }) {
  if (!run || typeof run !== 'object') return 'the run it links cannot be read';
  if (String(run.id) !== String(runId)) return 'the run it links is another run';
  if (run.repository?.full_name !== repo) return 'its run belongs to another repository';
  if (typeof defaultBranch !== 'string' || defaultBranch === '') return 'the default branch cannot be read';
  const runPath = String(run.path ?? '');
  const allowedPaths = new Set([GATE_WORKFLOW_PATH, `${GATE_WORKFLOW_PATH}@${defaultBranch}`, `${GATE_WORKFLOW_PATH}@refs/heads/${defaultBranch}`]);
  if (!allowedPaths.has(runPath)) return `its run is not ${GATE_WORKFLOW_PATH}`;
  if (run.head_branch !== defaultBranch) return `its run is not on the default branch ${defaultBranch}`;
  if (!GATE_EVENTS.has(run.event)) return `its run was started by ${run.event || 'an unknown event'}, not push or workflow_dispatch`;
  if (run.status !== 'completed' || run.conclusion !== 'success') return `its run is ${run.status || 'unknown'}/${run.conclusion || 'none'}, not completed/success`;
  if (run.display_title !== `${STATUS_CONTEXT} ${sha}`) return 'its run gated another sha';
  if (run.event === 'push' && run.head_sha !== sha) return 'its push run is for another sha';
  return null;
}

/**
 * Decides on the newest rag-release-gate status of a commit (statuses newest first). Only success counts, and only
 * when posted by a user whose repository permission is admin (O-5, research Pitfall 10) or by the Actions bot through a run
 * that runProblem accepts (T-05.3-391: any workflow can post as the bot, so the bot login alone proves nothing).
 * `permissionOf(login)` resolves to the permission string, or null when it cannot be read (treated as not admin).
 * `provenance` is `{ repo, sha, serverUrl?, runOf(id), defaultBranchOf() }`; without it no bot status is accepted.
 */
export async function acceptedStatus(statuses, permissionOf, provenance = null) {
  const list = Array.isArray(statuses) ? statuses : [];
  const newest = list.find((s) => s && typeof s.context === 'string' && s.context.toLowerCase() === STATUS_CONTEXT);
  if (!newest) return { accepted: false, reason: `no ${STATUS_CONTEXT} status on this commit` };
  const state = String(newest.state ?? '');
  const login = String(newest.creator?.login ?? '');
  const type = String(newest.creator?.type ?? '');
  if (state !== 'success') return { accepted: false, state, creator: login, reason: `newest ${STATUS_CONTEXT} status is ${state || 'unknown'}` };
  if (type === 'Bot' && login === ACTIONS_BOT) {
    const refused = (reason) => ({ accepted: false, state, creator: login, reason: `${ACTIONS_BOT} status refused: ${reason}` });
    if (!provenance || typeof provenance.runOf !== 'function' || typeof provenance.defaultBranchOf !== 'function') {
      return refused('its run cannot be checked');
    }
    const runId = runIdFromTargetUrl(newest.target_url, provenance.repo, provenance.serverUrl);
    if (runId === null) return refused('it carries no run URL of this repository');
    let run = null;
    let defaultBranch = null;
    try {
      [run, defaultBranch] = await Promise.all([provenance.runOf(runId), provenance.defaultBranchOf()]);
    } catch {
      return refused('the run it links cannot be read');
    }
    const problem = runProblem(run, { repo: provenance.repo, sha: provenance.sha, defaultBranch, runId });
    if (problem !== null) return refused(problem);
    return { accepted: true, state, creator: login, runId };
  }
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
    async run(id) {
      if (!/^[1-9][0-9]{0,19}$/.test(String(id))) return null;
      const response = await fetchImpl(`${api}/repos/${repo}/actions/runs/${id}`, { method: 'GET', headers });
      if (response.status !== 200) return null;
      return response.json();
    },
    async defaultBranch() {
      const response = await fetchImpl(`${api}/repos/${repo}`, { method: 'GET', headers });
      if (response.status !== 200) return null;
      const body = await response.json();
      return typeof body?.default_branch === 'string' ? body.default_branch : null;
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
    decision = await acceptedStatus(await github.statuses(sha), (login) => github.permission(login), {
      repo,
      sha,
      serverUrl: String(env.GITHUB_SERVER_URL || DEFAULT_SERVER),
      runOf: (id) => github.run(id),
      defaultBranchOf: () => github.defaultBranch(),
    });
  } catch (exc) {
    error(`[Promote] ${short}: cannot read the ${STATUS_CONTEXT} status (${exc && exc.message ? exc.message : 'Error'}); nothing promoted`);
    return EXIT_STOPPED;
  }
  if (!decision.accepted) {
    error(`[Promote] ${short}: ${decision.reason}; nothing promoted`);
    return EXIT_STOPPED;
  }
  log(`[Promote] ${short}: ${STATUS_CONTEXT} success by ${decision.creator}${decision.runId ? ` (run ${decision.runId})` : ''}`);

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
