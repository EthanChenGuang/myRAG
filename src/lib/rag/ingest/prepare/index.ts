import type { BoilerplateReport, ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import type { ArtifactContext } from '../artifacts';
import type { ChunkerConfig } from '../chunkers';
import type { PageBoilerplateMode } from '../config';
import type { TenantRules } from '../rules/load';
import type { ChunkPrepSnapshot } from '../types';
import type { IngestWriter } from '../writer';
import type { BoilerplateMode } from './boilerplate';
import type { PageLines } from './page-lines';

// RED stub (plan 03.3-10 Task 2): the exports exist, the behaviour does not.
export const TENANT_RULES_UNAVAILABLE = 'tenant_rules_unavailable';
export const BOILERPLATE_SNAPSHOT_TOO_LARGE = 'boilerplate_snapshot_too_large';
export const PREPARE_FAILED = 'prepare_failed';
export const REVIEW_CODES = ['section_rules_not_satisfied', 'boilerplate_above_threshold', 'tenant_pattern_timeout'] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];
export const CHUNK_PREP_SNAPSHOT_CAP = { maxEntries: 2000, maxJsonBytes: 256 * 1024 } as const;
export const NO_RULES_FINGERPRINT = '0'.repeat(64);
type ParseChunk = ParseResult['chunks'][number];
export interface PrepareChunkInputArgs {
  markdown: string; parseChunks: readonly ParseChunk[] | null; pageLines: PageLines | null; baseChunker: ChunkerConfig; mode: BoilerplateMode;
  rules?: TenantRules | null; snapshot?: ChunkPrepSnapshot | null; deadlineMs?: number; signal?: AbortSignal;
}
export interface PrepareChunkInputResult {
  markdown: string; parseChunks: ParseChunk[] | null; chunker: ChunkerConfig; report: BoilerplateReport; review: ReviewCode[]; warnings: string[]; snapshot: ChunkPrepSnapshot;
}
export function needsPatternCall(_mode: PageBoilerplateMode, _rules: TenantRules | null | undefined, _snapshot?: ChunkPrepSnapshot | null): boolean { return false; }
export function needsPageLines(_mode: PageBoilerplateMode, _rules: TenantRules | null | undefined): boolean { return false; }
export function candidateLines(_markdown: string): string[] { return []; }
export async function prepareChunkInput(args: PrepareChunkInputArgs): Promise<PrepareChunkInputResult> {
  return {
    markdown: args.markdown, parseChunks: (args.parseChunks as ParseChunk[] | null), chunker: args.baseChunker,
    report: { cleaner_version: 1, rules_version: 1, lines_removed: 0, tokens_removed: 0, share: 0 }, review: [], warnings: [],
    snapshot: { fingerprint: NO_RULES_FINGERPRINT, warnings: [], truncated: false },
  };
}
export function uncleanedSnapshot(_mode: BoilerplateMode): ChunkPrepSnapshot { return { fingerprint: NO_RULES_FINGERPRINT, warnings: [], truncated: false }; }
export async function loadPageLines(_context: ArtifactContext, _options: { reuseOfVersion?: number | null } = {}): Promise<PageLines | null> { return null; }
export interface PrepareOutcomeTarget { writer: Pick<IngestWriter, 'setFields'>; db: RpcClient | null; documentId: string; tenantKey: string; }
export async function applyPrepareOutcome(_target: PrepareOutcomeTarget, _outcome: { report: BoilerplateReport | null; review: readonly ReviewCode[] }, _options: { signal?: AbortSignal } = {}): Promise<void> {}
