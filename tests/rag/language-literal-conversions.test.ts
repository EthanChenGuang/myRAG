import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRetrievalFilters } from '@/lib/rag/query/filters';
import { DOC_TYPE_CHOICES, docTypeLabel } from '@/components/ui/doc-type-labels';
import { describeIngestStatus } from '@/components/ui/ingest-status-labels';

const TODAY_ENUM_MESSAGE = "Invalid enum value. Expected 'zh' | 'en' | 'it', received 'xx'";

describe('languages filter (D-06)', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/rag/lang/registry');
    vi.resetModules();
  });

  it('accepts registry codes as before', () => {
    const result = parseRetrievalFilters({ languages: ['zh', 'it'] });
    expect(result).toEqual({ ok: true, filters: { languages: ['zh', 'it'] } });
  });

  it('refuses an unknown code with the same error shape as before', () => {
    const result = parseRetrievalFilters({ languages: ['xx'] });
    expect(result).toEqual({ ok: false, details: [{ path: 'languages.0', message: TODAY_ENUM_MESSAGE }] });
  });

  it('refuses an empty list as before', () => {
    expect(parseRetrievalFilters({ languages: [] })).toEqual({
      ok: false,
      details: [{ path: 'languages', message: 'languages must not be an empty list' }],
    });
  });

  it('takes its accepted codes from the language registry', async () => {
    vi.resetModules();
    vi.doMock('@/lib/rag/lang/registry', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/rag/lang/registry')>()),
      getLanguageRegistry: () => ({ packs: [{ code: 'zh' }, { code: 'en' }] }),
    }));
    const mod = await import('@/lib/rag/query/filters');
    const refused = mod.parseRetrievalFilters({ languages: ['it'] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.details).toEqual([
        { path: 'languages.0', message: "Invalid enum value. Expected 'zh' | 'en', received 'it'" },
      ]);
    }
    expect(mod.parseRetrievalFilters({ languages: ['en'] })).toEqual({ ok: true, filters: { languages: ['en'] } });
  });
});

const DOC_TYPE_EXPECTED: Record<string, Record<string, string>> = {
  en: { general: 'General', invoice_receipt: 'Invoice & receipt', auto: 'Auto-detect' },
  zh: { general: '通用文档', invoice_receipt: '发票与收据', auto: '自动识别' },
  it: { general: 'Generale', invoice_receipt: 'Fattura e ricevuta', auto: 'Rilevamento automatico' },
};

describe('docTypeLabel after the Language type conversion', () => {
  it('returns the same labels for en, zh and it', () => {
    for (const [locale, labels] of Object.entries(DOC_TYPE_EXPECTED)) {
      for (const [id, label] of Object.entries(labels)) {
        expect(docTypeLabel(id as (typeof DOC_TYPE_CHOICES)[number], locale)).toBe(label);
      }
    }
  });

  it('falls back to English for an unknown or prototype-named locale', () => {
    for (const locale of ['xx', 'de', '', 'constructor', '__proto__', 'toString']) {
      expect(docTypeLabel('general', locale)).toBe('General');
      expect(docTypeLabel('auto', locale)).toBe('Auto-detect');
    }
  });
});

const baseState = { stage: null, provisional: false, needsReview: false, reason: null };

describe('describeIngestStatus after the Language type conversion', () => {
  it('returns the same labels and tones for en, zh and it', () => {
    expect(describeIngestStatus({ ...baseState, status: 'ready' }, 'en')).toEqual({ label: 'Ready', tone: 'success' });
    expect(describeIngestStatus({ ...baseState, status: 'ready' }, 'zh')).toEqual({ label: '已就绪', tone: 'success' });
    expect(describeIngestStatus({ ...baseState, status: 'ready' }, 'it')).toEqual({ label: 'Pronto', tone: 'success' });
    expect(describeIngestStatus({ ...baseState, status: 'parsing', provisional: true }, 'it')).toEqual({
      label: 'Ricercabile, ancora in miglioramento',
      tone: 'info',
    });
    expect(describeIngestStatus({ ...baseState, status: 'bogus' }, 'zh')).toEqual({ label: '状态不可用', tone: 'neutral' });
  });

  it('falls back to English for an unknown or prototype-named locale', () => {
    for (const locale of ['xx', 'fr', '', 'constructor', '__proto__']) {
      expect(describeIngestStatus({ ...baseState, status: 'failed' }, locale)).toEqual({ label: 'Failed', tone: 'error' });
    }
  });
});
