import type { z } from 'zod';
import { SecurityEventSchema, type OutputGuardSummarySchema } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps } from '../deps';
import { enqueueReviewItem, type EnqueueReviewItemInput } from '../feedback-loop/enqueue-item';
import { readFeedbackLoopConfig } from '../feedback-loop/config';
import { readAnswerConfig, type UploaderHoldMode } from '../generation/answer-config';
import { scheduleAfterResponse } from '../trace/schedule';
import { postLangfuseEvent, postLangfuseScores, type LangfuseEventInput, type LangfuseScoreInput } from '../trace/scores';

/** The writer of rag_security_events and its alerts (0943); service role only. */
export const SECURITY_EVENTS_RPC = 'rag_record_security_events';

export type SecurityEvent = z.infer<typeof SecurityEventSchema>;
export type OutputGuardSummary = z.input<typeof OutputGuardSummarySchema>;

export interface SecurityEventInput {
  tenantKey: string;
  source: SecurityEvent['source'];
  action: SecurityEvent['action'];
  detector: string;
  ruleIds?: readonly string[];
  documentId?: string | null;
  chunkId?: string | null;
  uploaderId?: string | null;
  traceId?: string | null;
}

type RpcResult = { data: unknown; error: unknown };

export interface SecurityEventsConfig {
  securityEvents: boolean;
  uploaderAlertThreshold: number;
  uploaderAlertWindowHours: number;
  uploaderHold: UploaderHoldMode;
}

export interface SecurityAlertRow {
  id: string;
  uploader_id: string | null;
  event_count: number;
  held: boolean;
}

export interface SecurityEventsDeps {
  readConfig: () => SecurityEventsConfig;
  reviewEnabled: () => boolean;
  schedule: (task: () => Promise<void>) => void;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  readAlerts: (ids: readonly string[]) => Promise<SecurityAlertRow[]>;
  postScores: (scores: readonly LangfuseScoreInput[]) => Promise<unknown>;
  postEvent: (event: LangfuseEventInput) => Promise<unknown>;
  enqueue: (input: EnqueueReviewItemInput) => Promise<string | null>;
  log: (line: string, data?: unknown) => void;
}

/** What the writers need of a context block: ids, the text sent to the model (searched, never logged) and the uploader. */
export interface SecurityBlock {
  documentId: string;
  chunkIds: readonly string[];
  text: string;
  uploaderId?: string | null;
}

export interface AttributedSource {
  documentId: string;
  chunkId: string | null;
  uploaderId: string | null;
}

export interface RecordSecurityEventsInput {
  /** From the resolved scope, never from a request body. */
  tenantKey: string;
  events: readonly SecurityEvent[];
  traceId: string | null;
}

export interface OutputGuardEventContext {
  tenantKey: string;
  traceId: string | null;
  blocks: readonly SecurityBlock[];
  channel: 'chat' | 'embed' | 'whatsapp' | 'voice';
  /** The removed or flagged link targets; searched in the blocks, never logged or stored. */
  removedTargets: readonly string[];
  /** The matched credential-request phrases; searched in the blocks, never logged or stored. */
  matchedPhrases: readonly string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RULE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TRACE_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9_]{1,32}$/;
const MAX_RULE_IDS = 32;
const MAX_EVENTS_PER_CALL = 1000;
const OUTPUT_GUARD_DETECTOR = 'output_guard';

const COUNTERS = [
  ['security_detected', null],
  ['security_quarantined', ['quarantined']],
  ['security_removed', ['removed', 'dropped']],
  ['security_blocked', ['blocked']],
] as const satisfies ReadonlyArray<readonly [string, readonly SecurityEvent['action'][] | null]>;

function uuidOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.trim().toLowerCase();
  return UUID_RE.test(lowered) ? lowered : null;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE_RE.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && ERROR_CODE_RE.test(name)) return name;
  }
  return 'unknown';
}

function defaultLog(line: string, data?: unknown): void {
  if (data === undefined) console.warn(line);
  else console.warn(line, data);
}

const defaultDeps: SecurityEventsDeps = {
  readConfig: () => readAnswerConfig(),
  reviewEnabled: () => readFeedbackLoopConfig(process.env, () => undefined).domainExpertReview,
  schedule: scheduleAfterResponse,
  rpc: (fn, args) => {
    const client = getRagDeps().adminClient();
    if (!client) return Promise.reject(Object.assign(new Error('admin client unavailable'), { code: 'no_admin_client' }));
    return client.rpc(fn, args) as unknown as PromiseLike<RpcResult>;
  },
  readAlerts: async (ids) => {
    const client = getRagDeps().adminClient();
    if (!client || ids.length === 0) return [];
    const { data, error } = await client.from('rag_security_alerts').select('id, uploader_id, event_count, held').in('id', [...ids]);
    if (error) return [];
    return (data ?? []) as SecurityAlertRow[];
  },
  postScores: (scores) => postLangfuseScores(scores),
  postEvent: (event) => postLangfuseEvent(event),
  enqueue: (input) => enqueueReviewItem(input),
  log: defaultLog,
};

function resolveDeps(deps: Partial<SecurityEventsDeps> | undefined): SecurityEventsDeps {
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

/**
 * One rag_security_events row (D-43): ids, rule ids and codes only, validated with the generated contract, which has no text field.
 * Rule ids are sorted, distinct and capped at 32; a malformed uploader or trace id becomes null; an unknown detector name throws.
 */
export function buildSecurityEvent(input: SecurityEventInput): SecurityEvent {
  const ruleIds = [...new Set((input.ruleIds ?? []).filter((id) => typeof id === 'string' && RULE_ID_RE.test(id)))].sort().slice(0, MAX_RULE_IDS);
  const traceId = typeof input.traceId === 'string' && TRACE_RE.test(input.traceId) ? input.traceId : null;
  return SecurityEventSchema.parse({
    tenant_key: input.tenantKey,
    source: input.source,
    action: input.action,
    detector: input.detector,
    rule_ids: ruleIds,
    document_id: typeof input.documentId === 'string' && input.documentId !== '' ? input.documentId : null,
    chunk_id: typeof input.chunkId === 'string' && input.chunkId !== '' ? input.chunkId : null,
    uploader_id: uuidOrNull(input.uploaderId),
    trace_id: traceId,
  });
}

/** The 0943 event shape; ids that are not uuids are sent as null, since the function refuses them and would drop the whole call. */
function rpcEvent(event: SecurityEvent): Record<string, unknown> {
  return {
    source: event.source,
    action: event.action,
    detector: event.detector,
    rule_ids: event.rule_ids ?? [],
    document_id: uuidOrNull(event.document_id),
    chunk_id: uuidOrNull(event.chunk_id),
    uploader_id: uuidOrNull(event.uploader_id),
    trace_id: event.trace_id,
  };
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function counterScores(tenantKey: string, events: readonly SecurityEvent[], traceId: string): LangfuseScoreInput[] {
  const sources = new Set(events.map((event) => event.source));
  const source = sources.size === 1 ? [...sources][0]! : 'mixed';
  return COUNTERS.map(([name, actions]) => ({
    traceId,
    name,
    value: actions === null ? events.length : events.filter((event) => (actions as readonly string[]).includes(event.action)).length,
    dataType: 'NUMERIC' as const,
    idKey: `${name}|${source}`,
    metadata: { tenant_key: tenantKey, source },
  }));
}

/** The write itself: one RPC call, then the per-tenant counters and the alert signal. Never throws. */
async function writeEvents(
  input: RecordSecurityEventsInput,
  config: SecurityEventsConfig,
  deps: SecurityEventsDeps,
): Promise<{ eventIds: string[]; alertIds: string[] } | null> {
  const traceId = typeof input.traceId === 'string' && TRACE_RE.test(input.traceId) ? input.traceId : null;
  const events = input.events.filter((event) => event.tenant_key === input.tenantKey);
  if (events.length === 0) return null;
  const sent = events.slice(0, MAX_EVENTS_PER_CALL);
  let data: unknown;
  try {
    const result = await deps.rpc(SECURITY_EVENTS_RPC, {
      p_tenant_key: input.tenantKey,
      p_events: sent.map(rpcEvent),
      p_threshold: config.uploaderAlertThreshold,
      p_window_hours: config.uploaderAlertWindowHours,
      p_auto_hold: config.uploaderHold === 'auto',
    });
    if (result.error) {
      deps.log('[RAG Security] event write failed', { tenant: input.tenantKey, traceId, code: errorCode(result.error), events: sent.length });
      return null;
    }
    data = result.data;
  } catch (error) {
    deps.log('[RAG Security] event write failed', { tenant: input.tenantKey, traceId, code: errorCode(error), events: sent.length });
    return null;
  }
  const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const written = { eventIds: idsOf(payload.event_ids), alertIds: idsOf(payload.alert_ids) };

  try {
    if (traceId) await deps.postScores(counterScores(input.tenantKey, sent, traceId));
    if (written.alertIds.length > 0) {
      const rows = await deps.readAlerts(written.alertIds);
      for (const alertId of written.alertIds) {
        const row = rows.find((entry) => entry.id === alertId);
        const uploader = uuidOrNull(row?.uploader_id ?? null);
        const eventCount = typeof row?.event_count === 'number' ? row.event_count : null;
        const held = row?.held === true;
        deps.log('[RAG Security] alert', { tenant: input.tenantKey, alertId, uploader, eventCount, held, traceId });
        await deps.postEvent({
          traceId,
          name: 'security_alert',
          metadata: { tenant_key: input.tenantKey, alert_id: alertId, uploader_id: uploader, event_count: eventCount, held },
        });
      }
    }
  } catch (error) {
    deps.log('[RAG Security] event signal failed', { tenant: input.tenantKey, traceId, code: errorCode(error) });
  }
  return written;
}

function enabledConfig(deps: SecurityEventsDeps): SecurityEventsConfig | null {
  try {
    const config = deps.readConfig();
    return config.securityEvents ? config : null;
  } catch {
    return null;
  }
}

/** Request-path writer (D-43): with RAG_SECURITY_EVENTS on, one RPC call after the response; a failure is logged, never raised. */
export function recordSecurityEvents(input: RecordSecurityEventsInput, deps?: Partial<SecurityEventsDeps>): void {
  const resolved = resolveDeps(deps);
  const config = enabledConfig(resolved);
  if (!config || input.events.length === 0) return;
  resolved.schedule(async () => {
    await writeEvents(input, config, resolved);
  });
}

/** Ingestion writer: the same call, awaited; returns the written ids, or null when off or on a failure. Never throws. */
export async function recordSecurityEventsInline(
  input: RecordSecurityEventsInput,
  deps?: Partial<SecurityEventsDeps>,
): Promise<{ eventIds: string[]; alertIds: string[] } | null> {
  const resolved = resolveDeps(deps);
  const config = enabledConfig(resolved);
  if (!config || input.events.length === 0) return null;
  try {
    return await writeEvents(input, config, resolved);
  } catch {
    return null;
  }
}

/**
 * D-41: the blocks of this turn whose text contains a needle (case-insensitive string search over the text sent). One source per
 * matched block, in block order; its chunk is the block's first chunk. Empty means the model produced the target.
 */
export function attributeSourceChunks(blocks: readonly SecurityBlock[], needles: readonly string[]): AttributedSource[] {
  const wanted = needles.map((needle) => (typeof needle === 'string' ? needle.trim().toLowerCase() : '')).filter((needle) => needle !== '');
  if (wanted.length === 0) return [];
  const sources: AttributedSource[] = [];
  for (const block of blocks) {
    const text = typeof block.text === 'string' ? block.text.toLowerCase() : '';
    if (!wanted.some((needle) => text.includes(needle))) continue;
    sources.push({ documentId: block.documentId, chunkId: block.chunkIds[0] ?? null, uploaderId: uuidOrNull(block.uploaderId ?? null) });
  }
  return sources;
}

/**
 * D-41 and D-55: one output_guard event per attributed source chunk for each removal, block and warning kind (none found: one event
 * with no document and chunk), written after the response; with the expert review queue on, one output_guard review item with the
 * attributed chunk and document ids. Logs carry ids only.
 */
export function recordOutputGuardEvents(summary: OutputGuardSummary, context: OutputGuardEventContext, deps?: Partial<SecurityEventsDeps>): void {
  const resolved = resolveDeps(deps);
  const config = enabledConfig(resolved);
  if (!config) return;

  const kinds: Array<{ action: SecurityEvent['action']; needles: readonly string[] }> = [];
  if ((summary.links_removed ?? 0) > 0) kinds.push({ action: summary.mode === 'enforce' ? 'removed' : 'detected', needles: context.removedTargets });
  if ((summary.credential_blocked ?? 0) > 0) kinds.push({ action: 'blocked', needles: context.matchedPhrases });
  if ((summary.credential_warned ?? 0) > 0) kinds.push({ action: 'warned', needles: context.matchedPhrases });
  if (kinds.length === 0) return;

  const events: SecurityEvent[] = [];
  const chunkIds = new Set<string>();
  const documentIds = new Set<string>();
  try {
    for (const kind of kinds) {
      const sources = attributeSourceChunks(context.blocks, kind.needles);
      const targets: Array<AttributedSource | null> = sources.length > 0 ? sources : [null];
      for (const source of targets) {
        events.push(
          buildSecurityEvent({
            tenantKey: context.tenantKey,
            source: 'output_guard',
            action: kind.action,
            detector: OUTPUT_GUARD_DETECTOR,
            ruleIds: summary.rule_ids ?? [],
            documentId: source?.documentId ?? null,
            chunkId: source?.chunkId ?? null,
            uploaderId: source?.uploaderId ?? null,
            traceId: context.traceId,
          }),
        );
        if (source?.chunkId) chunkIds.add(source.chunkId);
        if (source?.documentId) documentIds.add(source.documentId);
      }
    }
  } catch (error) {
    resolved.log('[RAG Security] output guard events not built', { tenant: context.tenantKey, traceId: context.traceId, code: errorCode(error) });
    return;
  }

  resolved.log('[RAG Security] Output guard', {
    tenant: context.tenantKey,
    traceId: context.traceId,
    channel: context.channel,
    detector: OUTPUT_GUARD_DETECTOR,
    actions: events.map((event) => event.action),
    documents: events.map((event) => event.document_id),
    chunks: events.map((event) => event.chunk_id),
    uploaders: events.map((event) => event.uploader_id),
    ruleIds: summary.rule_ids ?? [],
  });

  const reviewOn = (() => {
    try {
      return resolved.reviewEnabled();
    } catch {
      return false;
    }
  })();
  resolved.schedule(async () => {
    await writeEvents({ tenantKey: context.tenantKey, events, traceId: context.traceId }, config, resolved);
    if (!reviewOn || (chunkIds.size === 0 && documentIds.size === 0)) return;
    try {
      await resolved.enqueue({
        tenantKey: context.tenantKey,
        reason: 'output_guard',
        sourceChunkIds: [...chunkIds].sort(),
        documentIds: [...documentIds].sort(),
        detector: OUTPUT_GUARD_DETECTOR,
        traceId: context.traceId,
      });
    } catch (error) {
      resolved.log('[RAG Security] review hand-off failed', { tenant: context.tenantKey, traceId: context.traceId, code: errorCode(error) });
    }
  });
}

/** Scalar span attributes for an injection_check or output_guard span: tenant and comma-joined ids, never text (D-44). */
export function securitySpanAttributes(tenantKey: string, events: readonly SecurityEvent[]): Record<string, string | number> {
  const join = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort().join(',');
  return {
    security_tenant: tenantKey,
    security_events: events.length,
    security_documents: join(events.map((event) => event.document_id)),
    security_chunks: join(events.map((event) => event.chunk_id)),
    security_uploaders: join(events.map((event) => event.uploader_id)),
    security_detectors: join(events.map((event) => event.detector)),
  };
}
