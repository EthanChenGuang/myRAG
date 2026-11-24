import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantScope } from '../tenant/scope';

export interface InvoiceFilters {
  supplier?: string;
  dateRange?: { from?: string; to?: string };
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
  db?: () => RpcClient | null;
  signal?: AbortSignal;
}

export async function findInvoices(_scope: TenantScope, _filters: InvoiceFilters = {}, _deps: FindInvoicesDeps = {}): Promise<InvoiceHit[]> {
  return [];
}
