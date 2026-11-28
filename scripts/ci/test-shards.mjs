#!/usr/bin/env node
// Duration-weighted test sharding for the pr-smoke node:test jobs.
//
//   node scripts/ci/test-shards.mjs --shard=3/12 tests/rag-db/*.test.mts
//     prints the files of shard 3 of 12, one per line, longest first. Every file lands in exactly one shard: files are taken longest first and each
//     goes to the shard with the smallest total so far (ties go to the lower shard). A file missing from the durations file weighs
//     the median of the recorded files, so a new test file is still run and only the balance is approximate until the next refresh.
//   node scripts/ci/test-shards.mjs --plan=12 <files...>
//     prints every shard with its expected seconds and file count.
//   node scripts/ci/test-shards.mjs --measure=scripts/ci/test-durations.json [--jobs=3] <files...>
//     runs each file alone (`node --import tsx --test <file>`, `--jobs` at a time, as many as the CI runner's node:test workers) and
//     writes the wall-clock seconds per file into the durations file, keeping entries for files not measured in this call.
//
// Node's own --test-shard splits by file index, so a few slow neighbouring files can land in one shard (one ts-db shard ran 24 min
// while another ran 4 min on the same commit). Exit 1 on a bad argument or when a shard would get no file: an empty file list would
// make `node --test` fall back to discovering every test in the repository.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DURATIONS = path.join(REPO_ROOT, 'scripts/ci/test-durations.json');

export function parseShard(spec) {
  const match = /^(\d+)\/(\d+)$/.exec(String(spec ?? ''));
  if (!match) throw new Error(`--shard must look like k/N, got ${JSON.stringify(spec)}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) throw new Error(`--shard ${spec}: k must be between 1 and N`);
  return { index, total };
}

export function readDurations(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seconds = parsed?.seconds;
  if (!seconds || typeof seconds !== 'object') throw new Error(`${file}: expected a "seconds" object`);
  return seconds;
}

function median(values) {
  if (values.length === 0) return 30;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Splits files into `total` shards by weight; returns [{ files, seconds }] with each shard's files longest first, ties in path order. */
export function planShards(files, total, durations) {
  const unique = [...new Set(files.map((file) => file.split(path.sep).join('/')))];
  if (unique.length === 0) throw new Error('no test files given');
  if (total > unique.length) throw new Error(`${total} shards for ${unique.length} files: a shard would run no file`);
  const known = unique.map((file) => durations[file]).filter((value) => typeof value === 'number' && value >= 0);
  const fallback = median(known);
  const weight = (file) => (typeof durations[file] === 'number' && durations[file] >= 0 ? durations[file] : fallback);
  const ordered = unique.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const file of ordered) {
    let target = shards[0];
    for (const shard of shards) if (shard.seconds < target.seconds) target = shard;
    target.files.push(file);
    target.seconds += weight(file);
  }
  // Longest first: node --test starts files in the order given, so a slow file never starts last and runs alone.
  return shards;
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], { cwd: REPO_ROOT, stdio: 'ignore' });
    child.on('close', (code) => resolve({ file, code, seconds: Number(process.hrtime.bigint() - started) / 1e9 }));
  });
}

async function measure(files, out, jobs) {
  const queue = [...files];
  const results = [];
  const worker = async () => {
    while (queue.length > 0) {
      const file = queue.shift();
      const result = await runOne(file);
      results.push(result);
      console.error(`[Test Shards] ${result.seconds.toFixed(1)}s exit ${result.code} ${file}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  const seconds = { ...readDurations(out) };
  for (const result of results) seconds[result.file] = Math.round(result.seconds * 10) / 10;
  const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => (a < b ? -1 : 1)));
  const note = 'Wall-clock seconds per node:test file, each run alone with 3 files at a time. Written by node scripts/ci/test-shards.mjs --measure; only the ratios matter for sharding.';
  fs.writeFileSync(out, `${JSON.stringify({ note, seconds: sorted }, null, 2)}\n`);
  return results.filter((result) => result.code !== 0);
}

async function main(argv) {
  const options = {};
  const files = [];
  for (const arg of argv) {
    const match = /^--(shard|plan|measure|jobs|durations)=(.*)$/.exec(arg);
    if (match) options[match[1]] = match[2];
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else files.push(arg);
  }
  const modes = ['shard', 'plan', 'measure'].filter((mode) => mode in options);
  if (modes.length !== 1) throw new Error('give exactly one of --shard=k/N, --plan=N or --measure=<durations.json>');
  if (options.measure) {
    const failed = await measure(files.map((file) => file.split(path.sep).join('/')), options.measure, Number(options.jobs ?? 3));
    if (failed.length) console.error(`[Test Shards] ${failed.length} files exited non-zero; their times are recorded anyway`);
    return;
  }
  const durations = readDurations(options.durations ?? DEFAULT_DURATIONS);
  if (options.plan) {
    const total = Number(options.plan);
    if (!Number.isInteger(total) || total < 1) throw new Error(`--plan must be a positive integer, got ${options.plan}`);
    planShards(files, total, durations).forEach((shard, i) => {
      console.log(`${i + 1}/${total}\t${shard.seconds.toFixed(0)}s\t${shard.files.length} files`);
    });
    return;
  }
  const { index, total } = parseShard(options.shard);
  const shard = planShards(files, total, durations)[index - 1];
  process.stdout.write(`${shard.files.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[Test Shards] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
