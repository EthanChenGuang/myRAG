import type {
  CondenseInput,
  CondenseResult,
  ExpandResult,
  HydeResult,
  QueryTransformer,
  QueryTransformFinishers,
  TransformExpandInput,
  TransformHydeInput,
} from '../transformer';
import type { ChatModelFactory } from './chat-model';
import { LangChainAdapterError, type LangChainTransform } from './errors';

export interface LangChainTransformerDeps {
  finish: QueryTransformFinishers;
  decompose: QueryTransformer['decompose'];
  translate: QueryTransformer['translate'];
}

export interface CreateLangChainTransformerOptions {
  chatModelFactory: (transform: LangChainTransform) => ReturnType<ChatModelFactory>;
  deps: LangChainTransformerDeps;
}

export function createLangChainTransformer(options: CreateLangChainTransformerOptions): QueryTransformer {
  return Object.freeze({
    framework: 'langchain' as const,
    condense: async (input: CondenseInput): Promise<CondenseResult> => ({ standalone: input.query, passThrough: true, skip: null }),
    expand: async (_input: TransformExpandInput): Promise<ExpandResult> => ({ variants: [], skipped: [] }),
    hyde: async (_input: TransformHydeInput): Promise<HydeResult> => {
      throw new LangChainAdapterError('unavailable', 'hyde');
    },
    decompose: options.deps.decompose,
    translate: options.deps.translate,
  });
}
