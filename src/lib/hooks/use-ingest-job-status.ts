import { useEffect, useState } from 'react';
import { env } from '@/lib/env';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { createClient } from '@/lib/supabase/client';

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

export const INGEST_POLL_FAST_MS = 2000;
export const INGEST_POLL_SLOW_MS = 10_000;
export const INGEST_POLL_SLOW_AFTER_MS = 60_000;

const BROADCAST_EVENT = 'ingest_status';
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['ready', 'failed', 'needs_review', 'quarantined', 'pending_review', 'skipped_duplicate']);
const STOPPED_STATUSES: ReadonlySet<string> = new Set([...TERMINAL_STATUSES, 'not_found', 'unavailable']);

export function isTerminalIngestStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 2 s for the first minute, 10 s afterwards; consecutive errors double the delay up to 10 s. */
export function ingestJobPollDelayMs(elapsedMs: number, consecutiveErrors = 0): number {
  const base = elapsedMs >= INGEST_POLL_SLOW_AFTER_MS ? INGEST_POLL_SLOW_MS : INGEST_POLL_FAST_MS;
  if (consecutiveErrors <= 0) return base;
  return Math.max(base, Math.min(INGEST_POLL_SLOW_MS, INGEST_POLL_FAST_MS * 2 ** consecutiveErrors));
}

/**
 * The topic the client asks for. It is only a request: the realtime.messages policy of migration 0353
 * decides what a session may read, and a denied subscription leaves polling in charge.
 */
export function ingestRealtimeTopic(input: {
  deploymentMode: IngestDeploymentMode;
  organizationId?: string | null;
  userId?: string | null;
}): string | null {
  if (input.deploymentMode === 'single-tenant') return 'rag-ingest:s:default';
  if (input.organizationId) return `rag-ingest:o:${input.organizationId}`;
  if (input.userId) return `rag-ingest:u:${input.userId}`;
  return null;
}

type BroadcastListener = (payload: unknown) => void;

interface HubEntry {
  channel: IngestRealtimeChannelLike;
  listeners: Set<BroadcastListener>;
}

const hubs = new WeakMap<IngestRealtimeClientLike, Map<string, HubEntry>>();

function subscribeTopic(client: IngestRealtimeClientLike, topic: string, listener: BroadcastListener): () => void {
  let topics = hubs.get(client);
  if (!topics) {
    topics = new Map();
    hubs.set(client, topics);
  }
  const registry = topics;
  let entry = registry.get(topic);
  if (!entry) {
    const listeners = new Set<BroadcastListener>();
    const channel = client.channel(topic, { config: { private: true } });
    const created: HubEntry = { channel, listeners };
    registry.set(topic, created);
    entry = created;
    channel
      .on('broadcast', { event: BROADCAST_EVENT }, (message) => {
        for (const each of listeners) each(message?.payload);
      })
      .subscribe((status) => {
        if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT') return;
        if (registry.get(topic) !== created) return;
        registry.delete(topic);
        void client.removeChannel(channel);
      });
  }
  const current = entry;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0 || registry.get(topic) !== current) return;
    registry.delete(topic);
    void client.removeChannel(current.channel);
  };
}

function readBroadcast(jobId: string, payload: unknown): IngestJobState | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.job_id !== jobId || typeof body.status !== 'string') return null;
  return {
    status: body.status,
    stage: typeof body.stage === 'string' ? body.stage : null,
    provisional: body.provisional === true,
    needsReview: body.status === 'needs_review',
    reason: null,
  };
}

function readPollBody(body: unknown): IngestJobState | null {
  if (!body || typeof body !== 'object') return null;
  const data = body as Record<string, unknown>;
  if (typeof data.status !== 'string') return null;
  return {
    status: data.status,
    stage: typeof data.stage === 'string' ? data.stage : null,
    provisional: data.provisional === true,
    needsReview: data.needsReview === true,
    reason: typeof data.reason === 'string' ? data.reason : null,
  };
}

/** Polls the job status route and, when enabled, follows the private Realtime channel; polling stays the fallback. */
export function createIngestJobTracker(options: IngestJobTrackerOptions): { start(): void; stop(): void } {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const query = options.organizationId ? `?organizationId=${encodeURIComponent(options.organizationId)}` : '';
  const url = `/api/rag/ingest/jobs/${encodeURIComponent(options.jobId)}${query}`;

  let stopped = true;
  let startedAt = 0;
  let errors = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let inFlight = false;
  let unsubscribe: (() => void) | null = null;
  let lastStatus = INITIAL_INGEST_JOB_STATE.status;

  const emit = (state: IngestJobState) => {
    if (stopped) return;
    lastStatus = state.status;
    options.onUpdate(state);
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void poll(), ingestJobPollDelayMs(now() - startedAt, errors));
  };

  const finish = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const poll = async () => {
    if (stopped || inFlight) return;
    if (timer) clearTimeout(timer);
    timer = null;
    inFlight = true;
    const own = new AbortController();
    controller = own;
    try {
      const response = await fetchImpl(url, { signal: own.signal, cache: 'no-store', credentials: 'same-origin' });
      if (stopped) return;
      if (response.status === 404) {
        emit({ ...INITIAL_INGEST_JOB_STATE, status: 'not_found' });
        finish();
        return;
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        emit({ ...INITIAL_INGEST_JOB_STATE, status: 'unavailable' });
        finish();
        return;
      }
      const state = response.ok ? readPollBody(await response.json()) : null;
      if (stopped) return;
      if (!state) {
        errors += 1;
        schedule();
        return;
      }
      errors = 0;
      emit(state);
      if (isTerminalIngestStatus(state.status)) {
        finish();
        return;
      }
      schedule();
    } catch {
      if (stopped || own.signal.aborted) return;
      errors += 1;
      schedule();
    } finally {
      inFlight = false;
    }
  };

  const connectRealtime = async () => {
    const realtime = options.realtime;
    if (!realtime?.enabled) return;
    try {
      const client = realtime.getClient();
      if (!client) return;
      let userId: string | null = null;
      if (realtime.deploymentMode === 'multi-tenant' && !options.organizationId) {
        const { data } = await client.auth.getSession();
        userId = data.session?.user.id ?? null;
      }
      const topic = ingestRealtimeTopic({ deploymentMode: realtime.deploymentMode, organizationId: options.organizationId, userId });
      if (!topic || stopped) return;
      await client.realtime?.setAuth?.();
      if (stopped) return;
      unsubscribe = subscribeTopic(client, topic, (payload) => {
        const state = readBroadcast(options.jobId, payload);
        if (!state || STOPPED_STATUSES.has(lastStatus)) return;
        emit(state);
        if (isTerminalIngestStatus(state.status)) void poll();
      });
    } catch {
      // Realtime is optional; polling keeps running.
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      startedAt = now();
      errors = 0;
      void poll();
      void connectRealtime();
    },
    stop: finish,
  };
}

function browserRealtimeClient(): IngestRealtimeClientLike | null {
  const client = createClient() as Partial<IngestRealtimeClientLike> | null;
  if (!client || typeof client.channel !== 'function' || typeof client.removeChannel !== 'function' || !client.auth) return null;
  return client as IngestRealtimeClientLike;
}

interface HeldState {
  jobId: string;
  organizationId: string | null;
  state: IngestJobState;
}

/** Follows one ingestion job: GET /api/rag/ingest/jobs/{id} polling, plus Realtime when NEXT_PUBLIC_RAG_INGEST_REALTIME is true. */
export function useIngestJobStatus(jobId: string | null | undefined, organizationId?: string | null): IngestJobState {
  const [held, setHeld] = useState<HeldState | null>(null);
  const orgId = organizationId ?? null;

  useEffect(() => {
    if (!jobId) return;
    const tracker = createIngestJobTracker({
      jobId,
      organizationId: orgId,
      onUpdate: (state) => setHeld({ jobId, organizationId: orgId, state }),
      realtime: {
        enabled: env.NEXT_PUBLIC_RAG_INGEST_REALTIME === 'true',
        deploymentMode: getDeploymentMode(),
        getClient: browserRealtimeClient,
      },
    });
    tracker.start();
    return () => tracker.stop();
  }, [jobId, orgId]);

  return held && held.jobId === jobId && held.organizationId === orgId ? held.state : INITIAL_INGEST_JOB_STATE;
}
