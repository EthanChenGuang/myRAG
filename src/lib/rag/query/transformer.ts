import type { QueryFramework } from '../config';
import { getRagDeps } from '../deps';
import { llamaindexCondense, type CondenseInput, type CondenseResult } from './llamaindex/condense';
import { nativeDecompose, type DecomposeInput, type DecomposeResult } from './llamaindex/decompose';
import { nativeExpand, type ExpandInput, type ExpandResult } from './llamaindex/expand';
import { nativeHyde, type HydeInput, type HydeResult } from './llamaindex/hyde';
import { nativeTranslate, type NativeTranslateInput, type NativeTranslateResult } from './llamaindex/translate';

export type { CondenseInput, CondenseResult } from './llamaindex/condense';
export type { DecomposeResult } from './llamaindex/decompose';
export type { ExpandResult } from './llamaindex/expand';
export type { HydeResult } from './llamaindex/hyde';
export type { NativeTranslateResult as TranslateResult } from './llamaindex/translate';

/** The shared transform inputs; the implementation supplies its own client (D-02). */
export type TransformExpandInput = Omit<ExpandInput, 'deps'>;
export type TransformHydeInput = Omit<HydeInput, 'deps'>;
export type TransformDecomposeInput = Omit<DecomposeInput, 'deps'>;
export type TransformTranslateInput = Omit<NativeTranslateInput, 'deps'>;

/**
 * D-02: the one framework seam. Only the LLM-generating step differs between frameworks; the gate, router, post-checks,
 * budgets, plan and tracing are shared.
 */
export interface QueryTransformer {
  readonly framework: QueryFramework;
  condense(input: CondenseInput): Promise<CondenseResult>;
  expand(input: TransformExpandInput): Promise<ExpandResult>;
  hyde(input: TransformHydeInput): Promise<HydeResult>;
  decompose(input: TransformDecomposeInput): Promise<DecomposeResult>;
  translate(input: TransformTranslateInput): Promise<NativeTranslateResult>;
}

const NATIVE_TRANSFORMER: QueryTransformer = Object.freeze({
  framework: 'llamaindex',
  condense: llamaindexCondense,
  expand: (input: TransformExpandInput) => nativeExpand({ ...input, deps: getRagDeps() }),
  hyde: (input: TransformHydeInput) => nativeHyde({ ...input, deps: getRagDeps() }),
  decompose: (input: TransformDecomposeInput) => nativeDecompose({ ...input, deps: getRagDeps() }),
  translate: (input: TransformTranslateInput) => nativeTranslate({ ...input, deps: getRagDeps() }),
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
