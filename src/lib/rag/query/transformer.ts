import type { QueryFramework } from '../config';
import { llamaindexCondense, type CondenseInput, type CondenseResult } from './llamaindex/condense';

export type { CondenseInput, CondenseResult } from './llamaindex/condense';

/**
 * D-02: the one framework seam. Only the LLM-generating step differs between frameworks; the gate, post-checks, plan and
 * tracing are shared. This plan carries condense only (expand, HyDE and decompose follow in 06-19, translate in 06-23).
 */
export interface QueryTransformer {
  readonly framework: QueryFramework;
  condense(input: CondenseInput): Promise<CondenseResult>;
}

const NATIVE_TRANSFORMER: QueryTransformer = Object.freeze({
  framework: 'llamaindex',
  condense: llamaindexCondense,
});

const TRANSFORMERS: Readonly<Record<QueryFramework, QueryTransformer | null>> = Object.freeze({
  llamaindex: NATIVE_TRANSFORMER,
  // The LangChain adapter arrives with plan 06-37; until then that framework is served by the native port.
  langchain: null,
});

/** The transformer for a framework; the plan records the framework that actually ran. */
export function getQueryTransformer(framework: QueryFramework = 'llamaindex'): QueryTransformer {
  return TRANSFORMERS[framework] ?? NATIVE_TRANSFORMER;
}
