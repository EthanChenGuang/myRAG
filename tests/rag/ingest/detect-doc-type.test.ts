import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DocTypeDetectionSchema } from '@/lib/rag-eval/contracts.generated';
import { env } from '@/lib/env';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { loadIngestConfig, resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { DOC_TYPE_CONFIDENCE_FLOOR, detectDocType } from '@/lib/rag/ingest/profiles/detect-doc-type';
import { DOC_TYPE_LLM_MODEL_ID, setLlmDetectForTests, type LlmDetectCall } from '@/lib/rag/ingest/profiles/llm-detect';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { refineDocTypeAfterParse, resolveDocType, type RefineContext, type ResolveDocTypeInput } from '@/lib/rag/ingest/profiles/resolve-doc-type';
import { emptyIngestState, type DocTypeOrigin } from '@/lib/rag/ingest/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import recorded from '../../fixtures/ingest/llm-detect-recorded.json';

const scope = mintScope('single', null, null);

const INVOICE_TEXT = [
  'Fattura n. FT-2025/0042',
  'Cedente: Example Supplies S.r.l.   Partita IVA IT99999999990',
  'Descrizione        Quantita   Importo',
  'Servizio mensile   1          100,00',
  'Totale documento   122,00',
].join('\n');

const CONTRACT_ZH = ['合同', '', '第一条 合同标的', '甲方向乙方提供服务。', '', '第二条 付款方式', '乙方按月付款。', '', '第三条 期限', '本合同自签署之日起生效。'].join('\n');

const TABLE = ['| Item | 2025 | 2024 |', '| --- | --- | --- |', '| Cash | 120 | 100 |', '| Debt | 80 | 90 |', '| Equity | 40 | 10 |'].join('\n');

describe('detectDocType rules (D-16)', () => {
  test('the confidence floor is 0.6', () => {
    expect(DOC_TYPE_CONFIDENCE_FLOOR).toBe(0.6);
  });

  test('an invoice filename plus Partita IVA and an invoice number is an invoice with the matches as signals', () => {
    const result = detectDocType({ filename: 'fattura_2025_0042.pdf', mimeType: 'application/pdf', text: INVOICE_TEXT });
    expect(result.doc_type).toBe('invoice_receipt');
    expect(result.method).toBe('rules');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.signals).toEqual(expect.arrayContaining(['filename:keyword:fattura', 'text:keyword:partita iva', 'text:invoice_number', 'text:vat_id']));
  });

  test('the filename alone can reach the floor for a clear name', () => {
    const result = detectDocType({ filename: 'fattura_2025_0042.pdf', mimeType: 'application/pdf' });
    expect(result).toMatchObject({ doc_type: 'invoice_receipt', method: 'rules' });
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('a Chinese contract with clause headings is a contract', () => {
    const result = detectDocType({ filename: '合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: CONTRACT_ZH });
    expect(result.doc_type).toBe('contract_legal');
    expect(result.signals).toEqual(expect.arrayContaining(['filename:keyword:合同', 'text:clause_headings']));
  });

  test('an English or Italian contract is recognised from its title and numbered articles', () => {
    const en = detectDocType({ filename: 'scan.docx', text: 'SERVICE AGREEMENT\n\nArticle 1 Scope\nThe supplier delivers.\n\nArticle 2 Payment\nThe client pays.\n' });
    expect(en.doc_type).toBe('contract_legal');
    const it = detectDocType({ filename: 'doc.docx', text: 'Contratto di fornitura\n\nArticolo 1 Oggetto\nIl fornitore consegna.\n\nArticolo 2 Pagamento\nIl cliente paga.\n' });
    expect(it.doc_type).toBe('contract_legal');
  });

  test.each([
    ['资产负债表', '资产负债表\n\n单位：元\n' + TABLE],
    ['bilancio', 'Bilancio al 31 dicembre\n\n' + TABLE],
    ['balance sheet', 'Consolidated Balance Sheet\n\n' + TABLE],
  ])('%s with a table is a financial report', (_label, text) => {
    const result = detectDocType({ filename: 'report.pdf', mimeType: 'application/pdf', text });
    expect(result.doc_type).toBe('financial_report');
    expect(result.signals).toContain('text:table_rows');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('a PDF whose pages mostly lack a text layer is a scanned document, and one with text is not', () => {
    const scanned = detectDocType({ filename: 'scan_0007.pdf', mimeType: 'application/pdf', textLayerPageShare: 0.1 });
    expect(scanned).toMatchObject({ doc_type: 'scanned_image', method: 'rules' });
    expect(scanned.signals).toContain('probe:text_layer_share:0.1');
    const digital = detectDocType({ filename: 'scan_0007.pdf', mimeType: 'application/pdf', textLayerPageShare: 0.95 });
    expect(digital.doc_type).toBe('general');
  });

  test('an image file is a scanned document by its extension or type', () => {
    expect(detectDocType({ filename: 'photo.JPG', mimeType: 'image/jpeg' }).doc_type).toBe('scanned_image');
    expect(detectDocType({ filename: 'upload', mimeType: 'image/png' }).doc_type).toBe('scanned_image');
  });

  test('a manual title is a product or technical document', () => {
    const result = detectDocType({ filename: 'guide.pdf', text: 'User Manual\n\nSpecifications\nVoltage 12 V\n\nInstallation\nMount the unit.' });
    expect(result.doc_type).toBe('product_technical');
  });

  test('plain prose is general with a confidence below the floor', () => {
    const result = detectDocType({ filename: 'notes.txt', mimeType: 'text/plain', text: 'We met on Tuesday and talked about the weather, the garden and the plans for the summer holidays.' });
    expect(result.doc_type).toBe('general');
    expect(result.confidence).toBeLessThan(0.6);
  });

  test('one passing mention of a keyword in the body stays below the floor and gives general', () => {
    const filler = 'The team reviewed the schedule and the open questions for the coming weeks. '.repeat(80);
    const result = detectDocType({ filename: 'minutes.txt', text: `${filler}\nThe agreement was discussed briefly.` });
    expect(result.doc_type).toBe('general');
    expect(result.confidence).toBeLessThan(0.6);
  });

  test('the result is deterministic and always valid against the generated DocTypeDetection schema', () => {
    const inputs = [
      { filename: 'fattura_2025_0042.pdf', text: INVOICE_TEXT },
      { filename: 'x.txt', text: '' },
      { filename: '', text: null },
      { filename: 'scan.pdf', textLayerPageShare: Number.NaN },
      { filename: 'scan.pdf', textLayerPageShare: 7 },
    ];
    for (const input of inputs) {
      const first = detectDocType(input);
      expect(detectDocType(input)).toEqual(first);
      expect(DocTypeDetectionSchema.safeParse(first).success).toBe(true);
    }
  });

  test('signals are fixed codes and never carry document text', () => {
    const secret = 'heliotrope marmalade quasar';
    const result = detectDocType({ filename: 'fattura.pdf', text: `Fattura n. FT-77/9\nPartita IVA IT99999999990\n${secret}` });
    for (const signal of result.signals) {
      expect(signal).toMatch(/^[a-z_]+:[^\n]{1,40}$/u);
      expect(signal).not.toContain(secret);
      expect(signal).not.toContain('FT-77');
      expect(signal).not.toContain('99999999990');
    }
  });

  test('hostile long text is bounded and does not stall detection', () => {
    const hostile = `Invoice ${'9'.repeat(200000)} ${'- '.repeat(100000)}`;
    const started = Date.now();
    detectDocType({ filename: 'x.pdf', text: hostile });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

function makeRefineContext(origin: DocTypeOrigin, docType: Parameters<typeof getProcessingProfile>[0] = 'general', envValues: Record<string, string> = {}): RefineContext {
  return {
    identity: {
      tenantKey: 's:default',
      filename: 'scan_0001.pdf',
      fileSha256: 'x',
      docType,
      docTypeOrigin: origin,
      profile: getProcessingProfile(docType),
      bytes: null,
    },
    state: emptyIngestState(),
    config: loadIngestConfig(envValues),
    signal: new AbortController().signal,
    warnings: [],
    input: { filename: 'scan_0001.pdf', mimeType: 'application/pdf' },
  };
}

describe('detection in two steps (F-10)', () => {
  test('a filename with no signal is provisional general, and the parsed text refines it once', async () => {
    const pre = detectDocType({ filename: 'scan_0001.pdf', mimeType: 'application/pdf' });
    expect(pre.doc_type).toBe('general');

    const ctx = makeRefineContext('auto');
    const outcome = await refineDocTypeAfterParse(ctx, { text: INVOICE_TEXT });
    expect(outcome).toMatchObject({ changed: true, docType: 'invoice_receipt', parserOptionsDiffer: true });
    expect(outcome.profile.doc_type).toBe('invoice_receipt');
    expect(ctx.identity?.docType).toBe('invoice_receipt');
    expect(ctx.identity?.profile.doc_type).toBe('invoice_receipt');
    expect(ctx.state.docTypeDetection).toMatchObject({ refined: 'invoice_receipt', reparsed: false });
    expect(ctx.state.docTypeDetection?.detection?.method).toBe('rules');
  });

  test('the type changes at most once', async () => {
    const ctx = makeRefineContext('auto');
    await refineDocTypeAfterParse(ctx, { text: INVOICE_TEXT });
    const second = await refineDocTypeAfterParse(ctx, { text: CONTRACT_ZH });
    expect(second).toMatchObject({ changed: false, docType: 'invoice_receipt', parserOptionsDiffer: false });
    expect(ctx.identity?.docType).toBe('invoice_receipt');
  });

  test('a refinement that keeps the parser options does not ask for a re-parse', async () => {
    const ctx = makeRefineContext('auto');
    const outcome = await refineDocTypeAfterParse(ctx, { text: 'User Manual\n\nSpecifications\nVoltage 12 V\n\nInstallation\nMount the unit.' });
    expect(outcome).toMatchObject({ changed: true, docType: 'product_technical', parserOptionsDiffer: false });
  });

  test('once a re-parse has happened a further difference never asks for another', async () => {
    const ctx = makeRefineContext('auto');
    ctx.state.docTypeDetection = { signals: [], refined: null, reparsed: true };
    const outcome = await refineDocTypeAfterParse(ctx, { text: INVOICE_TEXT });
    expect(outcome).toMatchObject({ changed: true, parserOptionsDiffer: false });
  });

  test('parsed text with no signal keeps the provisional type and still counts as the one refinement', async () => {
    const ctx = makeRefineContext('auto', 'scanned_image');
    const outcome = await refineDocTypeAfterParse(ctx, { text: 'We met on Tuesday and talked about the weather and the garden.' });
    expect(outcome).toMatchObject({ changed: false, docType: 'scanned_image' });
    expect(ctx.state.docTypeDetection?.refined).toBe('scanned_image');
  });

  test.each<DocTypeOrigin>(['picked', 'source_default', 'tenant_default', 'fallback'])('a type with origin %s is never refined', async (origin) => {
    const ctx = makeRefineContext(origin);
    const outcome = await refineDocTypeAfterParse(ctx, { text: INVOICE_TEXT });
    expect(outcome).toMatchObject({ changed: false, docType: 'general', parserOptionsDiffer: false });
    expect(ctx.identity?.docType).toBe('general');
    expect(ctx.state.docTypeDetection).toBeNull();
  });

  test('the text-layer share found by the parser can make a general document a scan', async () => {
    const ctx = makeRefineContext('auto');
    const outcome = await refineDocTypeAfterParse(ctx, { text: '', textLayerPageShare: 0.05 });
    expect(outcome).toMatchObject({ changed: true, docType: 'scanned_image', parserOptionsDiffer: true });
  });
});

describe('optional LLM classifier (D-16)', () => {
  const WEAK: ResolveDocTypeInput = {
    picked: 'auto',
    source: 'config_upload',
    filename: 'document.txt',
    mimeType: 'text/plain',
    text: 'Seller and buyer are listed above the table of items. Totals follow below. Payment within thirty days.',
  };
  const deps = (envValues: Record<string, string>) => ({
    db: () => null as RpcClient | null,
    config: loadIngestConfig(envValues),
    signal: new AbortController().signal,
  });
  const serving = (response: unknown) => {
    const call = vi.fn<LlmDetectCall>(async () => response);
    setLlmDetectForTests(call);
    return call;
  };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setLlmDetectForTests(null);
    resetIngestConfigForTests();
    vi.restoreAllMocks();
  });

  test('with the switch off the classifier is never called', async () => {
    const call = serving(recorded.responses.invoice);
    const resolved = await resolveDocType(scope, WEAK, deps({ RAG_DOC_TYPE_LLM_DETECT: 'false' }));
    expect(call).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ docType: 'general', origin: 'auto' });
    const unset = await resolveDocType(scope, WEAK, deps({}));
    expect(call).not.toHaveBeenCalled();
    expect(unset.docType).toBe('general');
  });

  test('with the switch on and a weak rules result the recorded response is validated and used', async () => {
    const call = serving(recorded.responses.invoice);
    const resolved = await resolveDocType(scope, WEAK, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({ docType: 'invoice_receipt', origin: 'auto' });
    expect(resolved.detection).toMatchObject({ doc_type: 'invoice_receipt', method: 'llm', confidence: 0.86 });
    expect(DocTypeDetectionSchema.safeParse(resolved.detection).success).toBe(true);
  });

  test('a strong rules result is final and the classifier is not asked', async () => {
    const call = serving(recorded.responses.contract_unsure);
    const resolved = await resolveDocType(scope, { ...WEAK, filename: 'fattura_2025_0042.pdf' }, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(call).not.toHaveBeenCalled();
    expect(resolved.detection?.method).toBe('rules');
  });

  test('without text there is nothing to classify and the classifier is not called', async () => {
    const call = serving(recorded.responses.invoice);
    const resolved = await resolveDocType(scope, { ...WEAK, text: null }, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(call).not.toHaveBeenCalled();
    expect(resolved.docType).toBe('general');
  });

  test.each([
    ['an unknown type', recorded.responses.unknown_type],
    ['a confidence out of range', recorded.responses.out_of_range_confidence],
    ['an extra field', recorded.responses.extra_field],
    ['a string', 'invoice_receipt'],
    ['nothing', null],
  ])('%s falls back to the rules result with llm_detect_invalid', async (_label, response) => {
    serving(response);
    const resolved = await resolveDocType(scope, WEAK, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(resolved).toMatchObject({ docType: 'general', origin: 'auto' });
    expect(resolved.detection?.method).toBe('rules');
    expect(resolved.warnings).toContain('llm_detect_invalid');
  });

  test('a failing call falls back to the rules result with llm_detect_failed and logs no text', async () => {
    const warn = vi.mocked(console.warn);
    setLlmDetectForTests(async () => {
      throw new Error(`upstream said: ${WEAK.text}`);
    });
    const resolved = await resolveDocType(scope, WEAK, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(resolved).toMatchObject({ docType: 'general', origin: 'auto' });
    expect(resolved.warnings).toContain('llm_detect_failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Seller and buyer');
  });

  test('an answer below the floor does not set a type', async () => {
    serving(recorded.responses.contract_unsure);
    const resolved = await resolveDocType(scope, WEAK, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(resolved.docType).toBe('general');
    expect(resolved.detection?.method).toBe('llm');
    expect(resolved.detection?.doc_type).toBe('general');
  });

  test('the signals of the answer are cut to short codes', async () => {
    serving(recorded.responses.noisy_signals);
    const resolved = await resolveDocType(scope, WEAK, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(resolved.docType).toBe('financial_report');
    const signals = resolved.detection?.signals ?? [];
    expect(signals.length).toBeLessThanOrEqual(6);
    for (const signal of signals) {
      expect(signal.startsWith('llm:')).toBe(true);
      expect(signal.length).toBeLessThanOrEqual(52);
    }
  });

  test('the text sent to the classifier is bounded', async () => {
    const call = serving(recorded.responses.invoice);
    await resolveDocType(scope, { ...WEAK, text: 'lorem '.repeat(100000) }, deps({ RAG_DOC_TYPE_LLM_DETECT: 'true' }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0].text.length).toBeLessThanOrEqual(8000);
  });

  test('refinement can use the classifier too', async () => {
    serving(recorded.responses.invoice);
    const ctx = makeRefineContext('auto', 'general', { RAG_DOC_TYPE_LLM_DETECT: 'true' });
    const outcome = await refineDocTypeAfterParse(ctx, { text: WEAK.text ?? '' });
    expect(outcome).toMatchObject({ changed: true, docType: 'invoice_receipt' });
    expect(ctx.state.docTypeDetection?.detection?.method).toBe('llm');
  });

  test('the model id is one of the default OpenRouter models', () => {
    const models: unknown = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS || '[]');
    expect(Array.isArray(models)).toBe(true);
    const ids = (models as Array<{ id?: unknown }>).map((model) => model.id);
    expect(ids).toContain(DOC_TYPE_LLM_MODEL_ID);
  });
});
