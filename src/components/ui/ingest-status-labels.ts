import type { IngestJobState } from '@/lib/hooks/use-ingest-job-status';
import type { Language } from '@/lib/rag/lang/registry';

export type IngestStatusTone = 'pending' | 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface IngestStatusDescription {
  label: string;
  tone: IngestStatusTone;
}

export type IngestStatusLocale = Language;

type LabelKey =
  | 'queued'
  | 'preflight'
  | 'parsing'
  | 'checking'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed'
  | 'needs_review'
  | 'quarantined'
  | 'skipped_duplicate'
  | 'not_found'
  | 'unavailable'
  | 'provisional';

const LABELS: { en: Record<LabelKey, string> } & Partial<Record<IngestStatusLocale, Record<LabelKey, string>>> = {
  en: {
    queued: 'Queued',
    preflight: 'Preparing…',
    parsing: 'Parsing…',
    checking: 'Checking…',
    chunking: 'Splitting…',
    embedding: 'Indexing…',
    ready: 'Ready',
    failed: 'Failed',
    needs_review: 'Needs review',
    quarantined: 'Quarantined',
    skipped_duplicate: 'Already uploaded',
    not_found: 'Not found',
    unavailable: 'Status unavailable',
    provisional: 'Searchable, still improving',
  },
  zh: {
    queued: '排队中',
    preflight: '准备中',
    parsing: '解析中',
    checking: '检查中',
    chunking: '分块中',
    embedding: '索引中',
    ready: '已就绪',
    failed: '失败',
    needs_review: '需要审核',
    quarantined: '已隔离',
    skipped_duplicate: '已上传过',
    not_found: '未找到',
    unavailable: '状态不可用',
    provisional: '可搜索，仍在优化',
  },
  it: {
    queued: 'In coda',
    preflight: 'Preparazione…',
    parsing: 'Analisi…',
    checking: 'Controllo…',
    chunking: 'Suddivisione…',
    embedding: 'Indicizzazione…',
    ready: 'Pronto',
    failed: 'Non riuscito',
    needs_review: 'Da rivedere',
    quarantined: 'In quarantena',
    skipped_duplicate: 'Già caricato',
    not_found: 'Non trovato',
    unavailable: 'Stato non disponibile',
    provisional: 'Ricercabile, ancora in miglioramento',
  },
};

const TONES: Record<Exclude<LabelKey, 'provisional'>, IngestStatusTone> = {
  queued: 'pending',
  preflight: 'pending',
  parsing: 'pending',
  checking: 'pending',
  chunking: 'pending',
  embedding: 'pending',
  ready: 'success',
  failed: 'error',
  needs_review: 'warning',
  quarantined: 'error',
  skipped_duplicate: 'neutral',
  not_found: 'neutral',
  unavailable: 'neutral',
};

function localeLabels(language: string): Record<LabelKey, string> {
  const own = Object.prototype.hasOwnProperty.call(LABELS, language) ? LABELS[language as IngestStatusLocale] : undefined;
  return own ?? LABELS.en;
}

function isLabelKey(status: string): status is Exclude<LabelKey, 'provisional'> {
  return Object.prototype.hasOwnProperty.call(TONES, status);
}

/** Localized label and tone for a job state; unknown UI languages fall back to en. A running job with a published provisional version reads "searchable, still improving". */
export function describeIngestStatus(state: IngestJobState, language: string): IngestStatusDescription {
  const labels = localeLabels(language);
  const status = state.status;
  if (!isLabelKey(status)) return { label: labels.unavailable, tone: 'neutral' };
  if (state.provisional && TONES[status] === 'pending') return { label: labels.provisional, tone: 'info' };
  return { label: labels[status], tone: TONES[status] };
}
