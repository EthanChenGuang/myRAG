import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PHASE1_PATHS = [
  'src/lib/rag-eval/',
  'src/app/api/internal/rag/',
  'eval/harness/',
  'tests/',
  'vitest.config.ts',
];

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;
const GLOBAL_DIAGNOSTIC = /^error TS\d+:/;

function normalise(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isPhase1(file) {
  const f = normalise(file);
  return PHASE1_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
}

/**
 * Splits tsc output into diagnostics under Phase 1 paths (kept) and legacy ones (ignored).
 * A diagnostic without a file position (a compiler or config error) is always kept.
 */
export function filterDiagnostics(text) {
  const kept = [];
  let ignored = 0;
  let total = 0;
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = DIAGNOSTIC.exec(line);
    if (m) {
      total += 1;
      if (isPhase1(m[1])) {
        kept.push(line);
        current = 'kept';
      } else {
        ignored += 1;
        current = 'ignored';
      }
    } else if (GLOBAL_DIAGNOSTIC.test(line)) {
      total += 1;
      kept.push(line);
      current = 'kept';
    } else if (/^\s+\S/.test(line) && current === 'kept') {
      kept.push(line);
    } else if (!/^\s+\S/.test(line)) {
      current = null;
    }
  }
  return { kept, ignored, total };
}

export function evaluateTsc(status, output) {
  const { kept, ignored, total } = filterDiagnostics(output);
  if (kept.length > 0) {
    return {
      ok: false,
      message: `${kept.join('\n')}\ntypecheck:new: ${kept.length} Phase 1 diagnostic line(s); ignored ${ignored} legacy diagnostic(s)`,
    };
  }
  if (status !== 0 && total === 0) {
    return {
      ok: false,
      message: `typecheck:new: tsc exited ${status} without parseable diagnostics (tool crash)\n${String(output).trim()}`,
    };
  }
  return {
    ok: true,
    message: `typecheck:new: no Phase 1 type errors; ignored ${ignored} legacy diagnostic(s)`,
  };
}

export function runTypecheck() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(
    'npx',
    ['tsc', '-p', 'tsconfig.typecheck-new.json', '--pretty', 'false'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    return { ok: false, message: `typecheck:new could not run tsc: ${result.error.message}` };
  }
  return evaluateTsc(result.status, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, message } = runTypecheck();
  (ok ? console.log : console.error)(message);
  process.exit(ok ? 0 : 1);
}
