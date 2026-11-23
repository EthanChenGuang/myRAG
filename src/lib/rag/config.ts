import type { Profile } from './types';

export const CORE_STAGES = ['embed', 'search'] as const;
export const OPTIONAL_STAGES = [
  'refs',
  'analyze',
  'legacy_rank',
  'post_filter',
  'assemble',
  'voice_keyword_fallback',
  'local_rerank',
] as const;

export type CoreStageName = (typeof CORE_STAGES)[number];
export type OptionalStageName = (typeof OPTIONAL_STAGES)[number];
export type StageName = CoreStageName | OptionalStageName;

export type StageTimeouts = Partial<Record<StageName, number>>;

const STANDARD_TIMEOUTS: StageTimeouts = {
  refs: 5000,
  analyze: 1000,
  embed: 15000,
  search: 15000,
  legacy_rank: 2000,
  post_filter: 10000,
  assemble: 10000,
};

export const PROFILE_STAGE_DEFAULTS: Record<Profile, StageTimeouts> = {
  chat: { ...STANDARD_TIMEOUTS },
  embed: { ...STANDARD_TIMEOUTS },
  eval: { ...STANDARD_TIMEOUTS },
  media: { ...STANDARD_TIMEOUTS },
  voice: {
    refs: 5000,
    analyze: 500,
    embed: 5000,
    search: 5000,
    voice_keyword_fallback: 3000,
    local_rerank: 1000,
    post_filter: 3000,
    assemble: 3000,
  },
};

export const FALLBACK_STAGE_TIMEOUT_MS = 10000;

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60000;
const PROFILES = Object.keys(PROFILE_STAGE_DEFAULTS) as Profile[];

export interface RagEnvInput {
  RAG_PIPELINE?: string;
  RAG_DISABLED_STAGES?: string;
  RAG_STAGE_TIMEOUTS?: string;
}

export interface RagConfig {
  pipeline: 'legacy';
  disabledStages: ReadonlySet<StageName>;
  timeouts: Record<Profile, StageTimeouts>;
  warnings: string[];
}

const loggedProblems = new Set<string>();
const memo = new Map<string, RagConfig>();

function problem(warnings: string[], key: string, message: string, data: Record<string, unknown>): void {
  warnings.push(`${message} (${Object.values(data).join(', ')})`);
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[RAG Config] ${message}`, data);
}

function isStageName(value: string): value is StageName {
  return (CORE_STAGES as readonly string[]).includes(value) || (OPTIONAL_STAGES as readonly string[]).includes(value);
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parsePipeline(raw: string | undefined, warnings: string[]): 'legacy' {
  const value = (raw ?? '').trim();
  if (value !== '' && value !== 'legacy') {
    problem(warnings, `pipeline:${value}`, 'Unsupported RAG_PIPELINE value, running legacy', { value });
  }
  return 'legacy';
}

function parseDisabled(raw: string | undefined, warnings: string[]): Set<StageName> {
  const disabled = new Set<StageName>();
  for (const name of parseList(raw)) {
    if ((CORE_STAGES as readonly string[]).includes(name)) {
      problem(warnings, `core:${name}`, 'Core stage cannot be disabled, entry ignored', { stage: name });
    } else if (!isStageName(name)) {
      problem(warnings, `unknown:${name}`, 'Unknown stage in RAG_DISABLED_STAGES, entry ignored', { stage: name });
    } else {
      disabled.add(name);
    }
  }
  return disabled;
}

function parseTimeouts(raw: string | undefined, warnings: string[]): StageTimeouts {
  const overrides: StageTimeouts = {};
  for (const entry of parseList(raw)) {
    const separator = entry.indexOf('=');
    const name = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    const text = separator === -1 ? '' : entry.slice(separator + 1).trim();
    if (!isStageName(name)) {
      problem(warnings, `timeout-unknown:${name}`, 'Unknown stage in RAG_STAGE_TIMEOUTS, entry ignored', { stage: name });
      continue;
    }
    const ms = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
      problem(
        warnings,
        `timeout-value:${name}=${text}`,
        `Invalid RAG_STAGE_TIMEOUTS value, expected an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}, entry ignored`,
        { stage: name },
      );
      continue;
    }
    overrides[name] = ms;
  }
  return overrides;
}

export function loadRagConfig(env: RagEnvInput): RagConfig {
  const snapshot = JSON.stringify([env.RAG_PIPELINE ?? '', env.RAG_DISABLED_STAGES ?? '', env.RAG_STAGE_TIMEOUTS ?? '']);
  const cached = memo.get(snapshot);
  if (cached) return cached;

  const warnings: string[] = [];
  const pipeline = parsePipeline(env.RAG_PIPELINE, warnings);
  const disabledStages = parseDisabled(env.RAG_DISABLED_STAGES, warnings);
  const overrides = parseTimeouts(env.RAG_STAGE_TIMEOUTS, warnings);

  const timeouts = {} as Record<Profile, StageTimeouts>;
  for (const profile of PROFILES) {
    timeouts[profile] = { ...PROFILE_STAGE_DEFAULTS[profile], ...overrides };
  }

  const config: RagConfig = { pipeline, disabledStages, timeouts, warnings };
  memo.set(snapshot, config);
  return config;
}

export function resetRagConfigForTests(): void {
  loggedProblems.clear();
  memo.clear();
}
