import type { RpcClient } from '../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';

export interface InvoiceFilters {
  /** A supplier name fragment (case-insensitive, matched as text) or a supplier tax id. */
  supplier?: string;
  /** Inclusive ISO dates (YYYY-MM-DD) on the invoice issue date. */
  dateRange?: { from?: string; to?: string };
  /** Inclusive bounds on the gross total, compared as numbers. */
  amountRange?: { min?: string | number; max?: string | number };
  currency?: string;
  limit?: number;
}

export interface InvoiceHit {
  documentId: string;
  filename: string;
  invoiceNumber: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  issueDate: string | null;
  grossTotal: string | null;
  currency: string | null;
}

export interface FindInvoicesDeps {
  /** The admin client; unset, the server's admin client is used. */
  db?: () => RpcClient | null;
  signal?: AbortSignal;
}

export class InvoiceFilterError extends Error {
  readonly filter: string;

  constructor(filter: string) {
    super(`[Invoices] invalid filter: ${filter}`);
    this.name = 'InvoiceFilterError';
    this.filter = filter;
  }
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SUPPLIER_CHARS = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d{1,16}(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;

function isoDate(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new InvoiceFilterError(name);
  return value;
}

function amount(name: string, value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  if (!DECIMAL.test(text)) throw new InvoiceFilterError(name);
  return text;
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function adminClient(): Promise<RpcClient | null> {
  const { getSupabaseAdmin } = await import('@/lib/supabase');
  return getSupabaseAdmin() as unknown as RpcClient | null;
}

/**
 * Current, ready invoices of the scope's tenant that match the filters, newest issue date first. The tenant key is the scope's and
 * nothing else; the SQL function repeats the tenant, current and ready predicates. Invalid filters throw InvoiceFilterError before any call.
 */
export async function findInvoices(scope: TenantScope, filters: InvoiceFilters = {}, deps: FindInvoicesDeps = {}): Promise<InvoiceHit[]> {
  assertTenantScope(scope);
  const supplier = filters.supplier?.trim() ?? '';
  if (supplier.length > MAX_SUPPLIER_CHARS) throw new InvoiceFilterError('supplier');
  const currency = filters.currency ?? null;
  if (currency !== null && !CURRENCY.test(currency)) throw new InvoiceFilterError('currency');
  const limit = filters.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new InvoiceFilterError('limit');
  const args = {
    p_tenant_key: scopeKey(scope).toLowerCase(),
    p_supplier: supplier === '' ? null : supplier,
    p_date_from: isoDate('dateRange.from', filters.dateRange?.from),
    p_date_to: isoDate('dateRange.to', filters.dateRange?.to),
    p_amount_min: amount('amountRange.min', filters.amountRange?.min),
    p_amount_max: amount('amountRange.max', filters.amountRange?.max),
    p_currency: currency,
    p_limit: limit,
  };

  const signal = deps.signal ?? new AbortController().signal;
  const db = deps.db ? deps.db() : await adminClient();
  if (!db) throw new Error('[Invoices] the admin database client is not configured');
  signal.throwIfAborted();
  const response = await db.rpc('rag_find_invoices', args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new Error(`[Invoices] rag_find_invoices failed (${response.error.code ?? 'error'})`);

  return ((response.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    documentId: String(row.document_id),
    filename: String(row.filename ?? ''),
    invoiceNumber: (row.invoice_number as string | null) ?? null,
    supplierName: (row.supplier_name as string | null) ?? null,
    supplierTaxId: (row.supplier_tax_id as string | null) ?? null,
    issueDate: dateText(row.issue_date),
    grossTotal: (row.gross_total as string | null) ?? null,
    currency: (row.currency as string | null) ?? null,
  }));
}
