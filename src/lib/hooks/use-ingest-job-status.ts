export interface IngestJobState {
  status: string;
  stage: string | null;
  provisional: boolean;
  needsReview: boolean;
  reason: string | null;
}

export const INITIAL_INGEST_JOB_STATE: IngestJobState = {
  status: 'queued',
  stage: null,
  provisional: false,
  needsReview: false,
  reason: null,
};

export type IngestDeploymentMode = 'single-tenant' | 'multi-tenant';

export interface IngestRealtimeChannelLike {
  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): IngestRealtimeChannelLike;
  subscribe(callback?: (status: string) => void): IngestRealtimeChannelLike;
}

export interface IngestRealtimeClientLike {
  channel(topic: string, options: { config: { private: boolean } }): IngestRealtimeChannelLike;
  removeChannel(channel: IngestRealtimeChannelLike): unknown;
  auth: { getSession(): Promise<{ data: { session: { user: { id: string } } | null } }> };
  realtime?: { setAuth?: () => unknown };
}

export interface IngestJobTrackerOptions {
  jobId: string;
  organizationId?: string | null;
  onUpdate: (state: IngestJobState) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  realtime?: {
    enabled: boolean;
    deploymentMode: IngestDeploymentMode;
    getClient: () => IngestRealtimeClientLike | null;
  };
}

export function isTerminalIngestStatus(_status: string): boolean {
  return false;
}

export function ingestJobPollDelayMs(_elapsedMs: number, _consecutiveErrors = 0): number {
  return 0;
}

export function ingestRealtimeTopic(_input: {
  deploymentMode: IngestDeploymentMode;
  organizationId?: string | null;
  userId?: string | null;
}): string | null {
  return null;
}

export function createIngestJobTracker(_options: IngestJobTrackerOptions): { start(): void; stop(): void } {
  return { start() {}, stop() {} };
}

export function useIngestJobStatus(_jobId: string | null | undefined, _organizationId?: string | null): IngestJobState {
  return INITIAL_INGEST_JOB_STATE;
}
