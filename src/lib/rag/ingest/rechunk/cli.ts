import type { RunRechunkInput } from './run';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function main(_argv: string[] = [], _io?: CliIo, _signal?: AbortSignal, _options: Pick<RunRechunkInput, 'scopeFor'> = {}): Promise<number> {
  return 99;
}
