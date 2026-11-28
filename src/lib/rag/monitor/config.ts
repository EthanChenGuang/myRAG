import { env } from '@/lib/env';

export type ConfigGateMode = 'off' | 'warn' | 'enforce';

export interface MonitorSettings {
  monitor: boolean;
  webhookUrl: string | null;
  webhookSecret: string | null;
  configGate: ConfigGateMode;
  configGateLive: boolean;
  representativeSample: boolean;
}

/** The six Phase 5.3 switches (D-57) with their default strings; every default leaves the feature off. */
export const PHASE53_SWITCH_DEFAULTS = {
  RAG_MONITOR: 'false',
  RAG_MONITOR_WEBHOOK_URL: '',
  RAG_MONITOR_WEBHOOK_SECRET: '',
  RAG_CONFIG_GATE: 'off',
  RAG_CONFIG_GATE_LIVE: 'false',
  RAG_REPRESENTATIVE_SAMPLE: 'false',
} as const;

export type Phase53SwitchName = keyof typeof PHASE53_SWITCH_DEFAULTS;
export type MonitorEnvInput = Partial<Record<Phase53SwitchName, string | undefined>>;

export const MIN_WEBHOOK_SECRET_LENGTH = 32;

const CONFIG_GATE_MODES: readonly ConfigGateMode[] = ['off', 'warn', 'enforce'];

const warned = new Set<string>();

function warnOnce(prefix: string, name: Phase53SwitchName, raw: string, message: string): void {
  const key = `${name}\u0000${raw}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`${prefix} ${message}`, { name });
}

function read(source: MonitorEnvInput, name: Phase53SwitchName): string {
  const value = source[name];
  return typeof value === 'string' ? value.trim() : '';
}

function flag(source: MonitorEnvInput, name: Phase53SwitchName): boolean {
  return read(source, name).toLowerCase() === 'true';
}

function configGate(source: MonitorEnvInput): ConfigGateMode {
  const raw = read(source, 'RAG_CONFIG_GATE');
  if (raw === '') return 'off';
  const match = CONFIG_GATE_MODES.find((mode) => mode === raw.toLowerCase());
  if (match) return match;
  warnOnce('[Config Gate]', 'RAG_CONFIG_GATE', raw, 'Unsupported RAG_CONFIG_GATE value, using off');
  return 'off';
}

function webhookUrl(source: MonitorEnvInput): string | null {
  const raw = read(source, 'RAG_MONITOR_WEBHOOK_URL');
  if (raw === '') return null;
  let ok = false;
  try {
    const parsed = new URL(raw);
    ok = parsed.protocol === 'https:' && parsed.hostname !== '' && raw.toLowerCase().startsWith('https://');
  } catch {
    ok = false;
  }
  if (ok) return raw;
  warnOnce('[Monitor]', 'RAG_MONITOR_WEBHOOK_URL', raw, 'RAG_MONITOR_WEBHOOK_URL is not an https:// URL; the webhook stays off');
  return null;
}

function webhookSecret(source: MonitorEnvInput): string | null {
  const raw = read(source, 'RAG_MONITOR_WEBHOOK_SECRET');
  return raw.length >= MIN_WEBHOOK_SECRET_LENGTH ? raw : null;
}

/**
 * Phase 5.3 switch values, read at call time (D-10, D-21, D-39). Unset or invalid values give the off defaults;
 * a webhook secret under 32 characters counts as unset. Warnings name the variable, never its value (D-58).
 */
export function monitorSettings(source: MonitorEnvInput = env): MonitorSettings {
  return {
    monitor: flag(source, 'RAG_MONITOR'),
    webhookUrl: webhookUrl(source),
    webhookSecret: webhookSecret(source),
    configGate: configGate(source),
    configGateLive: flag(source, 'RAG_CONFIG_GATE_LIVE'),
    representativeSample: flag(source, 'RAG_REPRESENTATIVE_SAMPLE'),
  };
}
