import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 3.2 D-06: language codes come from config/rag/language-packs.json, never from a hard-coded union or list.

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const REGISTRY_FILE = 'config/rag/language-packs.json';
export const ALLOWLIST_FILE = 'scripts/ci/language-literal-allowlist.json';
export const SCAN_ROOTS = ['src', 'rag-sidecar/src', 'eval/src', 'scripts'];
export const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.venv', '__pycache__']);
const EXEMPT_SEGMENTS = new Set(['tests', 'fixtures', '__tests__']);
export const EXEMPT_FILES = new Set([
  REGISTRY_FILE,
  'rag-sidecar/config/rag/language-packs.json',
  'src/lib/rag-eval/contracts.generated.ts',
]);
const EXEMPT_PREFIXES = ['rag-sidecar/schemas/'];

const STRING_RE = /(['"`])([A-Za-z_-]{1,16})\1/g;
const SEPARATOR_RE = /^\s*[,|]\s*$/;

export function readRegistryCodes(root = DEFAULT_ROOT) {
  const registry = JSON.parse(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8'));
  const codes = (registry.packs ?? []).map((pack) => pack.code);
  if (codes.length < 2 || codes.some((code) => typeof code !== 'string' || code === '')) {
    throw new Error(`${REGISTRY_FILE} must list at least two language codes`);
  }
  return codes;
}

export function isExempt(rel) {
  if (EXEMPT_FILES.has(rel)) return true;
  if (EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) return true;
  return rel.split('/').some((segment) => EXEMPT_SEGMENTS.has(segment));
}

/** Runs of string literals joined only by `,` or `|` (a union, tuple, list, set or array) that hold every code. */
export function findLiterals(text, codes) {
  const hits = [];
  let run = [];
  let lastEnd = -1;
  const flush = () => {
    const values = new Set(run.map((m) => m.value));
    if (codes.every((code) => values.has(code))) {
      hits.push({ index: run[0].index, values: run.map((m) => m.value) });
    }
    run = [];
  };
  for (const match of text.matchAll(STRING_RE)) {
    const entry = { index: match.index, value: match[2] };
    if (run.length > 0 && !SEPARATOR_RE.test(text.slice(lastEnd, match.index))) flush();
    run.push(entry);
    lastEnd = match.index + match[0].length;
  }
  if (run.length > 0) flush();
  return hits;
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

export function collectFiles(root) {
  const seen = new Set();
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(path.join(root, scanRoot))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (!isExempt(rel)) seen.add(rel);
    }
  }
  return [...seen].sort();
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function scanTree(root, codes) {
  const findings = [];
  for (const rel of collectFiles(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const hit of findLiterals(text, codes)) {
      findings.push({ file: rel, line: lineOf(text, hit.index), values: hit.values });
    }
  }
  return findings;
}

export function readAllowlist(root, file = ALLOWLIST_FILE) {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(full)) return [];
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(data.entries)) throw new Error(`${file}: "entries" must be an array`);
  return data.entries;
}

export function allowlistProblems(entries, root, findings) {
  const problems = [];
  const reported = new Set(findings.map((f) => f.file));
  const seen = new Set();
  for (const [i, entry] of entries.entries()) {
    const label = typeof entry?.path === 'string' && entry.path.trim() !== '' ? entry.path : `entry ${i}`;
    if (label === `entry ${i}`) problems.push(`${label}: path is required`);
    if (typeof entry?.owner !== 'string' || entry.owner.trim() === '') {
      problems.push(`${label}: owner must name the plan or phase that removes this literal`);
    }
    if (typeof entry?.reason !== 'string' || entry.reason.trim() === '') problems.push(`${label}: reason is required`);
    if (label === `entry ${i}`) continue;
    if (seen.has(label)) problems.push(`${label}: listed twice`);
    seen.add(label);
    if (!fs.existsSync(path.join(root, label))) problems.push(`${label}: file does not exist`);
    else if (!reported.has(label)) problems.push(`${label}: stale entry, the file no longer holds a language literal`);
  }
  return problems;
}

export function checkLanguageLiterals(root = DEFAULT_ROOT, allowlistFile = ALLOWLIST_FILE) {
  const codes = readRegistryCodes(root);
  const findings = scanTree(root, codes);
  const entries = readAllowlist(root, allowlistFile);
  const allowed = new Set(entries.map((e) => e?.path).filter((p) => typeof p === 'string'));
  return {
    codes,
    scanned: collectFiles(root).length,
    allowlisted: allowed.size,
    violations: findings.filter((f) => !allowed.has(f.file)),
    problems: allowlistProblems(entries, root, findings),
  };
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, allowlist: ALLOWLIST_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--allowlist') args.allowlist = path.resolve(argv[++i] ?? '');
  }
  return args;
}

function main() {
  const { root, allowlist } = parseArgs(process.argv.slice(2));
  const result = checkLanguageLiterals(root, allowlist);
  for (const v of result.violations) {
    console.error(`${v.file}:${v.line} hard-coded language codes [${v.values.join(', ')}]; read them from ${REGISTRY_FILE}`);
  }
  for (const problem of result.problems) console.error(`${ALLOWLIST_FILE}: ${problem}`);
  if (result.violations.length > 0 || result.problems.length > 0) {
    console.error(
      `[check-language-literals] ${result.violations.length} literal(s) outside the allow-list, ${result.problems.length} allow-list problem(s)`,
    );
    return 1;
  }
  console.log(
    `[check-language-literals] ok: ${result.scanned} file(s) scanned, ${result.allowlisted} allow-listed file(s), codes ${result.codes.join(', ')}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
