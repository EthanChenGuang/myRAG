export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export type ParsedScopeCentroidArgs = { ok: true; help: boolean; tenantKey: string | null; profileId: string | null } | { ok: false; error: string };

export function parseScopeCentroidArgs(_argv: string[]): ParsedScopeCentroidArgs {
  return { ok: false, error: 'not implemented' };
}

export async function main(_argv: string[], _io: CliIo): Promise<number> {
  return 99;
}
