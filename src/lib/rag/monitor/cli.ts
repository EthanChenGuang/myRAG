export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = '';

export function parseMonitorArgs(_argv: string[]): { command: string } {
  return { command: 'none' };
}

export async function main(_argv: string[], _io: CliIo, _deps: Record<string, unknown> = {}): Promise<number> {
  return -1;
}
