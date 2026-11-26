import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import type { OutputGuard, OutputGuardLinkSummary } from './output-guard';

type Part = TextStreamPart<ToolSet>;

export interface OutputGuardTransformOptions {
  createGuard: () => OutputGuard;
  onSummary?: (summary: OutputGuardLinkSummary) => void;
  observe?: (part: Part) => void;
}

export function outputGuardTransform(_options: OutputGuardTransformOptions): StreamTextTransform<ToolSet> {
  return () => new TransformStream<Part, Part>();
}
