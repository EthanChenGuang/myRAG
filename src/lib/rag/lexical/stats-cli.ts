import type { LexstatsDb } from './stats-admin';

export const USAGE = 'usage: npm run rag:lexstats -- <enable|rebuild|compact|check|status|disable> [--tenant <key> | --all]';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface LexstatsDeps {
  db: LexstatsDb;
  scoringMode: 'ts_rank_cd' | 'bm25';
}

export type ParsedLexstatsArgs = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export function parseLexstatsArgs(_argv: string[]): ParsedLexstatsArgs {
  return { ok: false, error: 'not implemented' };
}

export async function runLexstatsCli(_argv: string[], _io: CliIo, _deps: LexstatsDeps): Promise<number> {
  return 99;
}
