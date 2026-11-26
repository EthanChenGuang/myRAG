export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function main(_argv: string[], _io: CliIo, _signal?: AbortSignal): Promise<number> {
  return 1;
}
