import { env } from '@/lib/env';
import { loadIngestConfig, type IngestEnvInput } from './config';

export type ParseRouting = 'fixed' | 'tiered';
export type ParseEscalation = 'on' | 'off';
export type EmbedBatchMode = 'sync' | 'batch_api';

export interface QueueEnvInput {
  RAG_PARSE_ROUTING?: string;
  RAG_PARSER_ALLOW_CLOUD?: string;
  RAG_PARSE_PREMIUM_PAGE_BUDGET?: string;
  RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC?: string;
  RAG_PARSE_ESCALATION?: string;
  RAG_PARSE_VLM_DETECT?: string;
  RAG_PARSE_VLM_MODEL?: string;
  RAG_INGEST_ASYNC?: string;
  RAG_INGEST_WORKER_CONCURRENCY?: string;
  RAG_PARSE_PROGRESSIVE?: string;
  RAG_EMBED_BATCH_MODE?: string;
  NEXT_PUBLIC_RAG_INGEST_REALTIME?: string;
}

export type QueueEnvSnapshot = QueueEnvInput & IngestEnvInput;

export interface QueueConfig {
  parseRouting: ParseRouting;
  parserAllowCloud: boolean;
  premiumPageBudget: number;
  premiumMaxPagesPerDoc: number;
  parseEscalation: ParseEscalation;
  vlmDetect: boolean;
  vlmModel: string | null;
  ingestAsync: boolean;
  workerConcurrency: number;
  parseProgressive: boolean;
  embedBatchMode: EmbedBatchMode;
  ingestRealtime: boolean;
  warnings: string[];
}

const QUEUE_ENV_NAMES = [
  'RAG_PARSE_ROUTING',
  'RAG_PARSER_ALLOW_CLOUD',
  'RAG_PARSE_PREMIUM_PAGE_BUDGET',
  'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC',
  'RAG_PARSE_ESCALATION',
  'RAG_PARSE_VLM_DETECT',
  'RAG_PARSE_VLM_MODEL',
  'RAG_INGEST_ASYNC',
  'RAG_INGEST_WORKER_CONCURRENCY',
  'RAG_PARSE_PROGRESSIVE',
  'RAG_EMBED_BATCH_MODE',
  'NEXT_PUBLIC_RAG_INGEST_REALTIME',
  'RAG_INGEST_PIPELINE',
] as const;

const loggedProblems = new Set<string>();
const memo = new Map<string, QueueConfig>();

function problem(warnings: string[], key: string, message: string, data: Record<string, unknown>): void {
  warnings.push(message);
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Ingest] ${message}`, data);
}

function parseChoice<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const normalised = value.toLowerCase();
  const match = allowed.find((candidate) => candidate === normalised);
  if (match !== undefined) return match;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, using ${fallback}`, { name, value });
  return fallback;
}

function parseFlag(name: string, raw: string | undefined, warnings: string[]): boolean {
  const value = (raw ?? '').trim();
  if (value === '') return false;
  const normalised = value.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, expected true or false, using false`, { name, value });
  return false;
}

const CLOUD_ALLOWED_VALUES = new Set(['true', '1', 'yes', 'on']);
const CLOUD_REFUSED_VALUES = new Set(['false', '0', 'no', 'off', 'disabled']);

/** Unset or empty keeps the documented default (allowed); a recognised refusal or any unrecognised value refuses (D-08, D-18). */
function parseCloudAllowed(raw: string | undefined, warnings: string[]): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || CLOUD_ALLOWED_VALUES.has(value)) return true;
  if (CLOUD_REFUSED_VALUES.has(value)) return false;
  problem(warnings, `RAG_PARSER_ALLOW_CLOUD:${value}`, 'Unsupported RAG_PARSER_ALLOW_CLOUD value, refusing cloud parsing', { value });
  return false;
}

function parseNonNegativeInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  warnings: string[],
): number {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    problem(warnings, `${name}:${value}`, `Invalid ${name}, expected a non-negative integer, using ${fallback}`, { name, value });
    return fallback;
  }
  return n;
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  warnings: string[],
): number {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    problem(warnings, `${name}:${value}`, `Invalid ${name}, expected a positive integer, using ${fallback}`, { name, value });
    return fallback;
  }
  return n;
}

function parseVlmModel(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return value === '' ? null : value;
}

/** Pure function of an env snapshot; invalid switch combinations fall back to Phase 3 behaviour. */
export function loadQueueConfig(envSnapshot: QueueEnvSnapshot): QueueConfig {
  const snapshot = JSON.stringify(QUEUE_ENV_NAMES.map((name) => envSnapshot[name] ?? ''));
  const cached = memo.get(snapshot);
  if (cached) return cached;

  const warnings: string[] = [];
  const ingest = loadIngestConfig(envSnapshot);

  const requestedRouting = parseChoice('RAG_PARSE_ROUTING', envSnapshot.RAG_PARSE_ROUTING, ['fixed', 'tiered'], 'fixed', warnings);
  const requestedAsync = parseChoice('RAG_INGEST_ASYNC', envSnapshot.RAG_INGEST_ASYNC, ['off', 'on'], 'off', warnings) === 'on';

  let ingestAsync = requestedAsync;
  if (ingestAsync && ingest.pipeline !== 'unified') {
    problem(
      warnings,
      'async:legacy',
      'RAG_INGEST_ASYNC=on requires RAG_INGEST_PIPELINE=unified; using off',
      { pipeline: ingest.pipeline },
    );
    ingestAsync = false;
  }

  let parseRouting: ParseRouting = requestedRouting;
  if (parseRouting === 'tiered' && (ingest.pipeline !== 'unified' || !ingestAsync)) {
    problem(
      warnings,
      'routing:tiered-invalid',
      'RAG_PARSE_ROUTING=tiered requires RAG_INGEST_PIPELINE=unified and RAG_INGEST_ASYNC=on; using fixed',
      { pipeline: ingest.pipeline, ingestAsync },
    );
    parseRouting = 'fixed';
  }

  const rawVlmDetect = parseFlag('RAG_PARSE_VLM_DETECT', envSnapshot.RAG_PARSE_VLM_DETECT, warnings);
  const vlmDetect = parseRouting === 'tiered' && rawVlmDetect;

  const config: QueueConfig = {
    parseRouting,
    parserAllowCloud: parseCloudAllowed(envSnapshot.RAG_PARSER_ALLOW_CLOUD, warnings),
    premiumPageBudget: parseNonNegativeInt(
      'RAG_PARSE_PREMIUM_PAGE_BUDGET',
      envSnapshot.RAG_PARSE_PREMIUM_PAGE_BUDGET,
      0,
      warnings,
    ),
    premiumMaxPagesPerDoc: parsePositiveInt(
      'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC',
      envSnapshot.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC,
      200,
      warnings,
    ),
    parseEscalation: parseChoice('RAG_PARSE_ESCALATION', envSnapshot.RAG_PARSE_ESCALATION, ['on', 'off'], 'on', warnings),
    vlmDetect,
    vlmModel: parseVlmModel(envSnapshot.RAG_PARSE_VLM_MODEL),
    ingestAsync,
    workerConcurrency: parsePositiveInt(
      'RAG_INGEST_WORKER_CONCURRENCY',
      envSnapshot.RAG_INGEST_WORKER_CONCURRENCY,
      2,
      warnings,
    ),
    parseProgressive: parseFlag('RAG_PARSE_PROGRESSIVE', envSnapshot.RAG_PARSE_PROGRESSIVE, warnings),
    embedBatchMode: parseChoice('RAG_EMBED_BATCH_MODE', envSnapshot.RAG_EMBED_BATCH_MODE, ['sync', 'batch_api'], 'sync', warnings),
    ingestRealtime: parseFlag('NEXT_PUBLIC_RAG_INGEST_REALTIME', envSnapshot.NEXT_PUBLIC_RAG_INGEST_REALTIME, warnings),
    warnings,
  };

  memo.set(snapshot, config);
  return config;
}

export function queueConfigFromProcessEnv(): QueueConfig {
  return loadQueueConfig({
    RAG_INGEST_PIPELINE: env.RAG_INGEST_PIPELINE,
    RAG_PARSE_ROUTING: env.RAG_PARSE_ROUTING,
    RAG_PARSER_ALLOW_CLOUD: env.RAG_PARSER_ALLOW_CLOUD,
    RAG_PARSE_PREMIUM_PAGE_BUDGET: env.RAG_PARSE_PREMIUM_PAGE_BUDGET,
    RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC: env.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC,
    RAG_PARSE_ESCALATION: env.RAG_PARSE_ESCALATION,
    RAG_PARSE_VLM_DETECT: env.RAG_PARSE_VLM_DETECT,
    RAG_PARSE_VLM_MODEL: env.RAG_PARSE_VLM_MODEL,
    RAG_INGEST_ASYNC: env.RAG_INGEST_ASYNC,
    RAG_INGEST_WORKER_CONCURRENCY: env.RAG_INGEST_WORKER_CONCURRENCY,
    RAG_PARSE_PROGRESSIVE: env.RAG_PARSE_PROGRESSIVE,
    RAG_EMBED_BATCH_MODE: env.RAG_EMBED_BATCH_MODE,
    NEXT_PUBLIC_RAG_INGEST_REALTIME: env.NEXT_PUBLIC_RAG_INGEST_REALTIME,
  });
}

export function resetQueueConfigForTests(): void {
  loggedProblems.clear();
  memo.clear();
}