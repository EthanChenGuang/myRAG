import type { spawn as nodeSpawn } from 'node:child_process';

export type RunnerName = 'worker' | 'ray';

export interface RunnerCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RunnerHandle {
  runner: RunnerName;
  done: Promise<{ exitCode: number | null }>;
  stop(): void;
}

export interface RunnerIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function rayRunnerCommand(_batchId: string, _env: NodeJS.ProcessEnv = process.env): RunnerCommand {
  return { command: '', args: [], cwd: '', env: {} };
}

export function startRunner(runner: RunnerName, _batchId: string, _deps: { io: RunnerIo; spawn?: typeof nodeSpawn }): RunnerHandle {
  return { runner, done: new Promise(() => undefined), stop() {} };
}
