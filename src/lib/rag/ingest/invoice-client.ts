import type { InvoiceFields } from '@/lib/rag-eval/contracts.generated';

export const INVOICE_LLM_MODEL_ID = 'google/gemini-2.5-flash-lite';

export interface InvoiceClientConfig {
  baseUrl: string;
  secret: string;
}

export interface InvoiceClientOverrides {
  fetch?: typeof fetch;
  config?: () => InvoiceClientConfig | null;
}

export class InvoiceClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`[Invoice Client] ${code}`);
    this.name = 'InvoiceClientError';
    this.code = code;
  }
}

export interface InvoiceExtractCall {
  markdown: string;
  tables?: string[];
  languageHint?: 'zh' | 'en' | 'it' | null;
  signal: AbortSignal;
}

export function setInvoiceClientForTests(_overrides: InvoiceClientOverrides | null): void {}

export async function extractInvoice(_call: InvoiceExtractCall): Promise<InvoiceFields> {
  throw new InvoiceClientError('not_implemented');
}

export interface InvoiceLlmInput {
  markdown: string;
  missing: string[];
  signal: AbortSignal;
}

export type InvoiceLlmCall = (input: InvoiceLlmInput) => Promise<unknown>;

export function setInvoiceLlmForTests(_call: InvoiceLlmCall | null): void {}

export interface FillResult {
  fields: InvoiceFields;
  filled: string[];
  warning?: string;
}

export async function fillInvoiceFields(fields: InvoiceFields, _input: { markdown: string; signal: AbortSignal }): Promise<FillResult> {
  return { fields, filled: [] };
}
