import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED_MAJOR = '22';

const MAJOR_22_RANGES = [
  /^[\^~]22(\.\d+){0,2}$/,
  /^22(\.(x|X|\*|\d+)){0,2}$/,
  /^>=22(\.\d+){0,2}\s+<23(\.0){0,2}$/,
];

export function checkNodeRuntime({ version, engines }) {
  const major = String(version ?? '').split('.')[0];
  if (major !== REQUIRED_MAJOR) {
    return { ok: false, reason: `runtime Node ${version || 'unknown'} is not major ${REQUIRED_MAJOR}` };
  }
  if (typeof engines !== 'string' || engines.trim() === '') {
    return { ok: false, reason: 'package.json engines.node is missing' };
  }
  const range = engines.trim();
  if (!MAJOR_22_RANGES.some((pattern) => pattern.test(range))) {
    return { ok: false, reason: `engines.node '${range}' admits a major other than ${REQUIRED_MAJOR}; use ^22.12.0` };
  }
  return { ok: true, reason: `Node ${version} satisfies engines.node '${range}'` };
}

function parseArgs(argv) {
  const args = { root: ROOT, nodeVersion: process.versions.node };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i]);
    else if (argv[i] === '--node-version') args.nodeVersion = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let engines;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(args.root, 'package.json'), 'utf8'));
    engines = pkg?.engines?.node;
  } catch (error) {
    console.error(`[check-node-runtime] cannot read package.json: ${error.message}`);
    return 1;
  }
  const result = checkNodeRuntime({ version: args.nodeVersion, engines });
  if (!result.ok) {
    console.error(`[check-node-runtime] ${result.reason}`);
    return 1;
  }
  console.log(`[check-node-runtime] ok: ${result.reason}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
