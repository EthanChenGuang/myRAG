import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_BASELINE = 'scripts/ci/tsc-baseline.json';
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;
const GLOBAL_DIAGNOSTIC = /^error TS\d+:/;

export const EXIT_OK = 0;
export const EXIT_REGRESSION = 1;
export const EXIT_CRASH = 70;

function normalise(file) {
  return file.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parses tsc output into per-file error counts. A diagnostic without a file position
 * (a compiler or config error) is counted separately and is never baselined.
 */
export function countDiagnostics(text) {
  const files = {};
  let fileless = 0;
  let total = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line);
    if (match) {
      const file = normalise(match[1]);
      files[file] = (files[file] ?? 0) + 1;
      total += 1;
    } else if (GLOBAL_DIAGNOSTIC.test(line)) {
      fileless += 1;
      total += 1;
    }
  }
  return { files, fileless, total };
}

/**
 * Compares current counts with a baseline entry ({ files }). More errors in any file, errors
 * in a file the baseline does not list, or any file-less diagnostic is a violation; fewer
 * errors always pass.
 */
export function compareToBaseline(counts, baseline) {
  const allowed = (baseline && baseline.files) || {};
  const violations = [];
  const improved = [];
  for (const file of Object.keys(counts.files).sort(byCodeUnit)) {
    const current = counts.files[file];
    if (!(file in allowed)) {
      violations.push(`${file}: ${current} error(s) in a file that is not in the baseline`);
    } else if (current > allowed[file]) {
      violations.push(`${file}: ${current} error(s), baseline allows ${allowed[file]}`);
    }
  }
  if (counts.fileless > 0) {
    violations.push(`${counts.fileless} file-less diagnostic(s) (compiler or config error); fix the configuration`);
  }
  for (const file of Object.keys(allowed).sort(byCodeUnit)) {
    if ((counts.files[file] ?? 0) < allowed[file]) improved.push(file);
  }
  return { ok: violations.length === 0, violations, improved, total: counts.total };
}

function sortedFiles(files) {
  const out = {};
  for (const file of Object.keys(files).sort(byCodeUnit)) out[file] = files[file];
  return out;
}

function readBaselineFile(file) {
  if (!fs.existsSync(file)) return { exists: false, data: null };
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { exists: true, data: null, error: error.message };
  }
}

function parseArgs(argv) {
  const args = {
    project: 'tsconfig.json',
    baseline: DEFAULT_BASELINE,
    cwd: ROOT,
    input: null,
    inputStatus: null,
    key: null,
    write: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--project') args.project = argv[++i] ?? '';
    else if (flag === '--baseline') args.baseline = argv[++i] ?? '';
    else if (flag === '--cwd') args.cwd = path.resolve(argv[++i] ?? '');
    else if (flag === '--input') args.input = path.resolve(argv[++i] ?? '');
    else if (flag === '--input-status') args.inputStatus = Number(argv[++i]);
    else if (flag === '--key') args.key = argv[++i] ?? '';
    else if (flag === '--write') args.write = true;
    else return { error: `unknown argument ${flag}` };
  }
  return { args };
}

function runTsc(cwd, project) {
  const result = spawnSync('npx', ['tsc', '--noEmit', '-p', project, '--pretty', 'false'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { error: result.error.message };
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`[tsc-ratchet] ${parsed.error}`);
    return EXIT_CRASH;
  }
  const { args } = parsed;
  const baselinePath = path.resolve(ROOT, args.baseline);

  let status;
  let output;
  if (args.input) {
    if (!fs.existsSync(args.input)) {
      console.error(`[tsc-ratchet] crash: input file ${args.input} does not exist`);
      return EXIT_CRASH;
    }
    output = fs.readFileSync(args.input, 'utf8');
    status = Number.isInteger(args.inputStatus) ? args.inputStatus : null;
  } else {
    const run = runTsc(args.cwd, args.project);
    if (run.error) {
      console.error(`[tsc-ratchet] crash: could not run tsc: ${run.error}`);
      return EXIT_CRASH;
    }
    ({ status, output } = run);
  }

  const counts = countDiagnostics(output);
  if (counts.total === 0 && status !== null && status !== 0) {
    console.error(`[tsc-ratchet] crash: tsc exited ${status} without a parseable diagnostic\n${String(output).trim()}`);
    return EXIT_CRASH;
  }

  if (args.write) {
    if (counts.fileless > 0) {
      console.error(`[tsc-ratchet] refusing to write a baseline: ${counts.fileless} file-less diagnostic(s)`);
      return EXIT_REGRESSION;
    }
    const entry = { project: args.project, total: counts.total, files: sortedFiles(counts.files) };
    let document;
    if (args.key) {
      const existing = readBaselineFile(baselinePath);
      const packages = existing.data && typeof existing.data.packages === 'object' && existing.data.packages ? existing.data.packages : {};
      const merged = { ...packages, [args.key]: entry };
      const ordered = {};
      for (const name of Object.keys(merged).sort(byCodeUnit)) ordered[name] = merged[name];
      document = { schemaVersion: 1, packages: ordered };
    } else {
      document = { schemaVersion: 1, ...entry };
    }
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`[tsc-ratchet] wrote ${path.relative(ROOT, baselinePath) || baselinePath}: ${counts.total} error(s) in ${Object.keys(counts.files).length} file(s)`);
    return EXIT_OK;
  }

  const existing = readBaselineFile(baselinePath);
  if (!existing.exists || !existing.data) {
    console.error(`[tsc-ratchet] baseline ${args.baseline} is ${existing.exists ? `not valid JSON: ${existing.error}` : 'missing'}; create it with --write`);
    return EXIT_REGRESSION;
  }
  let entry = existing.data;
  if (args.key) {
    entry = existing.data.packages ? existing.data.packages[args.key] : undefined;
    if (!entry) {
      console.error(`[tsc-ratchet] baseline has no entry for key '${args.key}'; create it with --write --key ${args.key}`);
      return EXIT_REGRESSION;
    }
  }

  const result = compareToBaseline(counts, entry);
  if (!result.ok) {
    for (const violation of result.violations) console.error(violation);
    console.error(`[tsc-ratchet] ${result.violations.length} violation(s)`);
    return EXIT_REGRESSION;
  }
  console.log(`[tsc-ratchet] ok: ${result.total} error(s), ${result.improved.length} file(s) improved`);
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
