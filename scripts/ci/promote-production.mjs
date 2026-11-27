import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS_CONTEXT = 'rag-release-gate';
export const EXIT_OK = 0;
export const EXIT_STOPPED = 1;
export const EXIT_INVALID = 2;

export async function acceptedStatus(_statuses, _permissionOf) {
  return { accepted: true };
}

export async function findDeployment(_vercel, _opts) {
  return null;
}

export async function promote(_vercel, _opts) {
  return { ok: true };
}

export async function main(_argv = process.argv.slice(2), _env = process.env, _deps = {}) {
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
