import {
  ConfigChangeRecordSchema,
  ConfigGateCheckSchema,
  type ConfigChangeRecord,
  type ConfigGateCheck,
} from '@/lib/rag-eval/contracts.generated';
import * as core from './gate-core.cjs';
import type { BuildChangeRecordInput, ChangeRecordRow, DecideSaveInput, RagGateInput, SaveDecision } from './gate-core.cjs';
import { RAG_AFFECTING_NAMES } from './settings-hash';

export type { BuildChangeRecordInput, ChangeRecordRow, ConfigChangeRecord, ConfigGateCheck, RagGateInput, SaveDecision };

/** The part of a Supabase client the change-record helpers use. */
export interface ChangeRecordClient {
  from(table: string): unknown;
}

export const OVERRIDE_REASON_MIN: number = core.OVERRIDE_REASON_MIN;
export const OVERRIDE_REASON_MAX: number = core.OVERRIDE_REASON_MAX;
export const CHECK_CACHE_MS: number = core.CHECK_CACHE_MS;
export const CHECK_DIR: string = core.CHECK_DIR;
export const normaliseGateMode = core.normaliseMode;

const VALIDATE = { validate: (check: unknown) => ConfigGateCheckSchema.safeParse(check).success };

function asCheck(value: unknown): ConfigGateCheck | null {
  const parsed = ConfigGateCheckSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface DecideSaveOptions extends Omit<DecideSaveInput, 'readCheck' | 'ragGate'> {
  ragGate?: RagGateInput;
  readCheck?: (id: string) => ConfigGateCheck | null | Promise<ConfigGateCheck | null>;
}

/** D-10, D-15: the shared save decision; a check that fails ConfigGateCheckSchema counts as no check. */
export function decideSave(input: DecideSaveOptions): Promise<SaveDecision> {
  const reader = input.readCheck;
  return core.decideSave({
    ...input,
    names: input.names ?? RAG_AFFECTING_NAMES,
    readCheck: reader ? async (id: string) => asCheck(await reader(id)) : undefined,
  });
}

export function buildChangeRecord(input: BuildChangeRecordInput): ChangeRecordRow {
  return core.buildChangeRecord({ ...input, names: input.names ?? RAG_AFFECTING_NAMES });
}

export function insertChangeRecord(client: ChangeRecordClient, row: ChangeRecordRow) {
  return core.insertChangeRecord(client, row);
}

/** Rows that fail ConfigChangeRecordSchema are left out. */
export async function listChangeRecords(
  client: ChangeRecordClient,
  options: { since: string; limit: number },
): Promise<{ ok: true; records: ConfigChangeRecord[] } | { ok: false; reason: 'read_failed' }> {
  const result = await core.listChangeRecords(client, options);
  if (!result.ok) return result;
  const records: ConfigChangeRecord[] = [];
  for (const row of result.records) {
    const parsed = ConfigChangeRecordSchema.safeParse(row);
    if (parsed.success) records.push(parsed.data);
  }
  return { ok: true, records };
}

export function writeCheck(root: string, check: ConfigGateCheck) {
  return asCheck(check) ? core.writeCheck(root, check) : ({ ok: false, reason: 'invalid_check' } as const);
}

export function readCheck(root: string, id: string): ConfigGateCheck | null {
  return asCheck(core.readCheck(root, id, VALIDATE));
}

export function latestCheck(root: string): ConfigGateCheck | null {
  return asCheck(core.latestCheck(root, VALIDATE));
}

export function cachedCheck(root: string, hash: string, nowMs: number): ConfigGateCheck | null {
  return asCheck(core.cachedCheck(root, hash, nowMs, VALIDATE));
}
