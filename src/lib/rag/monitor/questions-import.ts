import type { SupabaseClient } from '@supabase/supabase-js';

export const IMPORT_LIMITS = {
  maxFileBytes: 0,
  maxRows: 0,
  maxQuestionChars: 0,
  maxBatchBytes: 0,
  maxBatchRows: 0,
} as const;

export type QuestionFileFormat = 'csv' | 'jsonl';

export type ParseResult = { ok: true; values: Array<string | null> } | { ok: false; reason: 'column_not_found' | 'too_many_rows' };

export interface PreparedQuestion {
  queryMasked: string;
  fingerprint: string;
  language: string;
}

export interface PreparedQuestions {
  rows: PreparedQuestion[];
  read: number;
  empty: number;
  truncated: number;
  rejectedPii: number;
  duplicatesInFile: number;
}

export interface ImportCounts {
  read: number;
  added: number;
  duplicates: number;
  rejected_pii: number;
  truncated: number;
  empty: number;
  by_language: Record<string, number>;
}

export function parseQuestionFile(_text: string, _options: { format: QuestionFileFormat; column: string }): ParseResult {
  return { ok: true, values: [] };
}

export function prepareQuestions(_values: readonly unknown[], _options: { fingerprint?: (masked: string) => string } = {}): PreparedQuestions {
  return { rows: [], read: 0, empty: 0, truncated: 0, rejectedPii: 0, duplicatesInFile: 0 };
}

export async function importQuestions(
  _admin: Pick<SupabaseClient, 'from' | 'rpc'>,
  _input: { tenantKey: string; prepared: PreparedQuestions; dryRun: boolean; now?: Date },
): Promise<ImportCounts> {
  return { read: 0, added: 0, duplicates: 0, rejected_pii: 0, truncated: 0, empty: 0, by_language: {} };
}
