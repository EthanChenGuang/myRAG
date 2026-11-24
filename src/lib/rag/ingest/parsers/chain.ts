import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { IngestParser } from '../config';
import type { ProcessingProfile } from '../profiles/load';
import type { ParseArtifact, ParseRequest, ParserName, PendingJob } from './shared';

export interface FallbackNote {
  parser: ParserName;
  reason: string;
}

export type ChainOutcome =
  | { kind: 'done'; parser: ParserName; result: ParseResult; artifacts: ParseArtifact[]; warnings: string[]; fallbacks: FallbackNote[] }
  | { kind: 'pending'; job: PendingJob; fallbacks: FallbackNote[] }
  | { kind: 'failed'; reason: 'no_parser_available'; fallbacks: FallbackNote[] };

export function buildParserChain(_profile: ProcessingProfile, _config: { parser: IngestParser }, _file: { filename: string; mimeType: string }): ParserName[] {
  return [];
}

export async function parseWithFallback(_chain: ParserName[], _request: ParseRequest): Promise<ChainOutcome> {
  return { kind: 'failed', reason: 'no_parser_available', fallbacks: [] };
}
