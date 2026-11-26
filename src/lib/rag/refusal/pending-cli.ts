import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rawThresholds from '../../../../eval/config/refusal-thresholds.json';
import { proposedPendingCells, type EnvValues } from './pending';
import { parseThresholds } from './thresholds';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = 'usage: node --import tsx src/lib/rag/refusal/pending-cli.ts --current <env.json> --proposed <env.json> [--thresholds <file.json>]';

const WITH_VALUE = new Set(['--current', '--proposed', '--thresholds']);

export type ParsedPendingArgs = { ok: true; current: string; proposed: string; thresholds: string | null } | { ok: false; error: string };

export function parsePendingArgs(argv: string[]): ParsedPendingArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!WITH_VALUE.has(arg)) return { ok: false, error: `unknown option: ${arg}` };
    const value = argv[(i += 1)];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
    if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
    values.set(arg, value);
  }
  const current = values.get('--current');
  const proposed = values.get('--proposed');
  if (!current) return { ok: false, error: '--current is required' };
  if (!proposed) return { ok: false, error: '--proposed is required' };
  return { ok: true, current, proposed, thresholds: values.get('--thresholds') ?? null };
}

class EnvFileError extends Error {
  constructor(readonly option: string) {
    super(`${option} is not a JSON object of names to string values`);
  }
}

/** A JSON object of env name to string value; anything else is refused without echoing the content. */
function readEnvFile(file: string, option: string): EnvValues {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new EnvFileError(option);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new EnvFileError(option);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(data)) {
    if (typeof value !== 'string') throw new EnvFileError(option);
    values[name] = value;
  }
  return values;
}

/** Config parsing warns with the offending value; the CLI keeps every console line off so no env value is ever printed. */
function quietly<T>(run: () => T): T {
  const saved = { warn: console.warn, log: console.log, info: console.info, error: console.error };
  const silent = (): void => {};
  console.warn = silent;
  console.log = silent;
  console.info = silent;
  console.error = silent;
  try {
    return run();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * D-18 setting check: prints `{ "uncalibrated_cells": [...] }`, the keys of the refusal cells that apply under the current values and stop
 * applying under the proposed ones. Prints cell keys only, never a value from either file. Exit 0 on success, 2 on bad input.
 */
export function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo): number {
  const parsed = parsePendingArgs(argv);
  if (!parsed.ok) {
    io.err(`[Refusal Pending] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  try {
    const current = readEnvFile(parsed.current, '--current');
    const proposed = readEnvFile(parsed.proposed, '--proposed');
    let data: unknown = rawThresholds;
    if (parsed.thresholds) {
      try {
        data = JSON.parse(readFileSync(parsed.thresholds, 'utf8'));
      } catch {
        io.err('[Refusal Pending] --thresholds is not a JSON file');
        return 2;
      }
    }
    const thresholds = parseThresholds(data);
    if (!thresholds) {
      io.err('[Refusal Pending] the refusal thresholds file does not validate');
      return 2;
    }
    const keys = quietly(() => proposedPendingCells(thresholds, current, proposed));
    io.out(JSON.stringify({ uncalibrated_cells: keys }));
    return 0;
  } catch (error) {
    if (error instanceof EnvFileError) {
      io.err(`[Refusal Pending] ${error.message}`);
      return 2;
    }
    throw error;
  }
}

const consoleIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2), consoleIo));
  } catch (error) {
    console.error('[Refusal Pending] failed', { error: error instanceof Error ? error.name : 'unknown' });
    process.exit(1);
  }
}
