import type { TerminologyKind, TerminologyMode } from './admin';

/** D-23: the nine columns, in this order. */
export const TERMINOLOGY_CSV_COLUMNS = [
  'canonical',
  'variants',
  'language',
  'kind',
  'mode',
  'enabled',
  'note',
  'source_language',
  'target_language',
] as const;

export const TERMINOLOGY_CSV_MAX_BYTES = 1024 * 1024;
export const TERMINOLOGY_CSV_MAX_ROWS = 5000;

/** One data row. Language codes are not checked here: validateEntries reports them against the enabled languages (D-24, D-35). */
export interface TerminologyCsvRow {
  canonical: string;
  variants: string[];
  language: string;
  kind: TerminologyKind;
  mode: TerminologyMode;
  enabled: boolean;
  note: string | null;
  source_language: string | null;
  target_language: string | null;
}

/** row 0 is the header; data rows count from 1. */
export interface TerminologyCsvError {
  row: number;
  message: string;
}

export interface TerminologyCsvParseResult {
  rows: TerminologyCsvRow[];
  errors: TerminologyCsvError[];
  /** The file is over 1 MB or 5,000 rows; nothing is returned. */
  limit: boolean;
}

const KINDS: readonly TerminologyKind[] = ['synonym', 'abbreviation', 'alias', 'identifier', 'translation', 'misspelling'];
const MODES: readonly TerminologyMode[] = ['one_way', 'equivalent'];
const VARIANT_SEPARATOR = '|';
const FORMULA_START = /^'*[=+\-@\t\r]/;
const QUOTED_FORMULA = /^'+[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
const BOM = '﻿';

/** Import side of the D-23 neutralisation: exactly one leading quote is removed, and only before a formula start. */
function unescapeCell(value: string): string {
  return QUOTED_FORMULA.test(value) ? value.slice(1) : value;
}

/** Export side: a value that a spreadsheet would read as a formula (or that already carries such a quote) gets one more quote. */
function neutralise(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * RFC 4180 records: one pass over the text, linear in its length. A quote inside an unquoted field is kept as text; an unterminated
 * quoted field ends the file and is reported by the caller through `unterminated`.
 */
function records(text: string): { records: string[][]; unterminated: boolean } {
  const out: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  let index = 0;
  const endField = () => {
    record.push(field);
    field = '';
    fieldStart = true;
  };
  const endRecord = () => {
    endField();
    out.push(record);
    record = [];
  };
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r' && text[index + 1] === '\n') {
      endRecord();
      index += 2;
      continue;
    }
    if (char === '\n' || char === '\r') {
      endRecord();
      index += 1;
      continue;
    }
    field += char;
    fieldStart = false;
    index += 1;
  }
  if (quoted) return { records: out, unterminated: true };
  if (field !== '' || record.length > 0) endRecord();
  return { records: out, unterminated: false };
}

function isBlank(record: string[]): boolean {
  return record.length === 1 && record[0] === '';
}

function optional(value: string): string | null {
  return value === '' ? null : value;
}

function rowOf(fields: string[], row: number): { ok: true; row: TerminologyCsvRow } | { ok: false; error: TerminologyCsvError } {
  const fail = (message: string) => ({ ok: false as const, error: { row, message } });
  if (fields.length !== TERMINOLOGY_CSV_COLUMNS.length) {
    return fail(`Expected ${TERMINOLOGY_CSV_COLUMNS.length} fields, found ${fields.length}.`);
  }
  const [canonicalCell, variantsCell, languageCell, kindCell, modeCell, enabledCell, noteCell, sourceCell, targetCell] = fields as [
    string, string, string, string, string, string, string, string, string,
  ];
  const canonical = unescapeCell(canonicalCell);
  if (canonical === '') return fail('canonical is empty.');
  if (variantsCell === '') return fail('variants is empty.');
  const variants = variantsCell.split(VARIANT_SEPARATOR).map(unescapeCell);
  if (variants.some((variant) => variant === '')) return fail('variants holds an empty value.');
  const language = unescapeCell(languageCell);
  if (language === '') return fail('language is empty.');
  const kind = KINDS.find((value) => value === kindCell);
  if (!kind) return fail('kind is not one of the entry kinds.');
  const mode = modeCell === '' ? 'one_way' : MODES.find((value) => value === modeCell);
  if (!mode) return fail('mode is not one_way or equivalent.');
  const enabledText = enabledCell.toLowerCase();
  if (enabledText !== '' && enabledText !== 'true' && enabledText !== 'false') return fail('enabled is not true or false.');
  return {
    ok: true,
    row: {
      canonical,
      variants,
      language,
      kind,
      mode,
      enabled: enabledText !== 'false',
      note: optional(unescapeCell(noteCell)),
      source_language: optional(unescapeCell(sourceCell)),
      target_language: optional(unescapeCell(targetCell)),
    },
  };
}

/**
 * Strict D-23 parse: UTF-8 with or without BOM, CRLF or LF, RFC 4180 quoting, the nine-column header in order. Never throws on
 * file content: a bad header is one error on row 0, a bad row is an error with its 1-based number, and a file over 1 MB or 5,000
 * rows returns only the limit error.
 */
export function parseTerminologyCsv(input: string): TerminologyCsvParseResult {
  const text = typeof input === 'string' ? input : '';
  if (Buffer.byteLength(text, 'utf8') > TERMINOLOGY_CSV_MAX_BYTES) {
    return { rows: [], errors: [{ row: 0, message: 'The file is larger than 1 MB.' }], limit: true };
  }
  const parsed = records(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  const all = parsed.records;
  while (all.length > 0 && isBlank(all[all.length - 1]!)) all.pop();
  const header = all[0];
  if (!header || header.join(',') !== TERMINOLOGY_CSV_COLUMNS.join(',')) {
    return { rows: [], errors: [{ row: 0, message: `The header must be ${TERMINOLOGY_CSV_COLUMNS.join(',')}.` }], limit: false };
  }
  const data = all.slice(1);
  if (data.length > TERMINOLOGY_CSV_MAX_ROWS) {
    return { rows: [], errors: [{ row: 0, message: `The file has more than ${TERMINOLOGY_CSV_MAX_ROWS} rows.` }], limit: true };
  }
  const rows: TerminologyCsvRow[] = [];
  const errors: TerminologyCsvError[] = [];
  data.forEach((fields, index) => {
    const result = rowOf(fields, index + 1);
    if (result.ok) rows.push(result.row);
    else errors.push(result.error);
  });
  if (parsed.unterminated) errors.push({ row: data.length, message: 'A quoted field is not closed.' });
  return { rows, errors, limit: false };
}

/** D-23 export: the nine-column header, CRLF line ends, every cell that could start a formula prefixed with one quote. */
export function serializeTerminologyCsv(rows: readonly TerminologyCsvRow[]): string {
  const lines = [TERMINOLOGY_CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const cells = [
      neutralise(row.canonical),
      row.variants.map(neutralise).join(VARIANT_SEPARATOR),
      neutralise(row.language),
      row.kind,
      row.mode,
      row.enabled ? 'true' : 'false',
      neutralise(row.note ?? ''),
      neutralise(row.source_language ?? ''),
      neutralise(row.target_language ?? ''),
    ];
    lines.push(cells.map(quote).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
