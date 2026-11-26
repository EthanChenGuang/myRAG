import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import type { AnswerNotice, AnswerSentence } from '@/lib/rag-eval/contracts.generated';
import type { AnswerConfig } from './answer-config';
import type { AnswerChannel } from './answer-turn';
import { emitNotice, noticeTransform, renderNoticeAsText } from './notices';
import { buildSentenceRecords } from './sentences-record';

type Part = TextStreamPart<ToolSet>;

export interface AnswerCollectorTurn {
  readonly config: Pick<AnswerConfig, 'anyNonDefault' | 'citationPerSentence' | 'claimCheck'>;
  readonly answerLanguage: string | null;
}

export interface AnswerCollectorInput {
  turn: AnswerCollectorTurn;
  channel: AnswerChannel;
  /** The validated aliases of this request's citation session; read once at stream end. */
  aliases?: () => ReadonlySet<string>;
}

export interface AnswerTextPart {
  /** Index among the message's text parts (UI-SPEC 8.1). */
  index: number;
  text: string;
}

export interface AnswerCollector {
  /** The notice transform and the collector observer, in that order; the last entries of the chain. */
  transforms(): Array<StreamTextTransform<ToolSet>>;
  /** For other transforms; an exact duplicate is kept once. */
  addNotice(notice: AnswerNotice): void;
  /** Called by the sentinel transform's onRefusal. */
  markRefused(): void;
  countStripped(count: number): void;
  /** The text the user saw: every text delta after every rewriting transform, as onFinish receives it. */
  finalText(): string;
  lastTextPart(): AnswerTextPart | null;
  refusedByModel(): boolean;
  finishReason(): string | null;
  truncated(): boolean;
  strippedSentinels(): number;
  notices(): AnswerNotice[];
  /** D-20, D-22: records of the last text part, computed once at stream end; null when not computed for this turn. */
  sentences(): AnswerSentence[] | null;
  /** D-20, UI-SPEC 8.1: empty with every Phase 5.2 switch off. */
  finishMetadata(): Record<string, unknown>;
}

/** True for channels that read plain text only: notices are appended to the answer (D-11). */
export function isPlainTextChannel(channel: AnswerChannel): boolean {
  return channel !== 'web';
}

function noticeKey(notice: AnswerNotice): string {
  return `${notice.kind}\u0000${notice.language}\u0000${notice.text}`;
}

export interface NoticeState {
  add(notice: AnswerNotice): void;
  markRefused(): void;
  /** D-33 at the final finish-step: decides truncation and returns the plain-text notices not rendered yet, or null. */
  atFinal(finishReason: string): string | null;
  notices(): AnswerNotice[];
  truncated(): boolean;
  refused(): boolean;
}

/** The end-of-answer rule shared by the stream collector and the whole-text twin, so both give the same text. */
export function createNoticeState(options: { language: string | null; channel: AnswerChannel }): NoticeState {
  const plain = isPlainTextChannel(options.channel);
  const list: AnswerNotice[] = [];
  const keys = new Set<string>();
  let rendered = 0;
  let truncated = false;
  let refused = false;
  const add = (notice: AnswerNotice) => {
    const key = noticeKey(notice);
    if (keys.has(key)) return;
    keys.add(key);
    list.push({ kind: notice.kind, text: notice.text, language: notice.language });
  };
  return {
    add,
    markRefused() {
      refused = true;
    },
    atFinal(finishReason) {
      // D-31: a refusal is server text and is never reported as cut
      if (finishReason === 'length' && !refused) {
        truncated = true;
        if (options.language) add(emitNotice('answer_truncated', { language: options.language }));
      }
      if (!plain) return null;
      const pending = list.slice(rendered);
      rendered = list.length;
      return pending.length > 0 ? pending.map(renderNoticeAsText).join('') : null;
    },
    notices: () => list.map((notice) => ({ ...notice })),
    truncated: () => truncated,
    refused: () => refused,
  };
}

export function createAnswerCollector(input: AnswerCollectorInput): AnswerCollector {
  const { turn, channel } = input;
  const language = turn.answerLanguage;
  const state = createNoticeState({ language, channel });
  const parts: Array<{ id: string; text: string }> = [];
  const byId = new Map<string, { id: string; text: string }>();
  let stepReason: string | null = null;
  let finalReason: string | null = null;
  let finished = false;
  let stripped = 0;
  let records: AnswerSentence[] | null | undefined;
  let built: Array<StreamTextTransform<ToolSet>> | null = null;

  const partFor = (id: string) => {
    let part = byId.get(id);
    if (!part) {
      part = { id, text: '' };
      byId.set(id, part);
      parts.push(part);
    }
    return part;
  };

  const lastTextPart = (): AnswerTextPart | null =>
    parts.length === 0 ? null : { index: parts.length - 1, text: parts[parts.length - 1]!.text };

  const recordsEnabled = () => turn.config.citationPerSentence || turn.config.claimCheck;

  const computeSentences = (): AnswerSentence[] | null => {
    if (!recordsEnabled() || !language || state.refused()) return null;
    const last = lastTextPart();
    if (!last) return [];
    const result = buildSentenceRecords({
      text: last.text,
      part: last.index,
      language,
      aliases: input.aliases?.() ?? new Set<string>(),
      truncated: state.truncated(),
    });
    const factual = result.filter((record) => record.factual);
    const cited = factual.filter((record) => record.cited).length;
    console.log('[Citations] Sentence records:', { factual: factual.length, cited, uncited: factual.length - cited });
    return result;
  };

  const sentences = (): AnswerSentence[] | null => {
    if (records !== undefined) return records;
    const result = computeSentences();
    if (finished) records = result;
    return result;
  };

  const observer: StreamTextTransform<ToolSet> = () =>
    new TransformStream<Part, Part>({
      transform(part, controller) {
        switch (part.type) {
          case 'text-start':
            partFor(part.id);
            break;
          case 'text-delta':
            partFor(part.id).text += part.text;
            break;
          case 'finish-step':
            stepReason = part.finishReason;
            break;
          case 'finish':
            finalReason = part.finishReason ?? stepReason;
            finished = true;
            break;
          default:
            break;
        }
        controller.enqueue(part);
      },
      flush() {
        finished = true;
      },
    });

  return {
    transforms() {
      if (!built) built = [noticeTransform((finishReason) => state.atFinal(finishReason)), observer];
      return built;
    },
    addNotice: (notice) => state.add(notice),
    markRefused: () => state.markRefused(),
    countStripped(count) {
      stripped += count;
    },
    finalText: () => parts.map((part) => part.text).join(''),
    lastTextPart,
    refusedByModel: () => state.refused(),
    finishReason: () => finalReason ?? stepReason,
    truncated: () => state.truncated(),
    strippedSentinels: () => stripped,
    notices: () => state.notices(),
    sentences,
    finishMetadata() {
      if (!turn.config.anyNonDefault) return {};
      const metadata: Record<string, unknown> = {};
      if (turn.config.citationPerSentence) {
        const computed = sentences();
        if (computed) metadata.sentences = computed;
      }
      const notices = state.notices();
      if (!isPlainTextChannel(channel) && notices.length > 0) metadata.notices = notices;
      if (language) metadata.answerLanguage = language;
      metadata.truncated = state.truncated();
      if (state.refused()) {
        metadata.refusal = true;
        metadata.refusalOrigin = 'model_relevance';
      }
      return metadata;
    },
  };
}
