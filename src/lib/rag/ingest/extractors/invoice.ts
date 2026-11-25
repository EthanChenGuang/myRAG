import type { InvoiceFields } from '@/lib/rag-eval/contracts.generated';
import { detectLanguage } from '../../lang/detect';
import { lexicalText } from '../../lexical/tokenize';
import { scanText } from '../../security/injection-scan';
import { extractInvoice, fillInvoiceFields, InvoiceClientError } from '../invoice-client';
import { IngestStageError, requireDocument, type StageContext } from '../types';
import { IngestWriterError } from '../writer';
import type { DocumentExtractor } from './index';

const MAX_TABLES = 500;
const MAX_TABLE_CHARS = 500_000;
const MAX_ERROR_CODES = 10;
const MAX_SNIPPETS = 3;
const NAME_LIMIT = 300;
const ID_LIMIT = 64;
const AMOUNT = /^-?\d{1,16}(\.\d{1,4})?$/;
const ERROR_CODE = /^[a-z0-9_:.-]{1,64}$/i;

/** Error codes that may be stored: the extractor's own fixed words, never free text. */
function safeCodes(codes: readonly string[] | undefined): string[] {
  return (codes ?? []).filter((code) => ERROR_CODE.test(code)).slice(0, MAX_ERROR_CODES);
}

function tablesOf(ctx: StageContext): string[] {
  return (ctx.work.parseChunks ?? [])
    .filter((chunk) => chunk.is_table && chunk.text.length <= MAX_TABLE_CHARS)
    .map((chunk) => chunk.text)
    .slice(0, MAX_TABLES);
}

/** Every string the extraction produced, as one scan unit each. */
function extractedStrings(fields: InvoiceFields): string[] {
  return [
    fields.invoice_number,
    fields.supplier?.name,
    fields.supplier?.tax_id,
    fields.buyer?.name,
    fields.buyer?.tax_id,
    ...(fields.line_items ?? []).map((item) => item.description),
  ].filter((value): value is string => typeof value === 'string' && value !== '');
}

async function recordFailure(ctx: StageContext, documentId: string, errors: string[]): Promise<void> {
  const codes = errors.length > 0 ? errors : ['extraction_failed'];
  console.warn('[Ingest] invoice extraction failed', { errorClass: codes[0] });
  ctx.state.invoice = { extractor: 'sidecar', status: 'failed' };
  await ctx.writer.setFields(documentId, { metadata: { invoice_extraction: { status: 'failed', errors: codes } } });
}

/** Scans the extracted text; a match quarantines the document the way the scan_injection stage does. Returns true on a match. */
async function quarantineOnMatch(ctx: StageContext, documentId: string, fields: InvoiceFields): Promise<boolean> {
  const { profile } = ctx.identity ?? {};
  if (ctx.config.injectionScan === 'off' || !profile?.scan_injection) return false;
  const ruleIds = new Set<string>();
  const snippets: string[] = [];
  try {
    for (const text of extractedStrings(fields)) {
      const result = scanText(text);
      if (!result.matched) continue;
      for (const id of result.rule_ids) ruleIds.add(id);
      for (const snippet of result.snippets) if (snippets.length < MAX_SNIPPETS && !snippets.includes(snippet)) snippets.push(snippet);
    }
  } catch (error) {
    console.error('[Ingest] injection scan unavailable', { reason: error instanceof Error ? error.message : 'unknown' });
    throw new IngestStageError('extract', 'injection_scan_unavailable');
  }
  if (ruleIds.size === 0) return false;

  const ids = [...ruleIds];
  await ctx.writer.setFields(documentId, {
    status: 'quarantined',
    metadata: {
      quarantine: { rule_ids: ids, snippets, quarantined_at: new Date().toISOString() },
      invoice_extraction: { status: 'quarantined' },
    },
  });
  ctx.state.quarantine = { ruleIds: ids, released: false };
  ctx.state.invoice = { extractor: 'sidecar', status: 'quarantined' };
  console.warn('[Ingest] injection scan quarantined an invoice', { ruleIds: ids });
  return true;
}

function promotedColumns(fields: InvoiceFields): Record<string, string | null> {
  const text = (value: string | null | undefined, limit: number): string | null => (value ? value.slice(0, limit) : null);
  return {
    invoice_number: text(fields.invoice_number, ID_LIMIT),
    supplier_name: text(fields.supplier?.name, NAME_LIMIT),
    supplier_tax_id: text(fields.supplier?.tax_id, ID_LIMIT),
    issue_date: fields.issue_date ?? null,
    gross_total: fields.gross_total && AMOUNT.test(fields.gross_total) ? fields.gross_total : null,
    currency: fields.currency ?? null,
  };
}

/** The invoice number and tax ids go in front of every chunk's section_path and into its lexical_text, so an exact identifier is matched in the text. */
function amendChunks(ctx: StageContext, fields: InvoiceFields): void {
  const taxIds = [fields.supplier?.tax_id, fields.buyer?.tax_id].filter((id): id is string => typeof id === 'string' && id !== '');
  const prefix = [
    ...(fields.invoice_number ? [`Invoice ${fields.invoice_number.slice(0, ID_LIMIT)}`] : []),
    ...(taxIds.length > 0 ? [`Tax ID ${taxIds.join(' ')}`] : []),
  ];
  if (prefix.length === 0) return;
  for (const draft of ctx.work.chunks) {
    draft.section_path = [...prefix, ...draft.section_path];
    draft.lexical_text = lexicalText(draft.section_path, draft.content);
  }
}

/**
 * Document-level invoice extraction: the sidecar reads the Markdown, an optional model pass fills what is missing, the extracted text is
 * scanned for injection, and the validated fields are stored as promoted columns plus metadata.invoice. Any failure is recorded as
 * metadata.invoice_extraction and the document goes on as plain text; only an abort, a quarantine and an unloadable scan rule set stop it.
 */
async function run(ctx: StageContext): Promise<void> {
  const document = requireDocument(ctx, 'extract');
  if (ctx.state.quarantine) {
    ctx.state.invoice = { extractor: 'sidecar', status: 'skipped_quarantined' };
    return;
  }
  const markdown = ctx.work.parseText ?? '';
  if (markdown.trim() === '') return recordFailure(ctx, document.id, ['empty_input']);

  const language = detectLanguage(markdown);
  let fields: InvoiceFields;
  try {
    fields = await extractInvoice({
      markdown,
      tables: tablesOf(ctx),
      languageHint: language === 'zh' || language === 'en' || language === 'it' ? language : null,
      signal: ctx.signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return recordFailure(ctx, document.id, [error instanceof InvoiceClientError ? error.code : 'extraction_failed']);
  }
  if (fields.confidence === 0) return recordFailure(ctx, document.id, safeCodes(fields.errors));

  let filled: string[] = [];
  let warning: string | undefined;
  if (ctx.config.invoiceLlmExtract) {
    const result = await fillInvoiceFields(fields, { markdown, signal: ctx.signal });
    fields = result.fields;
    filled = result.filled;
    warning = result.warning;
  }

  if (await quarantineOnMatch(ctx, document.id, fields)) return;

  const columns = promotedColumns(fields);
  try {
    await ctx.writer.setFields(document.id, {
      ...columns,
      ...(columns.issue_date ? { doc_date: columns.issue_date } : {}),
      metadata: {
        invoice: fields,
        invoice_extraction: {
          status: 'ok',
          confidence: fields.confidence,
          errors: safeCodes(fields.errors),
          ...(filled.length > 0 ? { llm_filled: filled } : {}),
          ...(warning ? { warnings: [warning] } : {}),
        },
      },
    });
  } catch (error) {
    if (ctx.signal.aborted || !(error instanceof IngestWriterError)) throw error;
    return recordFailure(ctx, document.id, ['store_failed']);
  }

  ctx.work.templateRow = columns;
  ctx.state.invoice = { extractor: 'sidecar', status: 'ok' };
  amendChunks(ctx, fields);
}

export const invoiceExtractor: DocumentExtractor = { level: 'document', run };
