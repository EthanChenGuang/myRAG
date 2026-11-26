export const USAGE = '';

export function parseAttributesArgs(_argv: string[]): { ok: boolean; [key: string]: unknown } {
  return { ok: false, error: 'not implemented' };
}

export async function main(_argv: string[], _io: { out: (line: string) => void; err: (line: string) => void }, _signal: AbortSignal, _overrides: Record<string, unknown> = {}): Promise<number> {
  return 99;
}
