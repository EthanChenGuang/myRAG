export function parseMineArgs(_argv: string[]): { ok: boolean } & Record<string, unknown> {
  return { ok: false };
}

export async function main(_argv: string[], _io: { out: (line: string) => void; err: (line: string) => void }, _deps: Record<string, unknown> = {}): Promise<number> {
  return 1;
}
