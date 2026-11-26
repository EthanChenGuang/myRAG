import { detectLanguage } from '../lang/detect';

export interface AnswerLanguageOptions {
  /** The asker's language (the query plan's language). */
  answerLanguage?: string | null;
  /** Languages of the documents in the assembled context. */
  contextLanguages?: readonly string[];
}

interface LanguageSource {
  chunk_id?: string;
  content: string;
  language?: string | null;
}

const INSTRUCTIONS: Readonly<Record<string, string>> = {
  en: 'The question is in English, but some documents in the context are in another language. Answer in English, and keep any text you quote from those documents in its original language.',
  zh: '问题使用中文，但上下文中的部分文档使用其他语言。请用中文回答，引用这些文档的原文时保持其原有语言。',
  it: "La domanda è in italiano, ma alcuni documenti nel contesto sono in un'altra lingua. Rispondi in italiano e mantieni nella lingua originale il testo citato da quei documenti.",
};

function normalize(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const primary = code.trim().toLowerCase().split(/[-_]/)[0];
  return primary ? primary : null;
}

/**
 * Distinct languages of the kept chunks: a chunk's own `language`, else the same chunk's language among
 * `candidates`, else the detector on its text. Chunks without evidence are skipped.
 */
export function contextLanguages(kept: readonly LanguageSource[], candidates: readonly LanguageSource[] = []): string[] {
  const byChunk = new Map<string, string>();
  for (const candidate of candidates) {
    const language = normalize(candidate.language);
    if (candidate.chunk_id && language && !byChunk.has(candidate.chunk_id)) byChunk.set(candidate.chunk_id, language);
  }
  const languages: string[] = [];
  for (const item of kept) {
    const language =
      normalize(item.language) ?? (item.chunk_id ? byChunk.get(item.chunk_id) : undefined) ?? normalize(detectLanguage(item.content));
    if (language && !languages.includes(language)) languages.push(language);
  }
  return languages;
}

/** The localized line, or null when the languages match, either side is unknown, or the asker's language has no line. */
export function answerLanguageInstruction(options?: AnswerLanguageOptions | null): string | null {
  const asker = normalize(options?.answerLanguage);
  if (!asker) return null;
  const line = INSTRUCTIONS[asker];
  if (!line) return null;
  const languages = (options?.contextLanguages ?? []).map(normalize).filter((code): code is string => code !== null);
  return languages.some((code) => code !== asker) ? line : null;
}

/** Appends the answer-language line after the finished prompt; returns the prompt unchanged when there is none. */
export function appendAnswerLanguage(prompt: string, options?: AnswerLanguageOptions | null): string {
  const line = answerLanguageInstruction(options);
  return line ? `${prompt}\n\n${line}` : prompt;
}

/** The options for a retrieval result; undefined unless the query layer produced a plan. */
export function answerLanguageOptions(result: {
  queryPlan?: { language?: string | null } | null;
  kept?: readonly LanguageSource[];
  candidates?: readonly LanguageSource[];
} | null | undefined): AnswerLanguageOptions | undefined {
  if (!result?.queryPlan) return undefined;
  return {
    answerLanguage: result.queryPlan.language ?? null,
    contextLanguages: contextLanguages(result.kept ?? [], result.candidates ?? []),
  };
}
