import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [];
export const ALLOWLIST = [];

export function checkBoundary(_root) {
  return [];
}

function main() {
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
