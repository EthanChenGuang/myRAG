import type { OrchestrateDeps } from './orchestrate';
import type { RunnerIo } from './runners';

export const USAGE = 'usage: npm run rag:backfill -- --tenant <key> --source <folder|bucket|manifest>:<ref>';

export async function main(
  _argv: string[] = process.argv.slice(2),
  _io: RunnerIo = { out: (line) => console.log(line), err: (line) => console.error(line) },
  _signal?: AbortSignal,
  _overrides: Partial<Omit<OrchestrateDeps, 'signal' | 'io'>> = {},
): Promise<number> {
  return 1;
}
