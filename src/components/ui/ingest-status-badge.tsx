import type { IngestJobState } from '@/lib/hooks/use-ingest-job-status';

export interface IngestStatusBadgeProps {
  state: IngestJobState;
  language: string;
  className?: string;
}

export function IngestStatusBadge(_props: IngestStatusBadgeProps) {
  return <span />;
}
