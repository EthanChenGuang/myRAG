import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_NOT_REQUIRED = 1;
export const EXIT_UNREADABLE = 2;

export function requiredContexts(_protection, _rules) {
  return [];
}

export async function main(_argv = process.argv.slice(2), _env = process.env, _deps = {}) {
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
