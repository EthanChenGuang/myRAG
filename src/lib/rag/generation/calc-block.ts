import type { CalcRequest } from '@/lib/rag-eval/contracts.generated';

export type CalcBlockInvalidReason = 'unterminated' | 'too_long' | 'parse' | 'schema';
export interface CalcBlockTrace {
  origin: 'trailing_block';
  request: CalcRequest;
  anchor_offset: number;
}
export interface CalcBlockInvalid {
  invalid: CalcBlockInvalidReason;
  anchor_offset: number;
}
export type CalcBlockEvent = CalcBlockTrace | CalcBlockInvalid;
export interface CalcBlockOptions {
  onTrace?: (event: CalcBlockEvent) => void;
  maxBlockChars?: number;
  stripMarkers?: boolean;
}
export interface CalcBlockExtractor {
  push(delta: string): string;
  flush(): string;
  rawText(): string;
  visibleText(): string;
}
/** RED stub: passes text through unchanged. */
export function createCalcBlockExtractor(_options: CalcBlockOptions = {}): CalcBlockExtractor {
  let text = '';
  return { push: (delta) => ((text += delta), delta), flush: () => '', rawText: () => text, visibleText: () => text };
}
export function extractCalcBlocks(text: string, _options: CalcBlockOptions = {}) {
  return { visibleText: text, rawText: text, traces: [] as CalcBlockTrace[], invalid: [] as CalcBlockInvalid[] };
}
