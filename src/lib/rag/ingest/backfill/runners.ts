import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export type RunnerName = 'worker' | 'ray';

export interface RunnerCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RunnerHandle {
  runner: RunnerName;
  /** Settles when the runner process exits; never settles for the always-on worker, which this process does not own. */
  done: Promise<{ exitCode: number | null }>;
  stop(): void;
}

export interface RunnerIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const RAG_SIDECAR_DIR = path.join(REPO_ROOT, 'rag-sidecar');

/**
 * D-37: `uv run --project rag-sidecar --extra ray python -m rag_sidecar.ingest.ray_runner --batch <id>`. An argument array, never a shell
 * line, and the batch id must be a UUID (T-03.1-108). The runner inherits the operator's environment; RAY_ADDRESS is passed through when
 * set, and left out when empty so Ray starts a local instance.
 */
export function rayRunnerCommand(batchId: string, env: NodeJS.ProcessEnv = process.env): RunnerCommand {
  if (!BATCH_ID.test(batchId)) throw new Error('[Backfill] the batch id must be a UUID');
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (typeof childEnv.RAY_ADDRESS !== 'string' || childEnv.RAY_ADDRESS.trim() === '') delete childEnv.RAY_ADDRESS;
  return {
    command: 'uv',
    args: ['run', '--project', RAG_SIDECAR_DIR, '--extra', 'ray', 'python', '-m', 'rag_sidecar.ingest.ray_runner', '--batch', batchId.toLowerCase()],
    cwd: REPO_ROOT,
    env: childEnv,
  };
}

function pipeLines(stream: NodeJS.ReadableStream | null | undefined, write: (line: string) => void): void {
  if (!stream) return;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', (line) => write(`[Backfill][ray] ${line}`));
}

/**
 * worker: the always-on sidecar worker claims the batch's jobs (the claim function enforces the batch concurrency), so nothing is started.
 * ray: spawns the Ray runner for the batch and streams its output. Either runner claims through the same ledger function, so a batch can
 * switch runners between runs.
 */
export function startRunner(runner: RunnerName, batchId: string, deps: { io: RunnerIo; spawn?: typeof nodeSpawn }): RunnerHandle {
  if (runner === 'worker') {
    return { runner, done: new Promise(() => undefined), stop() {} };
  }
  const command = rayRunnerCommand(batchId);
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn(command.command, command.args, { cwd: command.cwd, env: command.env, stdio: ['ignore', 'pipe', 'pipe'] });
  pipeLines(child.stdout, deps.io.out);
  pipeLines(child.stderr, deps.io.err);
  const done = new Promise<{ exitCode: number | null }>((resolve) => {
    child.once('close', (code: number | null) => resolve({ exitCode: code }));
    child.once('error', () => {
      deps.io.err('[Backfill] the Ray runner could not be started (is uv installed?)');
      resolve({ exitCode: 1 });
    });
  });
  let stopped = false;
  return {
    runner,
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
