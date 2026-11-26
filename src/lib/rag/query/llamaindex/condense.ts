import { CondensedQuerySchema, type CondensedQuery } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps } from '../../deps';
import type { HistoryTurn } from '../../types';
import { checkCondensed, DEFAULT_POST_CHECK_LIMITS, type PostCheckLimits, type PostCheckSkip } from '../post-checks';
import { loadPrompt, renderPrompt } from '../prompts/render';
import type { Lang } from '../rewrite-gate';

export const LLAMAINDEX_CONDENSE_PROMPT_ID = 'llamaindex.condense';

const SYSTEM =
  'You rewrite a follow-up message into one standalone search question. Return the question in "standalone" and set "unchanged" to true when the message already stands alone.';

export interface CondenseInput {
  query: string;
  history: readonly HistoryTurn[];
  language: Lang;
  protectedTokens: readonly string[];
  limits?: PostCheckLimits;
  signal: AbortSignal;
}

export interface CondenseResult {
  /** The standalone query: the rewrite when it passed the D-15 checks, otherwise the original query. */
  standalone: string;
  passThrough: boolean;
  /** Set when the rewrite was discarded (the original is used); never carries query text. */
  skip: PostCheckSkip | null;
}

/** QRY-01: the LlamaIndex condense-question method, native, with the shared suffix and the D-15 post-checks. */
export async function llamaindexCondense(input: CondenseInput): Promise<CondenseResult> {
  const prompt = renderPrompt(
    loadPrompt(LLAMAINDEX_CONDENSE_PROMPT_ID),
    { question: input.query },
    { language: input.language, maxItems: 1, protectedTokens: input.protectedTokens, history: input.history },
  );
  const output = await getRagDeps()
    .queryLlm()
    .generate({ transform: 'condense', schema: CondensedQuerySchema, system: SYSTEM, prompt, input: input.query, signal: input.signal });
  return finishCondense(input, output);
}

/** The D-15 post-checks on a CondensedQuery; shared by both frameworks so their results have one shape (D-02). */
export function finishCondense(input: Pick<CondenseInput, 'query' | 'protectedTokens' | 'limits'>, output: CondensedQuery): CondenseResult {
  const text = output.unchanged ? input.query : output.standalone;
  const checked = checkCondensed({ text, input: input.query, protectedTokens: input.protectedTokens }, input.limits ?? DEFAULT_POST_CHECK_LIMITS);
  return { standalone: checked.text, passThrough: checked.passThrough, skip: checked.skip };
}
