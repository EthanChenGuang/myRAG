const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const CN_RESIDENT_ID = /\b\d{17}[\dXx]\b/g;
const IT_CODICE_FISCALE = /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const PHONE_INTERNATIONAL = /(?:\+|00)\d[\d ()-]{7,}\d/g;
const PHONE_CN_MOBILE = /\b1[3-9]\d{9}\b/g;

const MAX_DEPTH = 12;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskString(text: string): string {
  return text
    .replace(EMAIL, '[EMAIL]')
    .replace(IBAN, '[IBAN]')
    .replace(CN_RESIDENT_ID, '[ID]')
    .replace(IT_CODICE_FISCALE, '[ID]')
    .replace(CARD_CANDIDATE, (match) => (luhnValid(match.replace(/\D/g, '')) ? '[CARD]' : match))
    .replace(PHONE_INTERNATIONAL, '[PHONE]')
    .replace(PHONE_CN_MOBILE, '[PHONE]');
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function maskValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return maskString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = maskValue(item, depth + 1);
  return out;
}

/** Replaces e-mail, IBAN, ID, card and phone patterns in strings, recursing into plain objects and arrays without mutating the input. */
export function maskPII<T>(value: T): T {
  return maskValue(value, 0) as T;
}

/** D-25: a kept chunk as the Langfuse export receives it; `restricted` chunks carry only their id, rank and score. */
export interface ExportChunk {
  chunk_id: string;
  document_id: string;
  document_name: string;
  content: string;
  similarity: number;
  rank: number;
}

export type ExportedChunk =
  | { document_name: string; content: string; similarity: number; rank: number }
  | { chunk_id: string; similarity: number; rank: number };

export interface StrippableTrace {
  review?: { query?: string; answer?: string; context?: string; model?: string };
  content?: { query?: string; chunks?: ExportedChunk[] };
}

/**
 * D-25: true for a document whose label set is anything other than exactly `all`. With access on, a document without a known label
 * set counts as restricted (labels: null for the request means access is off and nothing is restricted).
 */
export function isRestrictedDocument(labels: ReadonlyMap<string, readonly string[]> | null, documentId: string): boolean {
  if (labels === null) return false;
  const set = labels.get(documentId);
  return !set || set.length !== 1 || set[0] !== 'all';
}

/**
 * D-25: builds the exported chunk list and, when any kept chunk comes from a restricted document, removes the text Langfuse would
 * otherwise receive: restricted chunks keep id, rank and score only, and review exports lose query, context and answer. Pure; with
 * labels null (access off) the output equals today's export.
 */
export function stripRestrictedContent<T extends StrippableTrace>(
  collected: T,
  labels: ReadonlyMap<string, readonly string[]> | null,
  kept: readonly ExportChunk[],
  /** T-04.3-143: documents that count as kept without a chunk (the cached sources of a semantic-cache hit). */
  sourceDocumentIds: readonly string[] = [],
): T {
  const restricted =
    kept.some((chunk) => isRestrictedDocument(labels, chunk.document_id)) || sourceDocumentIds.some((id) => isRestrictedDocument(labels, id));
  const out: T = { ...collected };
  if (out.content?.chunks !== undefined) {
    out.content = {
      ...out.content,
      chunks: kept.map((chunk) =>
        isRestrictedDocument(labels, chunk.document_id)
          ? { chunk_id: chunk.chunk_id, similarity: chunk.similarity, rank: chunk.rank }
          : { document_name: chunk.document_name, content: chunk.content, similarity: chunk.similarity, rank: chunk.rank },
      ),
    };
  }
  if (restricted && out.review !== undefined) {
    out.review = out.review.model !== undefined ? { model: out.review.model } : {};
  }
  return out;
}
