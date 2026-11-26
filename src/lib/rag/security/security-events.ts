import type { z } from 'zod';
import type { OutputGuardSummarySchema, SecurityEventSchema } from '@/lib/rag-eval/contracts.generated';
import type { EnqueueReviewItemInput } from '../feedback-loop/enqueue-item';
import type { LangfuseEventInput, LangfuseScoreInput } from '../trace/scores';
import type { UploaderHoldMode } from '../generation/answer-config';

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
  tenantKey: string;
  events: readonly SecurityEvent[];
  traceId: string | null;
}

export interface OutputGuardEventContext {
  tenantKey: string;
  traceId: string | null;
  blocks: readonly SecurityBlock[];
  channel: 'chat' | 'embed' | 'whatsapp' | 'voice';
  removedTargets: readonly string[];
  matchedPhrases: readonly string[];
}

export function buildSecurityEvent(_input: SecurityEventInput): SecurityEvent {
  return {} as SecurityEvent;
}

export function attributeSourceChunks(_blocks: readonly SecurityBlock[], _needles: readonly string[]): AttributedSource[] {
  return [];
}

export function recordSecurityEvents(_input: RecordSecurityEventsInput, _deps?: Partial<SecurityEventsDeps>): void {}

export async function recordSecurityEventsInline(
  _input: RecordSecurityEventsInput,
  _deps?: Partial<SecurityEventsDeps>,
): Promise<{ eventIds: string[]; alertIds: string[] } | null> {
  return null;
}

export function recordOutputGuardEvents(_summary: OutputGuardSummary, _context: OutputGuardEventContext, _deps?: Partial<SecurityEventsDeps>): void {}
