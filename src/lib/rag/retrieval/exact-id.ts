import { RetrievalBackendError, type RpcClient } from '../backend/supabase-rpc';
import { IDENTIFIER_PATTERN } from '../ids/shapes';
import { classifyTaxId, type TaxIdScheme } from '../ids/tax-ids';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import type { Candidate } from '../types';

export type ExactIdKind = 'invoice' | 'tax_id' | 'model';

export interface ExactIdToken {
  /** The text looked up: tax ids are normalised, the other kinds are as written. */
  value: string;
  kind: ExactIdKind;
  scheme?: TaxIdScheme;
}

export const MAX_EXACT_ID_TOKENS = 8;
const MAX_QUERY_CHARS = 4000;
const MIN_TOKEN_CHARS = 4;
const MAX_TOKEN_CHARS = 64;

const INVOICE_CUE = /发票|發票|账单|賬單|单据|單據|收据|收據|invoice|receipt|\bbill\b|fattura|ricevuta|nota di credito|credit note/iu;
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\d/u;
const PLAIN_NUMBER = /^\d{5,20}$/;
const TWO_GROUP_NUMBER = /^\d{1,6}[/-]\d{1,6}$/;
// Tax ids typed with spaces, which the identifier shape cannot hold; bounded so the scan stays linear.
const SPACED_TAX_ID = /(?<![\p{L}\p{N}])(?:[A-Za-z]{2} ?)?\d(?:[ .-]?\d){9,20}(?![\p{L}\p{N}])/gu;

interface Found {
  index: number;
  token: ExactIdToken;
}

function isPlainInvoiceNumber(token: string): boolean {
  if (PLAIN_NUMBER.test(token)) return true;
  return TWO_GROUP_NUMBER.test(token) && token.replace(/\D/gu, '').length >= 5;
}

function classifyIdentifier(token: string, invoiceCue: boolean): ExactIdToken | null {
  if (token.length > MAX_TOKEN_CHARS) return null;
  const tax = classifyTaxId(token);
  if (tax.valid) return { value: tax.normalized, kind: 'tax_id', scheme: tax.scheme };
  if (token.length >= MIN_TOKEN_CHARS && HAS_LETTER.test(token) && HAS_DIGIT.test(token)) {
    return { value: token, kind: invoiceCue ? 'invoice' : 'model' };
  }
  if (invoiceCue && isPlainInvoiceNumber(token)) return { value: token, kind: 'invoice' };
  return null;
}

/**
 * Identifier-shaped tokens of a question that an exact lookup can use: valid tax ids, invoice numbers and model numbers.
 * Shapes come from the lexical tokenizer, so a token matches the lexical_text written at ingestion. Plain words, years, dates and
 * amounts give nothing; a digits-only number counts as an invoice number only when the question speaks of an invoice.
 */
export function extractExactIds(query: string): ExactIdToken[] {
  const text = query.normalize('NFKC').slice(0, MAX_QUERY_CHARS);
  const invoiceCue = INVOICE_CUE.test(text);
  const found: Found[] = [];
  const spacedSpans: Array<[number, number]> = [];

  for (const match of text.matchAll(SPACED_TAX_ID)) {
    if (!/[ ]/u.test(match[0])) continue;
    const tax = classifyTaxId(match[0]);
    if (!tax.valid) continue;
    const index = match.index ?? 0;
    spacedSpans.push([index, index + match[0].length]);
    found.push({ index, token: { value: tax.normalized, kind: 'tax_id', scheme: tax.scheme } });
  }

  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const index = match.index ?? 0;
    if (spacedSpans.some(([start, end]) => index >= start && index < end)) continue;
    const token = classifyIdentifier(match[0], invoiceCue);
    if (token) found.push({ index, token });
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: ExactIdToken[] = [];
  for (const { token } of found) {
    const key = token.value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= MAX_EXACT_ID_TOKENS) break;
  }
  return out;
}

export const EXACT_ID_LIMIT = 10;
const MAX_LOOKUP_VALUES = 20;
const RPC_NAME = 'rag_exact_id_documents';

export interface ExactIdRow {
  chunk_id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  matched_field: string;
}

export interface ExactIdLookupOptions {
  client: RpcClient;
  signal: AbortSignal;
  limit?: number;
}

export interface ExactIdStageResult {
  rows: ExactIdRow[];
  tokenCount: number;
}

/** The texts sent to the lookup: each token once, plus the Italian VAT number with and without its IT prefix. */
function lookupValues(tokens: ExactIdToken[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  for (const token of tokens) {
    add(token.value);
    if (token.kind !== 'tax_id') continue;
    if (token.scheme === 'eu_vat' && token.value.startsWith('IT')) add(token.value.slice(2));
    if (token.scheme === 'it_iva') add(`IT${token.value}`);
  }
  return out.slice(0, MAX_LOOKUP_VALUES);
}

function toRow(raw: unknown): ExactIdRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.chunk_id !== 'string' || typeof row.document_id !== 'string') return null;
  const metadata = typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : null;
  return {
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    content: typeof row.content === 'string' ? row.content : '',
    metadata,
    matched_field: typeof row.matched_field === 'string' ? row.matched_field : '',
  };
}

/**
 * Current, ready chunks of the scope's tenant that carry one of the tokens (invoice number or supplier tax id column, or the token as a whole
 * word of the chunk's lexical text). The tenant key is the scope's and nothing else, the tokens travel as one text[] parameter, and the SQL
 * function repeats the tenant, current and ready predicates. No tokens, no call.
 */
export async function exactIdLookup(scope: TenantScope, tokens: ExactIdToken[], options: ExactIdLookupOptions): Promise<ExactIdRow[]> {
  assertTenantScope(scope);
  const values = lookupValues(tokens);
  if (values.length === 0) return [];
  const { client, signal } = options;
  signal.throwIfAborted();
  const response = await client
    .rpc(RPC_NAME, { p_tenant_key: scopeKey(scope).toLowerCase(), p_tokens: values, p_limit: options.limit ?? EXACT_ID_LIMIT })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RetrievalBackendError(RPC_NAME, response.error.code ?? null);
  return (response.data ?? []).map(toRow).filter((row): row is ExactIdRow => row !== null);
}

/** Extracts the identifiers of a question and looks them up; a question with none costs no call. */
export async function exactIdStage(query: string, scope: TenantScope, options: ExactIdLookupOptions): Promise<ExactIdStageResult> {
  const tokens = extractExactIds(query);
  if (tokens.length === 0) return { rows: [], tokenCount: 0 };
  return { rows: await exactIdLookup(scope, tokens, options), tokenCount: tokens.length };
}

/**
 * Puts the exact chunks ahead of the vector candidates. A chunk both routes found is listed once, as an exact match, with what the vector
 * route knew about it. Exact chunks score as high as the best vector candidate and similarity 1, so the legacy ranking (a stable sort) and
 * the relevance filters keep them in front. The list does not grow past maxResults unless the exact chunks alone exceed it.
 */
export function mergeExactCandidates(vector: Candidate[], rows: ExactIdRow[], maxResults: number): Candidate[] {
  if (rows.length === 0) return vector;
  const known = new Map(vector.map((candidate) => [candidate.chunk_id, candidate]));
  const top = vector.reduce((best, candidate) => Math.max(best, candidate.final_score), 1);
  const taken = new Set<string>();
  const exact: Candidate[] = [];
  for (const row of rows) {
    if (taken.has(row.chunk_id)) continue;
    taken.add(row.chunk_id);
    const seen = known.get(row.chunk_id);
    exact.push(
      seen
        ? { ...seen, similarity: 1, final_score: top, match_reason: 'exact_id' }
        : {
            chunk_id: row.chunk_id,
            document_id: row.document_id,
            content: row.content,
            similarity: 1,
            metadata: row.metadata,
            temporal_score: 0,
            financial_score: 0,
            final_score: top,
            match_reason: 'exact_id',
          },
    );
  }
  const rest = vector.filter((candidate) => !taken.has(candidate.chunk_id));
  return [...exact, ...rest].slice(0, Math.max(maxResults, exact.length));
}
