import type { SettingValues } from './settings-hash.cjs';

export type RagGateInput = { check_id?: string; override?: { reason?: string }; skipped?: boolean } | null | undefined;
export type SaveDecision =
  | { kind: 'write'; gateResult: 'pass' | 'fail' | 'error' | 'skipped' | 'not_required'; checkId: string | null; overrideReason: string | null }
  | { kind: 'refuse'; status: 400 | 409; error: 'invalid_reason' | 'rag_gate_required' };
export interface CheckLike {
  check_id: string;
  status: string;
  rag_settings_hash: string;
  result?: string | null;
  [key: string]: unknown;
}
export interface DecideSaveInput {
  mode?: string | null;
  before: SettingValues;
  after: SettingValues;
  ragGate?: RagGateInput;
  readCheck?: (id: string) => CheckLike | null | Promise<CheckLike | null>;
  names?: Iterable<string>;
}
export interface BuildChangeRecordInput {
  actor: string;
  source: string;
  gateResult: string;
  before?: SettingValues;
  after?: SettingValues;
  names?: Iterable<string>;
  changedKeys?: readonly string[];
  beforeHash?: string;
  afterHash?: string;
  retrievalConfigHash?: string | null;
  check?: CheckLike | null;
  overrideReason?: string | null;
  uncalibratedCells?: readonly string[];
  releaseSha?: string | null;
  githubActor?: string | null;
}
export interface ChangeRecordRow {
  actor: string;
  source: string;
  changed_keys: string[];
  before_hash: string;
  after_hash: string;
  retrieval_config_hash: string | null;
  gate_result: string;
  gate_summary: {
    checks: number;
    failed: number;
    skipped: number;
    offenders: string[];
    layers: Record<string, string>;
    release_sha?: string;
    github_actor?: string;
  };
  override_reason: string | null;
  uncalibrated_cells: string[];
}
export interface CheckReadOptions {
  validate?: (check: unknown) => boolean;
}

export declare const OVERRIDE_REASON_MIN: number;
export declare const OVERRIDE_REASON_MAX: number;
export declare const CHECK_CACHE_MS: number;
export declare const CHECK_DIR: string;
export declare function normaliseMode(mode: unknown): 'off' | 'warn' | 'enforce';
export declare function decideSave(input: DecideSaveInput): Promise<SaveDecision>;
export declare function buildChangeRecord(input: BuildChangeRecordInput): ChangeRecordRow;
export declare function insertChangeRecord(client: unknown, row: ChangeRecordRow): Promise<{ ok: true; id: string } | { ok: false; reason: 'insert_failed' }>;
export declare function listChangeRecords(
  client: unknown,
  options: { since: string; limit: number },
): Promise<{ ok: true; records: unknown[] } | { ok: false; reason: 'read_failed' }>;
export declare function writeCheck(root: string, check: CheckLike): { ok: true } | { ok: false; reason: 'invalid_check' | 'write_failed' };
export declare function readCheck(root: string, id: string, options?: CheckReadOptions): CheckLike | null;
export declare function latestCheck(root: string, options?: CheckReadOptions): CheckLike | null;
export declare function cachedCheck(root: string, hash: string, nowMs: number, options?: CheckReadOptions): CheckLike | null;
