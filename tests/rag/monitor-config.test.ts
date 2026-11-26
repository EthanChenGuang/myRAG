import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorSettings, PHASE53_SWITCH_DEFAULTS, type MonitorEnvInput } from '@/lib/rag/monitor/config';

const DEFAULTS = {
  monitor: false,
  webhookUrl: null,
  webhookSecret: null,
  configGate: 'off',
  configGateLive: false,
  representativeSample: false,
};

function warnSpy() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('monitorSettings (05.3 D-10, D-21, D-39)', () => {
  it('returns the defaults for an unset environment', () => {
    expect(monitorSettings({})).toEqual(DEFAULTS);
  });

  it('defaults equal the env defaults and turn nothing on', () => {
    expect(PHASE53_SWITCH_DEFAULTS).toEqual({
      RAG_MONITOR: 'false',
      RAG_MONITOR_WEBHOOK_URL: '',
      RAG_MONITOR_WEBHOOK_SECRET: '',
      RAG_CONFIG_GATE: 'off',
      RAG_CONFIG_GATE_LIVE: 'false',
      RAG_REPRESENTATIVE_SAMPLE: 'false',
    });
    expect(monitorSettings({ ...PHASE53_SWITCH_DEFAULTS })).toEqual(DEFAULTS);
  });

  it('reads the boolean switches', () => {
    const s = monitorSettings({ RAG_MONITOR: 'true', RAG_CONFIG_GATE_LIVE: 'true', RAG_REPRESENTATIVE_SAMPLE: 'true' });
    expect(s.monitor).toBe(true);
    expect(s.configGateLive).toBe(true);
    expect(s.representativeSample).toBe(true);
  });

  it('treats any boolean value other than true as off', () => {
    const s = monitorSettings({ RAG_MONITOR: 'yes', RAG_CONFIG_GATE_LIVE: '1', RAG_REPRESENTATIVE_SAMPLE: 'on' });
    expect(s.monitor).toBe(false);
    expect(s.configGateLive).toBe(false);
    expect(s.representativeSample).toBe(false);
  });

  it('reads RAG_CONFIG_GATE warn and enforce', () => {
    expect(monitorSettings({ RAG_CONFIG_GATE: 'enforce' }).configGate).toBe('enforce');
    expect(monitorSettings({ RAG_CONFIG_GATE: 'warn' }).configGate).toBe('warn');
    expect(monitorSettings({ RAG_CONFIG_GATE: ' Enforce ' }).configGate).toBe('enforce');
  });

  it('an invalid RAG_CONFIG_GATE falls back to off with one [Config Gate] warning naming the variable, not the value', () => {
    const spy = warnSpy();
    expect(monitorSettings({ RAG_CONFIG_GATE: 'strictest' }).configGate).toBe('off');
    expect(spy).toHaveBeenCalledTimes(1);
    const printed = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(printed).toMatch(/^\[Config Gate\]/);
    expect(printed).toContain('RAG_CONFIG_GATE');
    expect(printed).not.toContain('strictest');
  });

  it('a webhook secret of 31 characters counts as unset, 32 characters is used', () => {
    expect(monitorSettings({ RAG_MONITOR_WEBHOOK_SECRET: 'a'.repeat(31) }).webhookSecret).toBeNull();
    expect(monitorSettings({ RAG_MONITOR_WEBHOOK_SECRET: 'b'.repeat(32) }).webhookSecret).toBe('b'.repeat(32));
  });

  it('a webhook URL that is not https:// is unset, with one [Monitor] warning without the URL', () => {
    const spy = warnSpy();
    const url = 'http://hooks.example.invalid/path-0001';
    expect(monitorSettings({ RAG_MONITOR_WEBHOOK_URL: url }).webhookUrl).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const printed = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(printed).toMatch(/^\[Monitor\]/);
    expect(printed).toContain('RAG_MONITOR_WEBHOOK_URL');
    expect(printed).not.toContain('hooks.example.invalid');
  });

  it('an unparseable https value is unset too', () => {
    warnSpy();
    expect(monitorSettings({ RAG_MONITOR_WEBHOOK_URL: 'https://' }).webhookUrl).toBeNull();
  });

  it('keeps an https:// webhook URL', () => {
    const url = 'https://hooks.example.invalid/path-0002';
    expect(monitorSettings({ RAG_MONITOR_WEBHOOK_URL: url }).webhookUrl).toBe(url);
  });

  it('is evaluated per call', () => {
    const source: MonitorEnvInput = { RAG_MONITOR: 'false', RAG_CONFIG_GATE: 'off' };
    expect(monitorSettings(source).monitor).toBe(false);
    source.RAG_MONITOR = 'true';
    source.RAG_CONFIG_GATE = 'warn';
    const second = monitorSettings(source);
    expect(second.monitor).toBe(true);
    expect(second.configGate).toBe('warn');
  });

  it('reads the env singleton by default', () => {
    expect(monitorSettings()).toEqual(DEFAULTS);
  });
});
