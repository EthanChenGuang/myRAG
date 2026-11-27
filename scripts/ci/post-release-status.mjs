import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS_CONTEXT = 'rag-release-gate';
export const NO_RESULT = 'error: no result';
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

const DESCRIPTION_MAX = 100;
const SHA_RE = /^[0-9a-f]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const CODE_RE = /^[a-z0-9_]+$/;
const OUTCOMES = new Set(['passed', 'failed', 'skipped']);
const PART_RESULTS = new Set(['passed', 'failed', 'skipped', 'not_applicable']);
const DEFAULT_API = 'https://api.github.com';

function clip(text) {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 3)}...`;
}

function noResult() {
  return { state: 'failure', description: NO_RESULT };
}

function validParts(parts) {
  return (
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every((p) => p && typeof p === 'object' && typeof p.part === 'string' && CODE_RE.test(p.part) && PART_RESULTS.has(p.result))
  );
}

/**
 * Maps a ReleaseGateResult to the rag-release-gate commit status (D-33, D-36). Only a passed run whose parts all
 * passed (ship_check may be not_applicable) or a complete admin override is success; everything else, including a
 * missing, unreadable or foreign result, is failure.
 */
export function statusFromResult(result, expectedSha) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return noResult();
  if (typeof expectedSha !== 'string' || !SHA_RE.test(expectedSha)) return noResult();
  if (typeof result.sha !== 'string' || result.sha !== expectedSha) return noResult();
  if (!OUTCOMES.has(result.result) || !validParts(result.parts)) return noResult();

  if (result.source === 'override') {
    const verified =
      result.result === 'passed' &&
      typeof result.actor === 'string' &&
      LOGIN_RE.test(result.actor) &&
      typeof result.override_reason === 'string' &&
      result.override_reason.trim().length >= 10;
    return verified ? { state: 'success', description: clip(`override by ${result.actor}`) } : noResult();
  }
  if (result.source !== 'ci' && result.source !== 'local_prerelease') return noResult();

  if (result.result === 'passed') {
    const clean = result.parts.every((p) => p.result === 'passed' || (p.result === 'not_applicable' && p.part === 'ship_check'));
    return clean ? { state: 'success', description: 'passed' } : noResult();
  }
  if (result.result === 'skipped') {
    if (typeof result.skip_reason !== 'string' || !CODE_RE.test(result.skip_reason)) return noResult();
    return { state: 'failure', description: clip(`skipped: ${result.skip_reason}`) };
  }
  const failed = result.parts.filter((p) => p.result === 'failed').map((p) => p.part);
  return { state: 'failure', description: clip(`failed: ${failed.join(',') || 'unknown'}`) };
}

/** Posts one commit status; returns the HTTP status code. The token goes only into the Authorization header. */
export async function postStatus({ repo, sha, state, description, token, fetch: fetchImpl = globalThis.fetch, api = DEFAULT_API }) {
  const url = `${String(api).replace(/\/+$/, '')}/repos/${repo}/statuses/${sha}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state, context: STATUS_CONTEXT, description }),
  });
  return response.status;
}

function readResult(file, readFile) {
  if (!file) return null;
  try {
    return JSON.parse(readFile(file));
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const readFile = deps.readFile ?? ((file) => fs.readFileSync(file, 'utf8'));
  const repo = String(env.GITHUB_REPOSITORY ?? '');
  const sha = String(env.GATE_SHA ?? '');
  const token = String(env.GH_TOKEN ?? '').trim();
  if (!REPO_RE.test(repo) || repo.includes('..')) {
    error('[Release Gate] GITHUB_REPOSITORY must be owner/name; no status posted');
    return EXIT_FAILED;
  }
  if (!SHA_RE.test(sha)) {
    error('[Release Gate] GATE_SHA must be a 40-character lowercase sha; no status posted');
    return EXIT_FAILED;
  }
  if (!token) {
    error('[Release Gate] GH_TOKEN is not set; no status posted');
    return EXIT_FAILED;
  }
  const { state, description } = statusFromResult(readResult(argv[0], readFile), sha);
  let status;
  try {
    status = await postStatus({ repo, sha, state, description, token, fetch: deps.fetch, api: env.GITHUB_API_URL || DEFAULT_API });
  } catch (exc) {
    error(`[Release Gate] status post failed: ${exc && exc.name ? exc.name : 'Error'}`);
    return EXIT_FAILED;
  }
  if (status !== 201) {
    error(`[Release Gate] status post answered HTTP ${status}`);
    return EXIT_FAILED;
  }
  log(`[Release Gate] ${sha.slice(0, 12)} ${STATUS_CONTEXT}: ${state} (${description})`);
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
