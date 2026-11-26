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

export type MonitorEnvInput = Partial<Record<keyof typeof PHASE53_SWITCH_DEFAULTS, string | undefined>>;

export const PHASE53_SWITCH_DEFAULTS = {
  RAG_MONITOR: 'false',
  RAG_MONITOR_WEBHOOK_URL: '',
  RAG_MONITOR_WEBHOOK_SECRET: '',
  RAG_CONFIG_GATE: 'off',
  RAG_CONFIG_GATE_LIVE: 'false',
  RAG_REPRESENTATIVE_SAMPLE: 'false',
} as const;

export function monitorSettings(_source: MonitorEnvInput = env): MonitorSettings {
  return { monitor: false, webhookUrl: null, webhookSecret: null, configGate: 'off', configGateLive: false, representativeSample: false };
}
