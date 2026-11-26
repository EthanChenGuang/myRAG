import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MonitorAlertSchema, type MonitorAlert } from '@/lib/rag-eval/contracts.generated';
import type { MonitorSettings } from '@/lib/rag/monitor/config';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import { scoreId } from '@/lib/rag/trace/scores';
import {
  deliverAlerts,
  fromAlertRow,
  MAX_DELIVERY_ATTEMPTS,
  signWebhookBody,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@/lib/rag/monitor/deliver';

const NOW = new Date('2026-03-06T01:00:00.000Z');
const URL_OK = 'https://hooks.example.test/monitor';
const SECRET_32 = 'k'.repeat(32);
const SECRET_31 = 'k'.repeat(31);
const TRACE_A = 'trace-0001';
const TRACE_B = 'trace-0002';

function alert(overrides: Partial<MonitorAlert> = {}): MonitorAlert {
  return MonitorAlertSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    tenant_key: 's:default',
    rule: 'refusal_rate',
    kind: 'rate',
    language: 'und',
    day: '2026-03-05',
    window_days: 1,
    severity: 'alert',
    status: 'open',
    observed: { count: 38, n: 100, value: 0.38 },
    baseline: { count: 30, n: 250, value: 0.12 },
    band: { warn: 0.05, alert: 0.1, measured_delta: 0.26 },
    sample_trace_ids: [TRACE_A, TRACE_B],
    config_changes: [],
    delivered: { webhook: { state: 'pending', attempts: 0, last_attempt_at: null } },
    dedup_key: 'refusal_rate|und|1',
    created_at: '2026-03-06T00:30:00.000Z',
    updated_at: '2026-03-06T00:30:00.000Z',
    ...overrides,
  });
}

function settings(overrides: Partial<MonitorSettings> = {}): MonitorSettings {
  return {
    monitor: true,
    webhookUrl: URL_OK,
    webhookSecret: SECRET_32,
    configGate: 'off',
    configGateLive: false,
    representativeSample: false,
    ...overrides,
  };
}

const LANGFUSE_OFF: LangfuseConfig = {
  enabled: false,
  publicKey: '',
  secretKey: '',
  baseUrl: 'https://langfuse.example.test',
  sampleRate: 0,
  reviewSampleRate: 0,
  captureContent: false,
};
const LANGFUSE_ON: LangfuseConfig = { ...LANGFUSE_OFF, enabled: true, publicKey: 'pk-placeholder', secretKey: 'sk-placeholder' };

const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number | ((url: string) => number | Error)): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const value = typeof status === 'function' ? status(url) : status;
    if (value instanceof Error) throw value;
    return new Response(value === 204 ? null : 'ok', { status: value, headers: value === 302 ? { location: 'https://elsewhere.example.test/' } : {} });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function webhookCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url === URL_OK);
}

describe('deliverAlerts webhook channel', () => {
  it('records disabled when no webhook URL is configured; the banner is delivered and Langfuse disabled without keys', async () => {
    const { fetch, calls } = fakeFetch(204);
    const [report] = await deliverAlerts([alert()], {
      settings: settings({ webhookUrl: null }),
      fetch,
      lookupHost: publicLookup,
      now: NOW,
      langfuse: LANGFUSE_OFF,
    });
    expect(calls).toHaveLength(0);
    expect(report!.banner).toEqual({ status: 'delivered', at: NOW.toISOString() });
    expect(report!.delivered.webhook).toEqual({ state: 'disabled', attempts: 0, last_attempt_at: NOW.toISOString() });
    expect(report!.delivered.langfuse).toEqual({ state: 'disabled', attempts: 0, last_attempt_at: NOW.toISOString() });
  });

  it('fails without a request when the host resolves to a private address', async () => {
    const { fetch, calls } = fakeFetch(204);
    const [report] = await deliverAlerts([alert()], { settings: settings(), fetch, lookupHost: privateLookup, now: NOW, langfuse: LANGFUSE_OFF });
    expect(calls).toHaveLength(0);
    expect(report!.delivered.webhook).toEqual({ state: 'failed', attempts: 1, last_attempt_at: NOW.toISOString() });
  });

  it('fails on a URL with credentials or a literal private address, never sending', async () => {
    for (const webhookUrl of ['https://user:pw@hooks.example.test/x', 'https://127.0.0.1/x', 'https://[::1]/x']) {
      const { fetch, calls } = fakeFetch(204);
      const [report] = await deliverAlerts([alert()], { settings: settings({ webhookUrl }), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
      expect(calls).toHaveLength(0);
      expect(report!.delivered.webhook!.state).toBe('failed');
    }
  });

  it('treats a redirect and a server error as failed and a 204 as delivered', async () => {
    for (const [status, state] of [
      [302, 'failed'],
      [500, 'failed'],
      [204, 'delivered'],
      [200, 'delivered'],
    ] as const) {
      const { fetch, calls } = fakeFetch(status);
      const [report] = await deliverAlerts([alert()], { settings: settings(), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
      expect(webhookCalls(calls)).toHaveLength(1);
      expect(webhookCalls(calls)[0]!.init.redirect).toBe('manual');
      expect(report!.delivered.webhook).toEqual({ state, attempts: 1, last_attempt_at: NOW.toISOString() });
    }
  });

  it('records failed when the request throws, without throwing', async () => {
    const { fetch } = fakeFetch(() => new Error('connection reset'));
    const [report] = await deliverAlerts([alert()], { settings: settings(), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
    expect(report!.delivered.webhook!.state).toBe('failed');
  });

  it('signs timestamp.body with a 32-character secret; the signature verifies', async () => {
    const { fetch, calls } = fakeFetch(204);
    await deliverAlerts([alert()], { settings: settings(), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
    const call = webhookCalls(calls)[0]!;
    const headers = new Headers(call.init.headers);
    const timestamp = headers.get(WEBHOOK_TIMESTAMP_HEADER);
    expect(timestamp).toBe(String(Math.floor(NOW.getTime() / 1000)));
    const body = String(call.init.body);
    const expected = `sha256=${createHmac('sha256', SECRET_32).update(`${timestamp}.${body}`).digest('hex')}`;
    expect(headers.get(WEBHOOK_SIGNATURE_HEADER)).toBe(expected);
    expect(signWebhookBody(SECRET_32, timestamp!, body)).toBe(expected);
    expect(headers.get('content-type')).toBe('application/json');
    expect(call.init.method).toBe('POST');
  });

  it('sends no signature header with a 31-character secret', async () => {
    const { fetch, calls } = fakeFetch(204);
    await deliverAlerts([alert()], {
      settings: settings({ webhookSecret: SECRET_31 }),
      fetch,
      lookupHost: publicLookup,
      now: NOW,
      langfuse: LANGFUSE_OFF,
    });
    const headers = new Headers(webhookCalls(calls)[0]!.init.headers);
    expect(headers.get(WEBHOOK_SIGNATURE_HEADER)).toBeNull();
    expect(headers.get(WEBHOOK_TIMESTAMP_HEADER)).not.toBeNull();
  });

  it('posts the contract alert as the body; no string in it is free text', async () => {
    const { fetch, calls } = fakeFetch(204);
    const source = alert();
    await deliverAlerts([source], { settings: settings(), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
    const body = JSON.parse(String(webhookCalls(calls)[0]!.init.body)) as unknown;
    expect(MonitorAlertSchema.parse(body)).toEqual(source);
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(body);
    for (const value of strings) expect(value).toMatch(/^[A-Za-z0-9_.:|+\-]{1,256}$/);
  });

  it('tries a channel that failed on four earlier runs a fifth time, then leaves it failed', async () => {
    const earlier = alert({ delivered: { webhook: { state: 'failed', attempts: MAX_DELIVERY_ATTEMPTS - 1, last_attempt_at: '2026-03-05T01:00:00.000Z' } } });
    const first = fakeFetch(500);
    const [fifth] = await deliverAlerts([earlier], { settings: settings(), fetch: first.fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
    expect(webhookCalls(first.calls)).toHaveLength(1);
    expect(fifth!.delivered.webhook).toEqual({ state: 'failed', attempts: MAX_DELIVERY_ATTEMPTS, last_attempt_at: NOW.toISOString() });

    const second = fakeFetch(204);
    const [sixth] = await deliverAlerts([alert({ delivered: fifth!.delivered })], {
      settings: settings(),
      fetch: second.fetch,
      lookupHost: publicLookup,
      now: new Date('2026-03-07T01:00:00.000Z'),
      langfuse: LANGFUSE_OFF,
    });
    expect(webhookCalls(second.calls)).toHaveLength(0);
    expect(sixth!.delivered.webhook).toEqual(fifth!.delivered.webhook);
  });

  it('does not send again once delivered', async () => {
    const done = alert({ delivered: { webhook: { state: 'delivered', attempts: 1, last_attempt_at: '2026-03-05T01:00:00.000Z' } } });
    const { fetch, calls } = fakeFetch(204);
    const [report] = await deliverAlerts([done], { settings: settings(), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_OFF });
    expect(webhookCalls(calls)).toHaveLength(0);
    expect(report!.delivered.webhook!.state).toBe('delivered');
  });
});

describe('deliverAlerts Langfuse channel', () => {
  it('posts one rag_monitor_alert score per sample trace with the alert id and rule in metadata', async () => {
    const { fetch, calls } = fakeFetch((url) => (url.startsWith(LANGFUSE_ON.baseUrl) ? 202 : 204));
    const source = alert();
    const [report] = await deliverAlerts([source], { settings: settings({ webhookUrl: null }), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_ON });
    const langfuseCalls = calls.filter((call) => call.url.startsWith(LANGFUSE_ON.baseUrl));
    expect(langfuseCalls).toHaveLength(1);
    const scores = JSON.parse(String(langfuseCalls[0]!.init.body)) as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(2);
    for (const [index, traceId] of [TRACE_A, TRACE_B].entries()) {
      expect(scores[index]).toMatchObject({
        id: scoreId(traceId, 'rag_monitor_alert'),
        traceId,
        name: 'rag_monitor_alert',
        value: 1,
        dataType: 'NUMERIC',
        metadata: { alert_id: source.id, rule: 'refusal_rate', severity: 'alert' },
      });
      expect(scores[index]).not.toHaveProperty('comment');
    }
    expect(report!.delivered.langfuse).toEqual({ state: 'delivered', attempts: 1, last_attempt_at: NOW.toISOString() });
  });

  it('records failed, never throwing, when the Langfuse request fails', async () => {
    const { fetch } = fakeFetch(() => new Error('down'));
    const [report] = await deliverAlerts([alert()], { settings: settings({ webhookUrl: null }), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_ON });
    expect(report!.delivered.langfuse!.state).toBe('failed');
    expect(report!.delivered.langfuse!.attempts).toBe(1);
  });

  it('records disabled when the alert has no sample trace', async () => {
    const { fetch, calls } = fakeFetch(202);
    const [report] = await deliverAlerts([alert({ sample_trace_ids: [] })], {
      settings: settings({ webhookUrl: null }),
      fetch,
      lookupHost: publicLookup,
      now: NOW,
      langfuse: LANGFUSE_ON,
    });
    expect(calls).toHaveLength(0);
    expect(report!.delivered.langfuse!.state).toBe('disabled');
  });
});

describe('logging and row mapping', () => {
  it('never logs the webhook URL or the secret', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      }),
    );
    try {
      const { fetch } = fakeFetch(500);
      await deliverAlerts([alert()], { settings: settings(), fetch, lookupHost: publicLookup, now: NOW, langfuse: LANGFUSE_ON });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).not.toContain('hooks.example.test');
    expect(text).not.toContain(SECRET_32);
    expect(text).not.toContain('pk-placeholder');
  });

  it('maps a stored row back to the contract alert', () => {
    const row = {
      id: '11111111-2222-4333-8444-555555555555',
      tenant_key: 's:default',
      rule: 'refusal_rate',
      kind: 'rate',
      language: 'und',
      day: '2026-03-05',
      window_days: 1,
      severity: 'alert',
      status: 'open',
      observed_count: 38,
      observed_total: 100,
      observed_rate: 0.38,
      baseline_count: 30,
      baseline_total: 250,
      baseline_rate: 0.12,
      band: { warn: 0.05 },
      breakdown: {},
      companions: { not_helpful_rate: { value: 0.2, baseline: 0.1, n: 40 } },
      sample_trace_ids: [TRACE_A],
      config_changes: [],
      suggestion: null,
      delivered: { webhook: { state: 'pending', attempts: 0, last_attempt_at: null } },
      dedup_key: 'refusal_rate|und|1',
      acknowledged_at: null,
      created_at: new Date('2026-03-06T00:30:00.000Z'),
      updated_at: '2026-03-06T00:30:00+00:00',
    };
    const mapped = fromAlertRow(row);
    expect(mapped).not.toBeNull();
    expect(mapped!.observed).toEqual({ count: 38, n: 100, value: 0.38 });
    expect(mapped!.baseline).toEqual({ count: 30, n: 250, value: 0.12 });
    expect(mapped!.companions).toEqual([{ rule: 'not_helpful_rate', value: 0.2, baseline: 0.1, n: 40 }]);
    expect(mapped!.created_at).toBe('2026-03-06T00:30:00.000Z');
    expect(fromAlertRow({ ...row, rule: 'not a rule' })).toBeNull();
  });
});
