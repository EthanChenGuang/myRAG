import { HypotheticalDocumentSchema } from '@/lib/rag-eval/contracts.generated';
import type { Lang } from '../rewrite-gate';
import { checkVariant, DEFAULT_POST_CHECK_LIMITS, type PostCheckLimits, type PostCheckSkip } from '../post-checks';
import { keepsProtectedTokens } from '../protected';
import { loadPrompt, renderPrompt } from '../prompts/render';
import hydeEn from '../prompts/llamaindex.hyde.en.v1.json';
import hydeIt from '../prompts/llamaindex.hyde.it.v1.json';
import hydeZh from '../prompts/llamaindex.hyde.zh.v1.json';
import { callNative, NATIVE_SYSTEM_PROMPT, type NativeDeps, type NativeTransformSkip } from './call';

const HYDE_PROMPTS: Readonly<Record<Lang, { id: string; file: unknown }>> = {
  en: { id: 'llamaindex.hyde.en', file: hydeEn },
  zh: { id: 'llamaindex.hyde.zh', file: hydeZh },
  it: { id: 'llamaindex.hyde.it', file: hydeIt },
};

const CJK_SENTENCE_END = new Set(['。', '！', '？']);
const LATIN_SENTENCE_END = new Set(['.', '!', '?']);

/**
 * The passage is an embedding string for the dense leg only (D-06, P-6): it is never the standalone,
 * rerank or refusal query, so the result has no field that could stand in for one.
 */
export type HydeVariant = { text: string; language: Lang; kind: 'hyde'; legs: 'dense'; protectedOk: boolean };
export type HydeInput = {
  query: string;
  language: Lang;
  protectedTokens: readonly string[];
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
};
export type HydeResult = { variant: HydeVariant | null; truncated: boolean; skipped: Array<PostCheckSkip | NativeTransformSkip> };

function isSentenceEnd(chars: readonly string[], index: number): boolean {
  const char = chars[index];
  if (CJK_SENTENCE_END.has(char)) return true;
  if (!LATIN_SENTENCE_END.has(char)) return false;
  const next = chars[index + 1];
  return next === undefined || /\s/u.test(next);
}

/** Cuts at the last sentence end within maxChars; a passage with none is cut at maxChars. */
export function capPassage(passage: string, maxChars: number): { text: string; truncated: boolean } {
  const text = passage.trim();
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false };
  for (let index = maxChars - 1; index >= 0; index -= 1) {
    if (isSentenceEnd(chars, index)) return { text: chars.slice(0, index + 1).join('').trim(), truncated: true };
  }
  return { text: chars.slice(0, maxChars).join('').trim(), truncated: true };
}

/** LlamaIndex HyDEQueryTransform with a per-language HYDE_TMPL; the original query is kept by the caller. */
export async function nativeHyde(input: HydeInput): Promise<HydeResult> {
  const { query, language, protectedTokens, signal, deps } = input;
  const { id, file } = HYDE_PROMPTS[language];
  const prompt = renderPrompt(loadPrompt(id, { [id]: file }), { context_str: query }, { language, maxItems: 1, protectedTokens });
  const call = await callNative(deps, {
    transform: 'hyde',
    schema: HypotheticalDocumentSchema,
    system: NATIVE_SYSTEM_PROMPT,
    prompt,
    input: query,
    signal,
  });
  if (!call.ok) return { variant: null, truncated: false, skipped: [call.skip] };

  return finishHyde(input, call.value.passage);
}

export type FinishHydeInput = Pick<HydeInput, 'query' | 'language' | 'protectedTokens' | 'limits'>;

/** Caps the passage at a sentence end and applies the HyDE post-checks; shared by both frameworks (D-02). */
export function finishHyde(input: FinishHydeInput, passage: string): HydeResult {
  const { query, language, protectedTokens } = input;
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const capped = capPassage(passage, limits.variantMaxChars);
  const checked = checkVariant({ kind: 'hyde', text: capped.text, input: query, protectedTokens }, limits);
  if (!checked.ok) return { variant: null, truncated: capped.truncated, skipped: [checked.skip] };
  return {
    variant: {
      text: checked.text,
      language,
      kind: 'hyde',
      legs: 'dense',
      protectedOk: keepsProtectedTokens(checked.text, protectedTokens),
    },
    truncated: capped.truncated,
    skipped: [],
  };
}
