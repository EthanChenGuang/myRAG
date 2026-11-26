import { QueryVariantsSchema } from '@/lib/rag-eval/contracts.generated';
import type { Lang } from '../rewrite-gate';
import { checkVariant, DEFAULT_POST_CHECK_LIMITS, type PostCheckLimits, type PostCheckSkip } from '../post-checks';
import { loadPrompt, renderPrompt } from '../prompts/render';
import fusionPrompt from '../prompts/llamaindex.fusion.v1.json';
import { callNative, NATIVE_SYSTEM_PROMPT, sameText, type NativeDeps, type NativeTransformSkip } from './call';

const PROMPT_ID = 'llamaindex.fusion';

export type ExpandedVariant = { text: string; language: Lang; kind: 'expanded'; legs: 'both'; protectedOk: true };
export type ExpandInput = {
  query: string;
  language: Lang;
  protectedTokens: readonly string[];
  /** The D-08 LLM-variant budget left for expansion; the original is retrieved separately and never counted. */
  maxItems: number;
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
};
export type ExpandResult = { variants: ExpandedVariant[]; skipped: Array<PostCheckSkip | NativeTransformSkip> };

/**
 * LlamaIndex QueryFusionRetriever query generation: asks for maxItems queries (LlamaIndex's num_queries - 1,
 * the original being added by the caller), then keeps, in order, the ones that pass the shared post-checks.
 */
export async function nativeExpand(input: ExpandInput): Promise<ExpandResult> {
  const { query, language, protectedTokens, signal, deps } = input;
  const maxItems = Math.max(0, Math.floor(input.maxItems));
  if (maxItems === 0) return { variants: [], skipped: [] };

  const prompt = renderPrompt(
    loadPrompt(PROMPT_ID, { [PROMPT_ID]: fusionPrompt }),
    { num_queries: String(maxItems), query },
    { language, maxItems, protectedTokens },
  );
  const call = await callNative(deps, {
    transform: 'expand',
    schema: QueryVariantsSchema,
    system: NATIVE_SYSTEM_PROMPT,
    prompt,
    input: query,
    signal,
  });
  if (!call.ok) return { variants: [], skipped: [call.skip] };

  return finishExpand(input, call.value.queries);
}

export type FinishExpandInput = Pick<ExpandInput, 'query' | 'language' | 'protectedTokens' | 'maxItems' | 'limits'>;

/**
 * Keeps, in order, the generated queries that are not the original or a repeat and pass the shared post-checks, up to
 * maxItems; shared by both frameworks (D-02).
 */
export function finishExpand(input: FinishExpandInput, queries: readonly string[]): ExpandResult {
  const { query, language, protectedTokens } = input;
  const maxItems = Math.max(0, Math.floor(input.maxItems));
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const variants: ExpandedVariant[] = [];
  const skipped: Array<PostCheckSkip | NativeTransformSkip> = [];
  let overCap = 0;
  queries.forEach((text, index) => {
    if (sameText(text, query) || variants.some((v) => sameText(v.text, text))) return;
    if (variants.length >= maxItems) {
      overCap += 1;
      return;
    }
    const checked = checkVariant({ kind: 'expand', text, input: query, protectedTokens }, limits);
    if (!checked.ok) {
      skipped.push({ ...checked.skip, index });
      return;
    }
    variants.push({ text: checked.text.trim(), language, kind: 'expanded', legs: 'both', protectedOk: true });
  });
  if (overCap > 0) skipped.push({ kind: 'expand', reason: 'cap', count: overCap });
  return { variants, skipped };
}
