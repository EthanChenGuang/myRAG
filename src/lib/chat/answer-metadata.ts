import { z } from 'zod/v3';
import {
  AnswerNoticeSchema,
  AnswerRecordSchema,
  AnswerSentenceSchema,
  CitationRecordSchema,
  type AnswerChecks,
  type AnswerNotice,
  type AnswerRecord,
  type AnswerSentence,
  type CitationRecord,
  RagTurnMetadataSchema,
  RefusalFeedbackRequestSchema,
  type RagTurnMetadata,
  type RefusalFeedbackRequest,
} from '@/lib/rag-eval/contracts.generated';

export type { RagTurnMetadata };

export type AnswerGroundedness = AnswerRecord['groundedness'];
export type AnswerFeedback = NonNullable<AnswerRecord['feedback']>;
export type AnswerCitationStrategy = CitationRecord['strategy'];

export type AnswerTextsSource = NonNullable<AnswerRecord['textsSource']>;

/** Phase 5.2 fields of the finish metadata (D-11, D-16, D-33); each is present only while a 5.2 switch produced it. */
export type AnswerTurnMetadata = {
  sentences?: AnswerSentence[];
  notices?: AnswerNotice[];
  answerLanguage?: string;
  truncated?: boolean;
  refusalOrigin?: string;
};

export type AnswerMessageMetadata = AnswerTurnMetadata & {
  answerId?: string;
  citations?: CitationRecord[];
  citationStrategy?: AnswerCitationStrategy;
  invalidCitations?: number;
  groundedness?: AnswerGroundedness;
  feedback?: AnswerFeedback;
  /** From the polled record (D-23). */
  checks?: AnswerChecks;
  textsSource?: AnswerTextsSource;
};

export type RefusalVote = RefusalFeedbackRequest['vote'];
export type RefusalReason = NonNullable<RefusalFeedbackRequest['reasons']>[number];
export type RefusalFeedbackValue = { vote: RefusalVote; reasons: RefusalReason[]; at: string };
export type RefusalMessageMetadata = { refusal?: true; refusalFeedback?: RefusalFeedbackValue };

export type StreamAnswerMetadata = AnswerTurnMetadata & {
  ragTraceId?: string;
  /** Phase 6.2 D-22: the turn's standalone query; the client stores it on that turn's user message. */
  rag?: RagTurnMetadata;
  refusal?: true;
  answerId?: string;
  citations?: CitationRecord[];
  citationStrategy?: AnswerCitationStrategy;
  invalidCitations?: number;
};

const AnswerIdSchema = z.string().uuid();
const StrategySchema = CitationRecordSchema.shape.strategy;
const InvalidCountSchema = z.number().int().gte(0);
const GroundednessSchema = AnswerRecordSchema.shape.groundedness;
const FeedbackSchema = AnswerRecordSchema.shape.feedback.removeDefault().options[0];
const ChecksSchema = AnswerRecordSchema.shape.checks.unwrap();
const TextsSourceSchema = AnswerRecordSchema.shape.textsSource.unwrap();
const LanguageSchema = z.string().min(1).max(35);
const RefusalOriginSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** The `{vote, reasons, at}` the refusal feedback route returns and the message metadata stores. */
export const RefusalFeedbackValueSchema = z.object({
  vote: RefusalFeedbackRequestSchema.shape.vote,
  reasons: RefusalFeedbackRequestSchema.shape.reasons.unwrap(),
  at: z.string().min(1).max(64),
});

/** D-22: a `rag` value that passes the generated strict schema (1000-character cap), else undefined. */
export function pickRagTurnMetadata(value: unknown): RagTurnMetadata | undefined {
  const parsed = RagTurnMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validEntries<T>(value: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: T[] = [];
  for (const entry of value) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

function pickTurnFields(source: Record<string, unknown>): AnswerTurnMetadata {
  const picked: AnswerTurnMetadata = {};
  const sentences = validEntries(source.sentences, AnswerSentenceSchema);
  if (sentences) picked.sentences = sentences;
  const notices = validEntries(source.notices, AnswerNoticeSchema);
  if (notices) picked.notices = notices;
  const language = LanguageSchema.safeParse(source.answerLanguage);
  if (language.success) picked.answerLanguage = language.data;
  if (typeof source.truncated === 'boolean') picked.truncated = source.truncated;
  const origin = RefusalOriginSchema.safeParse(source.refusalOrigin);
  if (origin.success) picked.refusalOrigin = origin.data;
  return picked;
}

function pickCitationFields(source: Record<string, unknown>): Omit<StreamAnswerMetadata, 'ragTraceId'> {
  const picked: Omit<StreamAnswerMetadata, 'ragTraceId'> = {};
  const answerId = AnswerIdSchema.safeParse(source.answerId);
  if (answerId.success) picked.answerId = answerId.data;
  const citations = validEntries(source.citations, CitationRecordSchema);
  if (citations) picked.citations = citations;
  const strategy = StrategySchema.safeParse(source.citationStrategy);
  if (strategy.success) picked.citationStrategy = strategy.data;
  const invalid = InvalidCountSchema.safeParse(source.invalidCitations);
  if (invalid.success) picked.invalidCitations = invalid.data;
  return picked;
}

/** The answer fields of message metadata that pass the generated schemas; anything else is dropped. */
export function pickAnswerMetadata(metadata: unknown): AnswerMessageMetadata {
  const source = asRecord(metadata);
  if (!source) return {};
  const picked: AnswerMessageMetadata = { ...pickCitationFields(source), ...pickTurnFields(source) };
  const checks = ChecksSchema.safeParse(source.checks);
  if (checks.success) picked.checks = checks.data;
  const textsSource = TextsSourceSchema.safeParse(source.textsSource);
  if (textsSource.success) picked.textsSource = textsSource.data;
  const groundedness = GroundednessSchema.safeParse(source.groundedness);
  if (groundedness.success) picked.groundedness = groundedness.data;
  const feedback = FeedbackSchema.safeParse(source.feedback);
  if (feedback.success) picked.feedback = feedback.data;
  return picked;
}

/** The answer fields of a start or finish messageMetadata, merged over what earlier parts carried. */
export function extractStreamAnswerMetadata(metadata: unknown, previous: StreamAnswerMetadata = {}): StreamAnswerMetadata {
  const source = asRecord(metadata);
  if (!source) return previous;
  const next: StreamAnswerMetadata = { ...previous };
  if (typeof source.ragTraceId === 'string' && source.ragTraceId.length > 0) next.ragTraceId = source.ragTraceId;
  if (source.refusal === true) next.refusal = true;
  const rag = pickRagTurnMetadata(source.rag);
  if (rag) next.rag = rag;
  return { ...next, ...pickCitationFields(source), ...pickTurnFields(source) };
}

function noticeKey(notice: AnswerNotice): string {
  return `${notice.kind}\u0000${notice.language}\u0000${notice.text}`;
}

/** The notices of any assistant message (independent of citation awareness), exact duplicates removed, unknown kinds kept. */
export function noticesOf(metadata: unknown): AnswerNotice[] {
  const notices = validEntries(asRecord(metadata)?.notices, AnswerNoticeSchema) ?? [];
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = noticeKey(notice);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The refusal flag and the stored refusal vote of message metadata (D-08); anything else is dropped. */
export function pickRefusalMetadata(metadata: unknown): RefusalMessageMetadata {
  const source = asRecord(metadata);
  if (!source) return {};
  const picked: RefusalMessageMetadata = {};
  if (source.refusal === true) picked.refusal = true;
  const feedback = RefusalFeedbackValueSchema.safeParse(source.refusalFeedback);
  if (feedback.success) picked.refusalFeedback = feedback.data;
  return picked;
}

/** Writes a saved refusal vote into the matching message's metadata; the same array when nothing changes. */
export function withRefusalFeedback<T extends { id: string; metadata?: Record<string, unknown> }>(messages: T[], messageId: string, value: RefusalFeedbackValue): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.id !== messageId || sameJson(message.metadata?.refusalFeedback, value)) return message;
    changed = true;
    return { ...message, metadata: { ...(message.metadata ?? {}), refusalFeedback: value } };
  });
  return changed ? next : messages;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** D-23: only a record read with the Phase 5.2 columns (checks present) brings checks, textsSource and the question's language. */
function checkedFields(record: AnswerRecord): Record<string, unknown> {
  if (record.checks === undefined) return {};
  const fields: Record<string, unknown> = { checks: record.checks };
  if (record.textsSource !== undefined) fields.textsSource = record.textsSource;
  if (typeof record.answerLanguage === 'string' && record.answerLanguage.length > 0) fields.answerLanguage = record.answerLanguage;
  return fields;
}

/** Sets groundedness and feedback (and the Phase 5.2 checks) from the record on the matching message; the same array when nothing changes. */
export function mergeAnswerRecord<T extends { metadata?: Record<string, unknown> }>(messages: T[], record: AnswerRecord): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const metadata = message.metadata;
    if (!metadata || metadata.answerId !== record.answerId) return message;
    const feedback = record.feedback ?? undefined;
    const sameGroundedness = sameJson(metadata.groundedness, record.groundedness);
    const sameFeedback = feedback ? sameJson(metadata.feedback, feedback) : !('feedback' in metadata);
    const checked = checkedFields(record);
    const sameChecked = Object.entries(checked).every(([key, value]) => sameJson(metadata[key], value));
    if (sameGroundedness && sameFeedback && sameChecked) return message;
    changed = true;
    const updated: Record<string, unknown> = { ...metadata, groundedness: record.groundedness, ...checked };
    if (feedback) updated.feedback = feedback;
    else delete updated.feedback;
    return { ...message, metadata: updated };
  });
  return changed ? next : messages;
}
