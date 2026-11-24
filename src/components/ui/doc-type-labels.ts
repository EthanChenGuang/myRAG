import { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';

/** The six document type identifiers (D-12), aligned with the generated profile schema. */
export const DOC_TYPE_IDS = ProcessingProfileSetSchema.shape.profiles.element.shape.doc_type.options;

export const DOC_TYPE_CHOICES = [...DOC_TYPE_IDS, 'auto'] as const;

export type DocTypeLabelId = (typeof DOC_TYPE_CHOICES)[number];

export type DocTypeLabelLocale = 'zh' | 'en' | 'it';

const LABELS: Record<DocTypeLabelLocale, Record<DocTypeLabelId, string>> = {
  en: {
    general: 'General',
    financial_report: 'Financial report',
    contract_legal: 'Contract & legal',
    invoice_receipt: 'Invoice & receipt',
    product_technical: 'Product & technical',
    scanned_image: 'Scanned image',
    auto: 'Auto-detect',
  },
  zh: {
    general: '通用文档',
    financial_report: '财务报告',
    contract_legal: '合同与法律',
    invoice_receipt: '发票与收据',
    product_technical: '产品与技术',
    scanned_image: '扫描图像',
    auto: '自动识别',
  },
  it: {
    general: 'Generale',
    financial_report: 'Report finanziario',
    contract_legal: 'Contratto e legale',
    invoice_receipt: 'Fattura e ricevuta',
    product_technical: 'Prodotto e tecnico',
    scanned_image: 'Immagine scansionata',
    auto: 'Rilevamento automatico',
  },
};

function normalizeLocale(language: string): DocTypeLabelLocale {
  if (language === 'zh' || language === 'it') return language;
  return 'en';
}

/** Localized label for a document type or auto-detect; unknown UI languages fall back to en. */
export function docTypeLabel(id: DocTypeLabelId, language: string): string {
  const locale = normalizeLocale(language);
  return LABELS[locale][id] ?? LABELS.en[id];
}