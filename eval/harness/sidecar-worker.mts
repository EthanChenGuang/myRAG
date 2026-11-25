import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAG_SIDECAR_ROOT = path.join(REPO_ROOT, 'rag-sidecar');

export interface SpawnSidecarResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  env: Record<string, string>;
}

export interface SpawnSidecarHandle {
  done: Promise<SpawnSidecarResult>;
  kill(): void;
}

type SidecarChildEnv = Record<string, string> & { NODE_ENV: 'test' };

// tiktoken downloads cl100k_base on a cold cache. The file is not vendored (OpenAI publishes it without a license of its own), so every
// child reads it from TIKTOKEN_CACHE_DIR, filled once by scripts/ci/fill-tiktoken-cache.py, and the harness refuses to spawn without it.
const CL100K_URL = 'https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken';
const CL100K_SHA256 = '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7';
const CL100K_CACHE_FILE = crypto.createHash('sha1').update(CL100K_URL).digest('hex');
const verifiedTiktokenDirs = new Set<string>();

/** TIKTOKEN_CACHE_DIR when set, else the git-ignored <repo>/.cache/tiktoken. */
export function tiktokenCacheDir(): string {
  return path.resolve(process.env.TIKTOKEN_CACHE_DIR || path.join(REPO_ROOT, '.cache', 'tiktoken'));
}

function assertTiktokenCache(dir: string): void {
  if (verifiedTiktokenDirs.has(dir)) return;
  let ok = false;
  try {
    ok = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, CL100K_CACHE_FILE))).digest('hex') === CL100K_SHA256;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `[Sidecar harness] tiktoken cl100k_base is not in TIKTOKEN_CACHE_DIR (${dir}), and tests never download it. ` +
        'Fill the cache once with: python3 scripts/ci/fill-tiktoken-cache.py (it honours TIKTOKEN_CACHE_DIR).',
    );
  }
  verifiedTiktokenDirs.add(dir);
}

function buildChildEnv(explicit: Record<string, string>): SidecarChildEnv {
  const env: SidecarChildEnv = { TIKTOKEN_CACHE_DIR: tiktokenCacheDir(), ...explicit, NODE_ENV: 'test' };
  env.RAG_SIDECAR_ENV = 'test';
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.HOMEPATH) env.HOMEPATH = process.env.HOMEPATH;
  return env;
}

function resolvePythonLaunch(): { command: string; argsPrefix: string[]; cwd: string } {
  const uv = spawnSync('sh', ['-c', 'command -v uv 2>/dev/null'], { encoding: 'utf8' });
  const uvBin = uv.stdout?.trim();
  if (uv.status === 0 && uvBin) {
    return {
      command: uvBin,
      argsPrefix: ['run', '--project', RAG_SIDECAR_ROOT, 'python'],
      cwd: REPO_ROOT,
    };
  }
  return { command: 'python3', argsPrefix: [], cwd: RAG_SIDECAR_ROOT };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

export function spawnSidecarModule(
  moduleName: string,
  args: string[],
  env: Record<string, string>,
  options?: { timeoutMs?: number },
): SpawnSidecarHandle {
  const childEnv = buildChildEnv(env);
  assertTiktokenCache(path.resolve(childEnv.TIKTOKEN_CACHE_DIR as string));
  const launch = resolvePythonLaunch();
  if (!launch.argsPrefix.length) {
    childEnv.PYTHONPATH = path.join(RAG_SIDECAR_ROOT, 'src');
  }
  const child = spawn(launch.command, [...launch.argsPrefix, '-m', moduleName, ...args], {
    cwd: launch.cwd,
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const timeoutMs = options?.timeoutMs ?? 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const done = new Promise<SpawnSidecarResult>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, env: childEnv });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr, timedOut, env: childEnv });
    });
  });

  return {
    done,
    kill: () => killTree(child),
  };
}