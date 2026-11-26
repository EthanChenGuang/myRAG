import { z } from 'zod/v3';
import {
  AnswerRecordSchema,
  CitationRecordSchema,
  type AnswerRecord,
  type CitationRecord,
  type RefusalFeedbackRequest,
} from '@/lib/rag-eval/contracts.generated';

export type AnswerGroundedness = AnswerRecord['groundedness'];
export type AnswerFeedback = NonNullable<AnswerRecord['feedback']>;
export type AnswerCitationStrategy = CitationRecord['strategy'];

export type AnswerMessageMetadata = {
  answerId?: string;
  citations?: CitationRecord[];
  citationStrategy?: AnswerCitationStrategy;
  invalidCitations?: number;
  groundedness?: AnswerGroundedness;
  feedback?: AnswerFeedback;
};

export type RefusalVote = RefusalFeedbackRequest['vote'];
export type RefusalReason = NonNullable<RefusalFeedbackRequest['reasons']>[number];
export type RefusalFeedbackValue = { vote: RefusalVote; reasons: RefusalReason[]; at: string };
export type RefusalMessageMetadata = { refusal?: true; refusalFeedback?: RefusalFeedbackValue };

export type StreamAnswerMetadata = {
  ragTraceId?: string;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validCitations(value: unknown): CitationRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: CitationRecord[] = [];
  for (const entry of value) {
    const parsed = CitationRecordSchema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

function pickCitationFields(source: Record<string, unknown>): Omit<StreamAnswerMetadata, 'ragTraceId'> {
  const picked: Omit<StreamAnswerMetadata, 'ragTraceId'> = {};
  const answerId = AnswerIdSchema.safeParse(source.answerId);
  if (answerId.success) picked.answerId = answerId.data;
  const citations = validCitations(source.citations);
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
  const picked: AnswerMessageMetadata = pickCitationFields(source);
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
  return { ...next, ...pickCitationFields(source) };
}

/** The refusal flag and the stored refusal vote of message metadata (D-08); anything else is dropped. */
export function pickRefusalMetadata(_metadata: unknown): RefusalMessageMetadata {
  return {};
}

/** Writes a saved refusal vote into the matching message's metadata; the same array when nothing changes. */
export function withRefusalFeedback<T extends { id: string; metadata?: Record<string, unknown> }>(messages: T[], _messageId: string, _value: RefusalFeedbackValue): T[] {
  return messages;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sets groundedness and feedback from the record on the matching message; the same array when nothing changes. */
export function mergeAnswerRecord<T extends { metadata?: Record<string, unknown> }>(messages: T[], record: AnswerRecord): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const metadata = message.metadata;
    if (!metadata || metadata.answerId !== record.answerId) return message;
    const feedback = record.feedback ?? undefined;
    const sameGroundedness = sameJson(metadata.groundedness, record.groundedness);
    const sameFeedback = feedback ? sameJson(metadata.feedback, feedback) : !('feedback' in metadata);
    if (sameGroundedness && sameFeedback) return message;
    changed = true;
    const updated: Record<string, unknown> = { ...metadata, groundedness: record.groundedness };
    if (feedback) updated.feedback = feedback;
    else delete updated.feedback;
    return { ...message, metadata: updated };
  });
  return changed ? next : messages;
}
