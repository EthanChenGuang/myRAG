import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v3';

export type RetrievalLogLevel = 'off' | 'ids' | 'masked_query';

export type FeedbackLoopConfigWarningCode =
  | 'invalid_retrieval_log'
  | 'invalid_retention_days'
  | 'invalid_boolean'
  | 'embed_feedback_secret_too_short';

/** The message names the variable only; a configured value is never repeated in it. */
export interface FeedbackLoopConfigWarning {
  readonly code: FeedbackLoopConfigWarningCode;
  readonly message: string;
}

export interface FeedbackLoopConfig {
  readonly retrievalLog: RetrievalLogLevel;
  readonly retentionDays: number;
  readonly refusalFeedback: boolean;
  /** The raw switch; the embed control runs only when embedFeedbackEnabled is true. */
  readonly embedFeedback: boolean;
  readonly embedFeedbackEnabled: boolean;
  /** Non-enumerable: set only while embedFeedbackEnabled, and left out of JSON and object spreads. */
  readonly embedFeedbackSecret: string | null;
  readonly sourceOpenSignal: boolean;
  readonly domainExpertReview: boolean;
  readonly anyEnabled: boolean;
  readonly warnings: readonly FeedbackLoopConfigWarning[];
}

export type FeedbackLoopEnvSource = Record<string, string | undefined>;

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_EMBED_FEEDBACK_SECRET_LENGTH = 32;
const LOG_LEVELS: readonly RetrievalLogLevel[] = ['off', 'ids', 'masked_query'];

const warnedOnce = new Set<string>();

function warnOnce(message: string): void {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  console.warn(message);
}

function parseBoolean(name: string, raw: string | undefined, warnings: FeedbackLoopConfigWarning[]): boolean {
  const text = raw?.trim() ?? '';
  if (text === 'true') return true;
  if (text !== '' && text !== 'false') {
    warnings.push({ code: 'invalid_boolean', message: `${name} is not true or false; using false` });
  }
  return false;
}

function parseLogLevel(raw: string | undefined, warnings: FeedbackLoopConfigWarning[]): RetrievalLogLevel {
  const text = raw?.trim() ?? '';
  if (text === '') return 'off';
  const level = LOG_LEVELS.find((candidate) => candidate === text);
  if (level) return level;
  warnings.push({ code: 'invalid_retrieval_log', message: 'RAG_RETRIEVAL_LOG is not off, ids or masked_query; using off' });
  return 'off';
}

function parseRetentionDays(raw: string | undefined, warnings: FeedbackLoopConfigWarning[]): number {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_RETENTION_DAYS;
  const days = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isInteger(days) && days >= 1 && days <= 365) return days;
  warnings.push({
    code: 'invalid_retention_days',
    message: `RAG_RETRIEVAL_LOG_RETENTION_DAYS is not a whole number from 1 to 365; using ${DEFAULT_RETENTION_DAYS}`,
  });
  return DEFAULT_RETENTION_DAYS;
}

/**
 * Read at call time and never cached; every invalid value fails closed to its off default and is reported once as a
 * [Feedback Loop] warning. The embed secret is exposed only on its own non-enumerable field and only when it is usable.
 */
export function readFeedbackLoopConfig(
  source: FeedbackLoopEnvSource = process.env,
  log: (message: string) => void = warnOnce,
): FeedbackLoopConfig {
  const warnings: FeedbackLoopConfigWarning[] = [];
  const retrievalLog = parseLogLevel(source.RAG_RETRIEVAL_LOG, warnings);
  const retentionDays = parseRetentionDays(source.RAG_RETRIEVAL_LOG_RETENTION_DAYS, warnings);
  const refusalFeedback = parseBoolean('RAG_REFUSAL_FEEDBACK', source.RAG_REFUSAL_FEEDBACK, warnings);
  const embedFeedback = parseBoolean('RAG_EMBED_FEEDBACK', source.RAG_EMBED_FEEDBACK, warnings);
  const sourceOpenSignal = parseBoolean('RAG_SOURCE_OPEN_SIGNAL', source.RAG_SOURCE_OPEN_SIGNAL, warnings);
  const domainExpertReview = parseBoolean('RAG_DOMAIN_EXPERT_REVIEW', source.RAG_DOMAIN_EXPERT_REVIEW, warnings);

  const secret = source.RAG_EMBED_FEEDBACK_SECRET?.trim() ?? '';
  const secretUsable = secret.length >= MIN_EMBED_FEEDBACK_SECRET_LENGTH;
  if (embedFeedback && !secretUsable) {
    warnings.push({
      code: 'embed_feedback_secret_too_short',
      message: `RAG_EMBED_FEEDBACK is on but RAG_EMBED_FEEDBACK_SECRET has fewer than ${MIN_EMBED_FEEDBACK_SECRET_LENGTH} characters; the embed rating stays off`,
    });
  }
  const embedFeedbackEnabled = embedFeedback && secretUsable;

  for (const warning of warnings) log(`[Feedback Loop] ${warning.message}`);

  const config = {
    retrievalLog,
    retentionDays,
    refusalFeedback,
    embedFeedback,
    embedFeedbackEnabled,
    sourceOpenSignal,
    domainExpertReview,
    anyEnabled: retrievalLog !== 'off' || refusalFeedback || embedFeedback || sourceOpenSignal || domainExpertReview,
    warnings: Object.freeze(warnings.map((warning) => Object.freeze({ ...warning }))),
  };
  Object.defineProperty(config, 'embedFeedbackSecret', {
    value: embedFeedbackEnabled ? secret : null,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(config) as FeedbackLoopConfig;
}

const ScorerThresholdsSchema = z.object({ similarity: z.number().gte(0).lte(1), rerank: z.number().gte(0).lte(1) }).strict();

/** Mirrors the FeedbackMiningConfig contract of plan 05.1.1-01; replace with the generated schema once it exists. */
export const FeedbackMiningConfigSchema = z
  .object({
    schema_version: z.literal(1),
    per_tenant_limit: z.number().int().gte(1).lte(500).default(50),
    window_days: z.number().int().gte(1).lte(31).default(7),
    low_score_ceiling: ScorerThresholdsSchema,
    refused_high_score_floor: ScorerThresholdsSchema,
    open_item_ttl_days: z.number().int().gte(1).default(90),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type FeedbackMiningConfig = z.infer<typeof FeedbackMiningConfigSchema>;

export class FeedbackMiningConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'FeedbackMiningConfigError';
  }
}

export function feedbackMiningConfigPath(): string {
  return path.join(process.cwd(), 'config', 'rag', 'feedback-mining.json');
}

/** Validates config/rag/feedback-mining.json (or the given file) and returns it with the sha256 of its bytes for reports. */
export function loadFeedbackMiningConfig(filePath: string = feedbackMiningConfigPath()): {
  config: FeedbackMiningConfig;
  sha256: string;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    throw new FeedbackMiningConfigError(filePath, `[Feedback Loop] cannot read mining config ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new FeedbackMiningConfigError(filePath, `[Feedback Loop] mining config ${filePath} is not valid JSON`);
  }
  const parsed = FeedbackMiningConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new FeedbackMiningConfigError(filePath, `[Feedback Loop] mining config ${filePath} is invalid at: ${fields}`);
  }
  return { config: parsed.data, sha256: createHash('sha256').update(bytes).digest('hex') };
}
