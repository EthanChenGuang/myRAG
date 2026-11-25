import { describe, expect, it } from 'vitest';
import { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';
import { DOC_TYPE_CHOICES, DOC_TYPE_IDS, docTypeLabel } from '@/components/ui/doc-type-labels';
import {
  buildChatUploadFormData,
  buildDocTypePickerOptions,
  ingestPollDelayMs,
  pollIngestUntilTerminal,
  type DocTypePickerValue,
} from '@/components/ui/doc-type-picker';

const CONTRACT_TYPES = ProcessingProfileSetSchema.shape.profiles.element.shape.doc_type.options;

describe('DOC_TYPE_IDS', () => {
  it('matches the six identifiers from the generated contract', () => {
    expect([...DOC_TYPE_IDS].sort()).toEqual([...CONTRACT_TYPES].sort());
  });
});

describe('docTypeLabel', () => {
  it('returns non-empty distinct labels for invoice_receipt in zh, en and it', () => {
    const zh = docTypeLabel('invoice_receipt', 'zh');
    const en = docTypeLabel('invoice_receipt', 'en');
    const it = docTypeLabel('invoice_receipt', 'it');
    expect(zh.length).toBeGreaterThan(0);
    expect(en.length).toBeGreaterThan(0);
    expect(it.length).toBeGreaterThan(0);
    expect(new Set([zh, en, it]).size).toBe(3);
  });

  it('falls back to en for an unknown UI language', () => {
    expect(docTypeLabel('general', 'xx')).toBe(docTypeLabel('general', 'en'));
    expect(docTypeLabel('auto', 'pt')).toBe(docTypeLabel('auto', 'en'));
  });
});

describe('buildDocTypePickerOptions', () => {
  it('lists the six types plus auto with the default pre-selected', () => {
    const options = buildDocTypePickerOptions('en', 'invoice_receipt');
    expect(options.map((o) => o.value)).toEqual([...DOC_TYPE_CHOICES]);
    const selected = options.filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.value).toBe('invoice_receipt');
    expect(options.find((o) => o.value === 'auto')?.label).toContain('Auto');
  });

  it('invokes onChange semantics through option values', () => {
    const chosen: DocTypePickerValue[] = [];
    const options = buildDocTypePickerOptions('zh', 'auto');
    for (const option of options) {
      chosen.push(option.value);
    }
    expect(chosen).toEqual([...DOC_TYPE_CHOICES]);
  });
});

describe('buildChatUploadFormData', () => {
  const file = new File(['body'], 'sample.pdf', { type: 'application/pdf' });

  it('omits doc_type when the picker is disabled (legacy)', () => {
    const form = buildChatUploadFormData({ file, pickerEnabled: false, docType: 'invoice_receipt' });
    expect(form.has('doc_type')).toBe(false);
    expect(form.get('file')).toBeTruthy();
  });

  it('appends doc_type when the picker is enabled (unified)', () => {
    const form = buildChatUploadFormData({
      file,
      organizationId: 'org-1',
      pickerEnabled: true,
      docType: 'contract_legal',
    });
    expect(form.get('doc_type')).toBe('contract_legal');
    expect(form.get('organization_id')).toBe('org-1');
  });
});

describe('pollIngestUntilTerminal', () => {
  it('backs off from 1s doubling to 8s and stops at terminal status', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await pollIngestUntilTerminal('doc-1', {
      fetchStatus: async () => {
        calls += 1;
        return { status: calls < 3 ? 'processing' : 'ready' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
      startedAt: 0,
    });
    expect(result.status).toBe('ready');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('exposes the poll delay schedule for status polling', () => {
    expect(ingestPollDelayMs(0)).toBe(1000);
    expect(ingestPollDelayMs(1)).toBe(2000);
    expect(ingestPollDelayMs(3)).toBe(8000);
    expect(ingestPollDelayMs(10)).toBe(8000);
  });
});