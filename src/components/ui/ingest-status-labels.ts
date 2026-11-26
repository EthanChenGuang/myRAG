import type { IngestJobState } from '@/lib/hooks/use-ingest-job-status';
import type { Language } from '@/lib/rag';

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
  | 'pending_review'
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
    pending_review: 'Awaiting approval',
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
    pending_review: '等待批准',
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
    pending_review: 'In attesa di approvazione',
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
  pending_review: 'pending',
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
  if (status === 'pending_review') return { label: labels.pending_review, tone: 'pending' };
  if (state.provisional && TONES[status] === 'pending') return { label: labels.provisional, tone: 'info' };
  return { label: labels[status], tone: TONES[status] };
}

type MessageKey = 'pendingReviewHint' | 'approvalNeedsUnified' | 'languagesNotConfigured' | 'unknownTag';

const MESSAGES: { en: Record<MessageKey, string> } & Partial<Record<IngestStatusLocale, Record<MessageKey, string>>> = {
  en: {
    pendingReviewHint: 'An admin must approve this upload before it can be searched.',
    approvalNeedsUnified: 'Not uploaded. Upload approval is on and needs the unified ingest pipeline, which is off. Ask an admin to turn it on.',
    languagesNotConfigured: 'The supported languages are not chosen, so this is unavailable. Choose them in the Languages panel.',
    unknownTag: 'A chosen tag no longer exists. The tag list was reloaded; choose again.',
  },
  zh: {
    pendingReviewHint: '需由管理员批准后，此上传才能被检索。',
    approvalNeedsUnified: '未上传。上传审批已开启，但它需要统一入库流程，而该流程目前关闭。请联系管理员开启。',
    languagesNotConfigured: '尚未选择支持的语言，因此此功能不可用。请在“语言”面板中选择。',
    unknownTag: '所选标签已不存在。标签列表已重新加载，请重新选择。',
  },
  it: {
    pendingReviewHint: 'Un amministratore deve approvare questo caricamento prima che sia ricercabile.',
    approvalNeedsUnified:
      "Non caricato. L'approvazione dei caricamenti è attiva e richiede la pipeline di ingestione unificata, che è disattivata. Chiedi a un amministratore di attivarla.",
    languagesNotConfigured: 'Le lingue supportate non sono scelte, quindi questa funzione non è disponibile. Sceglile nel pannello Lingue.',
    unknownTag: "Un tag scelto non esiste più. L'elenco è stato ricaricato: scegli di nuovo.",
  },
};

function localeMessages(language: string): Record<MessageKey, string> {
  const own = Object.prototype.hasOwnProperty.call(MESSAGES, language) ? MESSAGES[language as IngestStatusLocale] : undefined;
  return own ?? MESSAGES.en;
}

/** UI-SPEC 6.12.3: the tooltip of a held upload; it names neither an approver nor a reason. */
export function pendingReviewHint(language: string): string {
  return localeMessages(language).pendingReviewHint;
}

const MAPPED_UPLOAD_ERRORS: Record<string, MessageKey> = {
  upload_approval_requires_unified_pipeline: 'approvalNeedsUnified',
  languages_not_configured: 'languagesNotConfigured',
  unknown_scope_value: 'unknownTag',
};

const TIMEOUT_MESSAGE = 'Document processing is taking longer than expected. Please try with a smaller document or try again later.';

/** The sentence a failed knowledge-base upload shows on its row (UI-SPEC 8.2); other errors keep today's text. */
export function uploadErrorMessage(status: number, body: unknown, language: string): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error = typeof record.error === 'string' && record.error.length > 0 ? record.error : null;
  if (error && Object.prototype.hasOwnProperty.call(MAPPED_UPLOAD_ERRORS, error)) {
    return localeMessages(language)[MAPPED_UPLOAD_ERRORS[error] as MessageKey];
  }
  const message = error ?? 'Unknown error occurred';
  if (status === 504 || message.includes('timed out') || message.includes('taking longer')) return TIMEOUT_MESSAGE;
  return message;
}
