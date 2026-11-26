import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANGCHAIN_PACKAGES = ['@langchain/core', '@langchain/classic', '@langchain/openai'];
const ROOT_ZOD = /^3\.25\.\d+$/;
const ROOT_OPENAI = /^4\.\d+\.\d+$/;
const NESTED_ZOD = /^4\.\d+\.\d+$/;

export function checkZodIsolation(tree) {
  const deps = tree?.dependencies ?? {};
  const reasons = [];
  const notes = [];

  const rootZod = deps.zod?.version;
  if (!rootZod || !ROOT_ZOD.test(rootZod)) {
    reasons.push(`root zod must be 3.25.x, got ${rootZod || 'none'}`);
  }
  const rootOpenai = deps.openai?.version;
  if (!rootOpenai || !ROOT_OPENAI.test(rootOpenai)) {
    reasons.push(`root openai must be 4.x, got ${rootOpenai || 'none'}`);
  }

  const present = LANGCHAIN_PACKAGES.filter((name) => deps[name]);
  if (present.length === 0) {
    notes.push('skipped: LangChain not installed');
  }
  for (const name of present) {
    const nested = deps[name].dependencies?.zod?.version;
    if (!nested) {
      reasons.push(`${name} has no nested zod; it would resolve the root zod ${rootZod || 'none'}`);
    } else if (!NESTED_ZOD.test(nested)) {
      reasons.push(`${name} resolves zod ${nested}; it must have its own zod 4.x`);
    } else {
      notes.push(`${name}@${deps[name].version} -> zod ${nested}`);
    }
  }
  const nestedOpenai = deps['@langchain/openai']?.dependencies?.openai?.version;
  if (nestedOpenai) notes.push(`@langchain/openai -> openai ${nestedOpenai}`);

  return { ok: reasons.length === 0, skipped: present.length === 0, reasons, notes };
}

function parseArgs(argv) {
  const args = { root: ROOT, treeFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i]);
    else if (argv[i] === '--tree-file') args.treeFile = path.resolve(argv[++i]);
  }
  return args;
}

function readTree(args) {
  if (args.treeFile) return JSON.parse(fs.readFileSync(args.treeFile, 'utf8'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['ls', 'zod', 'openai', '--all', '--json'], {
    cwd: args.root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout) throw new Error(`npm ls produced no output (${result.stderr?.trim() || `exit ${result.status}`})`);
  return JSON.parse(result.stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let tree;
  try {
    tree = readTree(args);
  } catch (error) {
    console.error(`[check-zod-isolation] cannot read the dependency tree: ${error.message}`);
    return 1;
  }
  const result = checkZodIsolation(tree);
  if (!result.ok) {
    for (const reason of result.reasons) console.error(`[check-zod-isolation] ${reason}`);
    return 1;
  }
  if (result.skipped) {
    console.log('::notice::skipped: LangChain not installed');
  }
  console.log(`[check-zod-isolation] ok: root zod ${tree.dependencies.zod.version}, root openai ${tree.dependencies.openai.version}`);
  for (const note of result.notes) console.log(`[check-zod-isolation] ${note}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
