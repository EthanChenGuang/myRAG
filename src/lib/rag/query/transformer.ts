import type { QueryFramework } from '../config';
import { getRagDeps } from '../deps';
import { DEFAULT_POST_CHECK_LIMITS, type PostCheckLimits } from './post-checks';
import type { CondensedQuery } from '@/lib/rag-eval/contracts.generated';
import { finishCondense, llamaindexCondense, type CondenseInput, type CondenseResult } from './llamaindex/condense';
import { finishDecompose, nativeDecompose, type DecomposeInput, type DecomposeResult, type FinishDecomposeInput } from './llamaindex/decompose';
import { finishExpand, nativeExpand, type ExpandInput, type ExpandResult, type FinishExpandInput } from './llamaindex/expand';
import { finishHyde, nativeHyde, type FinishHydeInput, type HydeInput, type HydeResult } from './llamaindex/hyde';
import {
  finishTranslate,
  nativeTranslate,
  translateRequests,
  type NativeTranslateInput,
  type NativeTranslateResult,
  type TranslateCallOutcome,
  type TranslateRequest,
  type TranslateRequestInput,
} from './llamaindex/translate';

export type { CondenseInput, CondenseResult } from './llamaindex/condense';
export type { DecomposeResult } from './llamaindex/decompose';
export type { ExpandResult } from './llamaindex/expand';
export type { HydeResult } from './llamaindex/hyde';
export type { NativeTranslateResult as TranslateResult, TranslateCallOutcome, TranslateRequest, TranslateSkipReason } from './llamaindex/translate';

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

/**
 * The post-check step after the LLM call, identical for every framework (D-02): the LangChain adapter gets these in its
 * deps, so it imports no post-check module and its results have exactly the native shapes.
 */
export interface QueryTransformFinishers {
  condense(input: Pick<CondenseInput, 'query' | 'protectedTokens' | 'limits'>, output: CondensedQuery): CondenseResult;
  expand(input: FinishExpandInput, queries: readonly string[]): ExpandResult;
  hyde(input: FinishHydeInput, passage: string): HydeResult;
  /** Validates the raw SubQuestions output (wire bound) and applies the D-15 cut and checks. */
  decompose(input: FinishDecomposeInput, output: unknown): DecomposeResult;
  /** The translate calls to make: targets picked and the shared prompt rendered (research A-6). */
  translateRequests(input: TranslateRequestInput): TranslateRequest[];
  translate(input: TranslateRequestInput, outcomes: readonly TranslateCallOutcome[]): NativeTranslateResult;
  /** The D-15 limits a transform uses when its input carries none. */
  readonly defaultLimits: Readonly<PostCheckLimits>;
}

export const QUERY_TRANSFORM_FINISHERS: QueryTransformFinishers = Object.freeze({
  condense: finishCondense,
  expand: finishExpand,
  hyde: finishHyde,
  decompose: finishDecompose,
  translateRequests,
  translate: finishTranslate,
  defaultLimits: DEFAULT_POST_CHECK_LIMITS,
});
