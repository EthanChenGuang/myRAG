import type { DocTypeDetection } from '@/lib/rag-eval/contracts.generated';
import type { DocType } from './load';

export const DOC_TYPE_CONFIDENCE_FLOOR = 0.6;

export interface DetectDocTypeInput {
  filename: string;
  mimeType?: string | null;
  /** Parsed text, or the text of a text upload. Only the first characters are read. */
  text?: string | null;
  /** Share of pages that have a text layer, 0 to 1, when a probe or the parser knows it. */
  textLayerPageShare?: number | null;
}

type ScoredType = Exclude<DocType, 'general' | 'scanned_image'>;

interface KeywordSet {
  /** Defining words: a filename hit, or a hit in the opening of the text, is strong evidence. */
  strong: readonly string[];
  /** Words that only support a type. */
  weak: readonly string[];
}

// Synthetic keyword sets in zh, en and it. Matching runs on NFKC lower-case text.
const KEYWORDS: Record<ScoredType, KeywordSet> = {
  invoice_receipt: {
    strong: ['invoice', 'proforma', 'credit note', 'receipt', 'fattura', 'ricevuta', 'scontrino', 'nota di credito', '发票', '收据', '收银小票'],
    weak: ['partita iva', 'p.iva', 'vat number', 'vat id', 'total due', 'amount due', 'bill to', 'imponibile', 'totale documento', '税号', '纳税人识别号', '价税合计', '开票日期'],
  },
  contract_legal: {
    strong: ['contract', 'agreement', 'non-disclosure', 'terms and conditions', 'contratto', 'accordo', 'condizioni generali', '合同', '协议', '合约', '保密协议'],
    weak: ['whereas', 'hereinafter', 'governing law', 'liability', 'termination', 'parties', 'le parti', 'clausola', 'foro competente', '甲方', '乙方', '违约责任', '争议解决'],
  },
  financial_report: {
    strong: [
      'balance sheet',
      'income statement',
      'cash flow statement',
      'financial statements',
      'profit and loss',
      'bilancio',
      'conto economico',
      'stato patrimoniale',
      'rendiconto finanziario',
      '资产负债表',
      '利润表',
      '现金流量表',
      '财务报表',
    ],
    weak: ['total assets', 'total liabilities', 'net income', 'revenue', 'ebitda', 'equity', 'attivo', 'passivo', 'ricavi', 'utile', '总资产', '总负债', '净利润', '营业收入'],
  },
  product_technical: {
    strong: [
      'user manual',
      'datasheet',
      'data sheet',
      'installation guide',
      'technical specification',
      'product specification',
      'scheda tecnica',
      "manuale d'uso",
      'manuale utente',
      'manuale di installazione',
      '用户手册',
      '产品说明书',
      '使用说明',
      '技术规格',
    ],
    weak: ['specifications', 'troubleshooting', 'warranty', 'installation', 'firmware', 'voltage', 'dimensions', 'caratteristiche tecniche', 'istruzioni', '规格', '故障排除', '安装', '保修'],
  },
};

const TYPE_ORDER: readonly DocType[] = ['invoice_receipt', 'contract_legal', 'financial_report', 'product_technical', 'scanned_image'];

const TEXT_WINDOW = 20000;
const HEAD_WINDOW = 3000;

const WEIGHT = {
  filenameKeyword: 0.6,
  headKeyword: 0.45,
  extraHeadKeyword: 0.15,
  bodyKeyword: 0.1,
  pattern: 0.3,
  clauseHeadings: 0.4,
  tableRows: 0.2,
  imageFile: 0.7,
  noTextLayer: 0.85,
  littleTextLayer: 0.6,
} as const;

const MAX_EXTRA_HEAD_KEYWORDS = 2;
const MAX_BODY_KEYWORDS = 3;
const NO_TEXT_LAYER_SHARE = 0.2;
const LITTLE_TEXT_LAYER_SHARE = 0.4;

const CJK = /[⺀-鿿豈-﫿]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Matcher {
  keyword: string;
  test(haystack: string): boolean;
}

const matcherCache = new Map<string, Matcher>();

function matcherFor(keyword: string): Matcher {
  const cached = matcherCache.get(keyword);
  if (cached) return cached;
  const matcher: Matcher = CJK.test(keyword)
    ? { keyword, test: (haystack) => haystack.includes(keyword) }
    : (() => {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, 'u');
        return { keyword, test: (haystack: string) => pattern.test(haystack) };
      })();
  matcherCache.set(keyword, matcher);
  return matcher;
}

const normalise = (value: string): string => value.normalize('NFKC').toLowerCase();

const INVOICE_NUMBER = /(?:invoice|fattura|ricevuta|receipt|发票)[ \t]*(?:n(?:o|um(?:ber|ero)?)?\.?|n°|nr\.?|#|号码?)?[ \t]*[:：]?[ \t]*(?=[a-z0-9/_-]*\d)[a-z0-9][a-z0-9/_-]{2,}/u;
const VAT_ID = /(?:partita[ \t]*iva|p\.?[ \t]*iva|vat(?:[ \t]*(?:id|no|number|reg(?:istration)?))?|tax[ \t]*id|纳税人识别号|统一社会信用代码|税号)[ \t]*[:：]?[ \t]*(?:[a-z]{2})?\d[0-9a-z]{7,17}|(?<![a-z0-9])it\d{11}(?![a-z0-9])/u;
const CLAUSES_ZH = /第[一二三四五六七八九十百零〇两\d]+条/gu;
const CLAUSES_LATIN = /(?:^|\n)[ \t]*(?:article|clause|articolo|clausola|art\.)[ \t]*\d+/gu;
const TABLE_ROW = /^[ \t]*\|.+\|[ \t]*$/gmu;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|tiff?|bmp|webp|heic|gif)$/u;

function countAtLeast(pattern: RegExp, haystack: string, wanted: number): boolean {
  let count = 0;
  for (const _match of haystack.matchAll(pattern)) {
    count += 1;
    if (count >= wanted) return true;
  }
  return false;
}

interface Candidate {
  type: DocType;
  score: number;
  signals: string[];
}

function scoreKeywordType(type: ScoredType, filename: string, window: string, head: string): Candidate {
  const { strong, weak } = KEYWORDS[type];
  const signals: string[] = [];
  let score = 0;
  let anyKeyword = false;

  const named = strong.find((keyword) => matcherFor(keyword).test(filename));
  if (named !== undefined) {
    score += WEIGHT.filenameKeyword;
    signals.push(`filename:keyword:${named}`);
    anyKeyword = true;
  }

  const inHead = strong.filter((keyword) => matcherFor(keyword).test(head));
  inHead.forEach((keyword, index) => {
    if (index === 0) score += WEIGHT.headKeyword;
    else if (index <= MAX_EXTRA_HEAD_KEYWORDS) score += WEIGHT.extraHeadKeyword;
    else return;
    signals.push(`text:keyword:${keyword}`);
    anyKeyword = true;
  });

  const body = [...strong.filter((keyword) => !inHead.includes(keyword)), ...weak].filter((keyword) => matcherFor(keyword).test(window));
  for (const keyword of body.slice(0, MAX_BODY_KEYWORDS)) {
    score += WEIGHT.bodyKeyword;
    signals.push(`text:keyword:${keyword}`);
    anyKeyword = true;
  }

  if (type === 'invoice_receipt') {
    if (INVOICE_NUMBER.test(window)) {
      score += WEIGHT.pattern;
      signals.push('text:invoice_number');
    }
    if (VAT_ID.test(window)) {
      score += WEIGHT.pattern;
      signals.push('text:vat_id');
    }
  } else if (type === 'contract_legal') {
    if (countAtLeast(CLAUSES_ZH, window, 2) || countAtLeast(CLAUSES_LATIN, window, 2)) {
      score += WEIGHT.clauseHeadings;
      signals.push('text:clause_headings');
    }
  } else if (type === 'financial_report') {
    if (anyKeyword && countAtLeast(TABLE_ROW, window, 3)) {
      score += WEIGHT.tableRows;
      signals.push('text:table_rows');
    }
  }
  return { type, score, signals };
}

function scoreScanned(filename: string, mimeType: string, share: number | null): Candidate {
  const signals: string[] = [];
  let score = 0;
  if (IMAGE_EXTENSION.test(filename) || mimeType.startsWith('image/')) {
    score += WEIGHT.imageFile;
    signals.push('ext:image');
  }
  if (share !== null && share <= LITTLE_TEXT_LAYER_SHARE) {
    score += share <= NO_TEXT_LAYER_SHARE ? WEIGHT.noTextLayer : WEIGHT.littleTextLayer;
    signals.push(`probe:text_layer_share:${Number(share.toFixed(2))}`);
  }
  return { type: 'scanned_image', score, signals };
}

function validShare(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Rules-first document type detection (D-16): deterministic, no network. Weighted signals from the filename, the opening of the text,
 * a few shapes (invoice number, VAT id, clause headings, table rows) and the text-layer share add up to a confidence in [0, 1]. Below
 * DOC_TYPE_CONFIDENCE_FLOOR the answer is general, and the confidence and signals are those of the best candidate. Signals are fixed
 * codes and never contain document text.
 */
export function detectDocType(input: DetectDocTypeInput): DocTypeDetection {
  const filename = normalise(typeof input.filename === 'string' ? input.filename : '')
    .split(/[\\/]/u)
    .pop()
    ?.replace(/[_\-]+/gu, ' ')
    ?? '';
  const mimeType = normalise(input.mimeType ?? '');
  const window = normalise((input.text ?? '').slice(0, TEXT_WINDOW));
  const head = window.slice(0, HEAD_WINDOW);

  const candidates: Candidate[] = [
    scoreKeywordType('invoice_receipt', filename, window, head),
    scoreKeywordType('contract_legal', filename, window, head),
    scoreKeywordType('financial_report', filename, window, head),
    scoreKeywordType('product_technical', filename, window, head),
    scoreScanned(filename, mimeType, validShare(input.textLayerPageShare)),
  ];

  let best = candidates[0] as Candidate;
  for (const candidate of candidates) {
    if (candidate.score > best.score || (candidate.score === best.score && TYPE_ORDER.indexOf(candidate.type) < TYPE_ORDER.indexOf(best.type))) {
      best = candidate;
    }
  }
  const confidence = Math.min(1, Math.round(best.score * 100) / 100);
  return {
    doc_type: confidence >= DOC_TYPE_CONFIDENCE_FLOOR ? best.type : 'general',
    confidence,
    signals: best.signals,
    method: 'rules',
  };
}
