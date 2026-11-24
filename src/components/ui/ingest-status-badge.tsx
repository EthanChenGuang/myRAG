import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Clock, CopyCheck, HelpCircle, Loader2, ShieldAlert, Sparkles, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  isTerminalIngestStatus,
  useIngestJobStatus,
  type IngestJobState,
} from '@/lib/hooks/use-ingest-job-status';
import { describeIngestStatus, type IngestStatusTone } from '@/components/ui/ingest-status-labels';

export interface IngestStatusBadgeProps {
  state: IngestJobState;
  language: string;
  className?: string;
}

const TONE_CLASSES: Record<IngestStatusTone, string> = {
  pending: 'text-sky-700 dark:text-sky-300',
  info: 'text-sky-700 dark:text-sky-300',
  success: 'text-green-700 dark:text-green-400',
  warning: 'text-amber-700 dark:text-amber-300',
  error: 'text-red-600 dark:text-red-400',
  neutral: 'text-gray-600 dark:text-gray-400',
};

function StatusIcon({ state, tone }: { state: IngestJobState; tone: IngestStatusTone }) {
  const className = 'h-3.5 w-3.5 flex-shrink-0';
  if (tone === 'info') return <Sparkles aria-hidden="true" className={className} />;
  if (tone === 'pending') {
    return state.status === 'queued' ? (
      <Clock aria-hidden="true" className={className} />
    ) : (
      <Loader2 aria-hidden="true" className={cn(className, 'animate-spin motion-reduce:animate-none')} />
    );
  }
  switch (state.status) {
    case 'ready':
      return <CheckCircle2 aria-hidden="true" className={className} />;
    case 'needs_review':
      return <AlertTriangle aria-hidden="true" className={className} />;
    case 'failed':
      return <XCircle aria-hidden="true" className={className} />;
    case 'quarantined':
      return <ShieldAlert aria-hidden="true" className={className} />;
    case 'skipped_duplicate':
      return <CopyCheck aria-hidden="true" className={className} />;
    default:
      return <HelpCircle aria-hidden="true" className={className} />;
  }
}

/** Status of one ingestion job; the reason code of a failed or needs_review job is the tooltip. */
export function IngestStatusBadge({ state, language, className }: IngestStatusBadgeProps) {
  const { label, tone } = describeIngestStatus(state, language);
  return (
    <span
      role="status"
      aria-label={label}
      title={state.reason ? `${label} (${state.reason})` : label}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs font-medium', TONE_CLASSES[tone], className)}
    >
      <StatusIcon state={state} tone={tone} />
      <span className="truncate">{label}</span>
    </span>
  );
}

export interface TrackedIngestStatusBadgeProps {
  jobId: string;
  organizationId?: string | null;
  language: string;
  className?: string;
  onSettled?: (state: IngestJobState) => void;
}

/** Follows a queued job with useIngestJobStatus and reports the final state once through onSettled. */
export function TrackedIngestStatusBadge({ jobId, organizationId, language, className, onSettled }: TrackedIngestStatusBadgeProps) {
  const state = useIngestJobStatus(jobId, organizationId);
  const settled = isTerminalIngestStatus(state.status) || state.status === 'not_found' || state.status === 'unavailable';
  useEffect(() => {
    if (settled) onSettled?.(state);
    // onSettled identity changes per render; settle once per job and final status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, jobId, state.status]);
  return <IngestStatusBadge state={state} language={language} className={className} />;
}
