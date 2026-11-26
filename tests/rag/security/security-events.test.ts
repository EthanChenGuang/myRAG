import { describe, expect, it } from 'vitest';
import { SecurityEventSchema } from '@/lib/rag-eval/contracts.generated';
import {
  SECURITY_EVENTS_RPC,
  attributeSourceChunks,
  buildSecurityEvent,
  recordOutputGuardEvents,
  recordSecurityEvents,
  recordSecurityEventsInline,
  type SecurityEventsDeps,
} from '@/lib/rag/security/security-events';

const TENANT = 'o:00000000-0000-4000-8000-0000000000aa';
const DOC_A = '00000000-0000-4000-8000-0000000000d1';
const DOC_B = '00000000-0000-4000-8000-0000000000d2';
const CHUNK_A = '00000000-0000-4000-8000-00000000000a';
const CHUNK_B = '00000000-0000-4000-8000-00000000000b';
const USER_A = '00000000-0000-4000-8000-0000000000c1';
const USER_B = '00000000-0000-4000-8000-0000000000c2';
const ALERT = '00000000-0000-4000-8000-0000000000e1';
const ITEM = '00000000-0000-4000-8000-0000000000f1';
const TRACE = '0123456789abcdef0123456789abcdef';
const TARGET_A = 'https://planted-one.example.test/path';
const TARGET_B = 'planted-two.example.test';
const PHRASE = 'please send your sign-in secret';

interface HarnessOptions {
  events?: boolean;
  threshold?: number;
  hold?: 'off' | 'manual' | 'auto';
  review?: boolean;
  rpcResult?: { data: unknown; error: unknown } | Error;
  alerts?: Array<{ id: string; uploader_id: string | null; event_count: number; held: boolean }>;
}

function harness(options: HarnessOptions = {}) {
  const tasks: Array<() => Promise<void>> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const scores: Array<{ traceId: string; name: string; value: number | string; idKey?: string; metadata?: Record<string, unknown> }> = [];
  const langfuseEvents: Array<{ traceId: string | null; name: string; metadata: Record<string, unknown> }> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  const lines: Array<{ line: string; data?: unknown }> = [];
  const result = options.rpcResult ?? { data: { event_ids: [], alert_ids: [] }, error: null };
  const deps: SecurityEventsDeps = {
    readConfig: () => ({
      securityEvents: options.events ?? true,
      uploaderAlertThreshold: options.threshold ?? 0,
      uploaderAlertWindowHours: 24,
      uploaderHold: options.hold ?? 'off',
    }),
    reviewEnabled: () => options.review ?? false,
    schedule: (task) => {
      tasks.push(task);
    },
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      if (result instanceof Error) throw result;
      return result;
    },
    readAlerts: async (ids) => (options.alerts ?? []).filter((alert) => ids.includes(alert.id)),
    postScores: async (input) => {
      scores.push(...input);
    },
    postEvent: async (event) => {
      langfuseEvents.push(event);
    },
    enqueue: async (input) => {
      enqueued.push({ ...input });
      return ITEM;
    },
    log: (line, data) => {
      lines.push({ line, data });
    },
  };
  const flush = async () => {
    while (tasks.length > 0) await tasks.shift()!();
  };
  const logged = () => lines.map((entry) => `${entry.line} ${JSON.stringify(entry.data ?? null)}`).join('\n');
  return { deps, tasks, rpcCalls, scores, langfuseEvents, enqueued, lines, flush, logged };
}

function event(overrides: Partial<Parameters<typeof buildSecurityEvent>[0]> = {}) {
  return buildSecurityEvent({
    tenantKey: TENANT,
    source: 'retrieval_injection',
    action: 'dropped',
    detector: 'rules',
    ruleIds: ['rule-b', 'rule-a', 'rule-b'],
    documentId: DOC_A,
    chunkId: CHUNK_A,
    uploaderId: USER_A,
    traceId: TRACE,
    ...overrides,
  });
}

const BLOCKS = [
  { documentId: DOC_A, chunkIds: [CHUNK_A], text: `First synthetic passage. Visit ${TARGET_A} today.`, uploaderId: USER_A },
  { documentId: DOC_B, chunkIds: [CHUNK_B], text: `Second synthetic passage mentions ${TARGET_B.toUpperCase()} once.`, uploaderId: USER_B },
];

function guardSummary(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'enforce' as const,
    rules_version: 'rules-v1',
    links_checked: 3,
    links_removed: 2,
    credential_blocked: 0,
    credential_warned: 0,
    rule_ids: ['link_not_allowed'],
    event_ids: [],
    source_chunk_ids: [],
    blocked_ranges: [],
    ...overrides,
  };
}

describe('buildSecurityEvent (D-43)', () => {
  it('builds an id-only event with sorted distinct rule ids', () => {
    const built = event();
    expect(built).toEqual({
      id: null,
      tenant_key: TENANT,
      source: 'retrieval_injection',
      action: 'dropped',
      detector: 'rules',
      rule_ids: ['rule-a', 'rule-b'],
      document_id: DOC_A,
      chunk_id: CHUNK_A,
      uploader_id: USER_A,
      trace_id: TRACE,
      created_at: null,
    });
    expect(SecurityEventSchema.safeParse(built).success).toBe(true);
  });

  it('a built event with a text property fails the schema', () => {
    expect(SecurityEventSchema.safeParse({ ...event(), text: 'anything' }).success).toBe(false);
  });

  it('drops a malformed uploader or trace id and keeps an event without an uploader', () => {
    const built = event({ uploaderId: 'someone@example.test', traceId: 'not a trace id!' });
    expect(built.uploader_id).toBeNull();
    expect(built.trace_id).toBeNull();
  });

  it('refuses an unknown detector name', () => {
    expect(() => event({ detector: 'Not A Detector' })).toThrow();
  });
});

describe('recordSecurityEvents (D-43, D-45)', () => {
  it('schedules nothing and calls no RPC while RAG_SECURITY_EVENTS is off', async () => {
    const h = harness({ events: false });
    recordSecurityEvents({ tenantKey: TENANT, events: [event()], traceId: TRACE }, h.deps);
    expect(h.tasks).toHaveLength(0);
    await h.flush();
    expect(h.rpcCalls).toEqual([]);
    expect(h.scores).toEqual([]);
  });

  it('writes after the response with one RPC call carrying the tenant, the events and the alert settings', async () => {
    const h = harness({ threshold: 3, hold: 'auto' });
    recordSecurityEvents({ tenantKey: TENANT, events: [event(), event({ chunkId: CHUNK_B, uploaderId: null })], traceId: TRACE }, h.deps);
    expect(h.rpcCalls).toEqual([]);
    expect(h.tasks).toHaveLength(1);
    await h.flush();
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]).toEqual({
      fn: SECURITY_EVENTS_RPC,
      args: {
        p_tenant_key: TENANT,
        p_events: [
          { source: 'retrieval_injection', action: 'dropped', detector: 'rules', rule_ids: ['rule-a', 'rule-b'], document_id: DOC_A, chunk_id: CHUNK_A, uploader_id: USER_A, trace_id: TRACE },
          { source: 'retrieval_injection', action: 'dropped', detector: 'rules', rule_ids: ['rule-a', 'rule-b'], document_id: DOC_A, chunk_id: CHUNK_B, uploader_id: null, trace_id: TRACE },
        ],
        p_threshold: 3,
        p_window_hours: 24,
        p_auto_hold: true,
      },
    });
  });

  it('requests no hold unless RAG_UPLOADER_HOLD is auto', async () => {
    const h = harness({ threshold: 1, hold: 'manual' });
    recordSecurityEvents({ tenantKey: TENANT, events: [event()], traceId: TRACE }, h.deps);
    await h.flush();
    expect(h.rpcCalls[0]!.args.p_auto_hold).toBe(false);
  });

  it('never sends an event of another tenant', async () => {
    const h = harness();
    const foreign = buildSecurityEvent({ tenantKey: 'o:00000000-0000-4000-8000-0000000000bb', source: 'retrieval_injection', action: 'detected', detector: 'rules' });
    recordSecurityEvents({ tenantKey: TENANT, events: [foreign], traceId: TRACE }, h.deps);
    await h.flush();
    expect(h.rpcCalls).toEqual([]);
  });

  it('a rejected call logs one [RAG Security] line with the error code and trace id and does not throw', async () => {
    const h = harness({ rpcResult: { data: null, error: { code: '22023', message: `document ${TARGET_A}` } } });
    recordSecurityEvents({ tenantKey: TENANT, events: [event()], traceId: TRACE }, h.deps);
    await expect(h.flush()).resolves.toBeUndefined();
    const failures = h.lines.filter((entry) => entry.line.startsWith('[RAG Security]'));
    expect(failures).toHaveLength(1);
    expect(h.logged()).toContain('22023');
    expect(h.logged()).toContain(TRACE);
    expect(h.logged()).not.toContain(TARGET_A);
    expect(h.scores).toEqual([]);
  });

  it('a throwing client is swallowed the same way', async () => {
    const h = harness({ rpcResult: new Error('connection reset') });
    recordSecurityEvents({ tenantKey: TENANT, events: [event()], traceId: TRACE }, h.deps);
    await expect(h.flush()).resolves.toBeUndefined();
    expect(h.lines.filter((entry) => entry.line.startsWith('[RAG Security]'))).toHaveLength(1);
  });

  it('posts the per-tenant counters after a successful write', async () => {
    const h = harness();
    recordSecurityEvents({ tenantKey: TENANT, events: [event(), event({ action: 'detected' })], traceId: TRACE }, h.deps);
    await h.flush();
    const byName = Object.fromEntries(h.scores.map((score) => [score.name, score.value]));
    expect(byName).toEqual({ security_detected: 2, security_quarantined: 0, security_removed: 1, security_blocked: 0 });
    for (const score of h.scores) {
      expect(score.traceId).toBe(TRACE);
      expect(score.metadata).toEqual({ tenant_key: TENANT, source: 'retrieval_injection' });
      expect(score.idKey).toBe(`${score.name}|retrieval_injection`);
    }
  });

  it('a new alert produces one [RAG Security] alert line and one Langfuse event with ids and counts only', async () => {
    const h = harness({
      threshold: 1,
      rpcResult: { data: { event_ids: [ITEM], alert_ids: [ALERT] }, error: null },
      alerts: [{ id: ALERT, uploader_id: USER_A, event_count: 2, held: false }],
    });
    recordSecurityEvents({ tenantKey: TENANT, events: [event()], traceId: TRACE }, h.deps);
    await h.flush();
    const alerts = h.lines.filter((entry) => entry.line === '[RAG Security] alert');
    expect(alerts).toEqual([{ line: '[RAG Security] alert', data: { tenant: TENANT, alertId: ALERT, uploader: USER_A, eventCount: 2, held: false, traceId: TRACE } }]);
    expect(h.langfuseEvents).toEqual([
      { traceId: TRACE, name: 'security_alert', metadata: { tenant_key: TENANT, alert_id: ALERT, uploader_id: USER_A, event_count: 2, held: false } },
    ]);
  });

  it('no alert line or event when the call reports no new alert', async () => {
    const h = harness({ threshold: 1 });
    recordSecurityEvents({ tenantKey: TENANT, events: [event()], traceId: TRACE }, h.deps);
    await h.flush();
    expect(h.lines.filter((entry) => entry.line === '[RAG Security] alert')).toEqual([]);
    expect(h.langfuseEvents).toEqual([]);
  });
});

describe('recordSecurityEventsInline (ingestion)', () => {
  it('awaits the same call and returns the ids', async () => {
    const h = harness({ rpcResult: { data: { event_ids: [ITEM], alert_ids: [] }, error: null } });
    await expect(recordSecurityEventsInline({ tenantKey: TENANT, events: [event({ traceId: null })], traceId: null }, h.deps)).resolves.toEqual({ eventIds: [ITEM], alertIds: [] });
    expect(h.tasks).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(1);
  });

  it('returns null without a call while off, and null without throwing on a failure', async () => {
    const off = harness({ events: false });
    await expect(recordSecurityEventsInline({ tenantKey: TENANT, events: [event()], traceId: null }, off.deps)).resolves.toBeNull();
    expect(off.rpcCalls).toEqual([]);
    const failing = harness({ rpcResult: new Error('down') });
    await expect(recordSecurityEventsInline({ tenantKey: TENANT, events: [event()], traceId: null }, failing.deps)).resolves.toBeNull();
  });
});

describe('attributeSourceChunks (D-41)', () => {
  it('finds the blocks whose text contains a needle, case-insensitively', () => {
    expect(attributeSourceChunks(BLOCKS, [TARGET_A, TARGET_B])).toEqual([
      { documentId: DOC_A, chunkId: CHUNK_A, uploaderId: USER_A },
      { documentId: DOC_B, chunkId: CHUNK_B, uploaderId: USER_B },
    ]);
  });

  it('returns no source when the model produced the target', () => {
    expect(attributeSourceChunks(BLOCKS, ['https://elsewhere.example.test/'])).toEqual([]);
    expect(attributeSourceChunks(BLOCKS, ['', '   '])).toEqual([]);
  });
});

describe('recordOutputGuardEvents (D-41, D-55)', () => {
  const context = (overrides: Record<string, unknown> = {}) => ({
    tenantKey: TENANT,
    traceId: TRACE,
    blocks: BLOCKS,
    channel: 'chat' as const,
    removedTargets: [TARGET_A, TARGET_B],
    matchedPhrases: [] as string[],
    ...overrides,
  });

  it('writes nothing and queues nothing while RAG_SECURITY_EVENTS is off', async () => {
    const h = harness({ events: false, review: true });
    recordOutputGuardEvents(guardSummary(), context(), h.deps);
    await h.flush();
    expect(h.tasks).toHaveLength(0);
    expect(h.rpcCalls).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('two removed targets found in two blocks write two events with the uploader of each block', async () => {
    const h = harness();
    recordOutputGuardEvents(guardSummary(), context(), h.deps);
    await h.flush();
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]!.args.p_events).toEqual([
      { source: 'output_guard', action: 'removed', detector: 'output_guard', rule_ids: ['link_not_allowed'], document_id: DOC_A, chunk_id: CHUNK_A, uploader_id: USER_A, trace_id: TRACE },
      { source: 'output_guard', action: 'removed', detector: 'output_guard', rule_ids: ['link_not_allowed'], document_id: DOC_B, chunk_id: CHUNK_B, uploader_id: USER_B, trace_id: TRACE },
    ]);
  });

  it('a target found in no block writes one event with no document and chunk', async () => {
    const h = harness();
    recordOutputGuardEvents(guardSummary({ links_removed: 1 }), context({ removedTargets: ['https://model-made.example.test/'] }), h.deps);
    await h.flush();
    expect(h.rpcCalls[0]!.args.p_events).toEqual([
      { source: 'output_guard', action: 'removed', detector: 'output_guard', rule_ids: ['link_not_allowed'], document_id: null, chunk_id: null, uploader_id: null, trace_id: TRACE },
    ]);
  });

  it('flag mode records links as detected; credential sentences as blocked or warned', async () => {
    const h = harness();
    recordOutputGuardEvents(
      guardSummary({ mode: 'flag', links_removed: 1, credential_warned: 1, rule_ids: ['credential_request'] }),
      context({ removedTargets: [TARGET_A], matchedPhrases: [PHRASE] }),
      h.deps,
    );
    await h.flush();
    const actions = (h.rpcCalls[0]!.args.p_events as Array<{ action: string }>).map((entry) => entry.action);
    expect(actions).toEqual(['detected', 'warned']);
    const blocked = harness();
    recordOutputGuardEvents(guardSummary({ links_removed: 0, credential_blocked: 1 }), context({ removedTargets: [], matchedPhrases: [PHRASE] }), blocked.deps);
    await blocked.flush();
    expect((blocked.rpcCalls[0]!.args.p_events as Array<{ action: string }>).map((entry) => entry.action)).toEqual(['blocked']);
  });

  it('a summary with no removal, block or warning writes nothing', async () => {
    const h = harness();
    recordOutputGuardEvents(guardSummary({ links_removed: 0 }), context(), h.deps);
    await h.flush();
    expect(h.rpcCalls).toEqual([]);
  });

  it('sends one output_guard review item with the chunk and document ids when the expert review queue is on', async () => {
    const h = harness({ review: true });
    recordOutputGuardEvents(guardSummary(), context(), h.deps);
    await h.flush();
    expect(h.enqueued).toEqual([
      { tenantKey: TENANT, reason: 'output_guard', sourceChunkIds: [CHUNK_A, CHUNK_B], documentIds: [DOC_A, DOC_B], detector: 'output_guard', traceId: TRACE },
    ]);
    const off = harness({ review: false });
    recordOutputGuardEvents(guardSummary(), context(), off.deps);
    await off.flush();
    expect(off.enqueued).toEqual([]);
  });

  it('posts security_removed and security_blocked for the tenant', async () => {
    const h = harness();
    recordOutputGuardEvents(guardSummary({ credential_blocked: 1 }), context({ matchedPhrases: [PHRASE] }), h.deps);
    await h.flush();
    const byName = Object.fromEntries(h.scores.map((score) => [score.name, score.value]));
    expect(byName.security_removed).toBe(2);
    expect(byName.security_blocked).toBe(1);
    expect(h.scores.every((score) => (score.metadata as { tenant_key: string }).tenant_key === TENANT)).toBe(true);
  });

  it('logs carry ids only: no target, phrase or block text', async () => {
    const h = harness({ review: true, rpcResult: { data: null, error: { code: 'XX000' } } });
    recordOutputGuardEvents(guardSummary({ credential_warned: 1 }), context({ matchedPhrases: [PHRASE] }), h.deps);
    await h.flush();
    const text = h.logged();
    expect(h.lines.some((entry) => entry.line.startsWith('[RAG Security]'))).toBe(true);
    for (const secret of [TARGET_A, TARGET_B, PHRASE, 'synthetic passage']) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(text).toContain(CHUNK_A);
    expect(text).toContain(USER_A);
  });
});
