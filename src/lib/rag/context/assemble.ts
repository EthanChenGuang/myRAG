import type { ExtractedURL } from '@/lib/url-extractor';
import type { KeptBy, KeptChunk, RagMode, ReferencedState, SourceImage, UsedDocument } from '../types';

export interface AssemblyCandidate {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, any> | null;
}

export interface AssemblyDocumentRow {
  id: string;
  filename: string;
  created_at?: string | null;
  content?: string | null;
  metadata?: Record<string, any> | null;
}

export interface AssembleInput<C extends AssemblyCandidate = AssemblyCandidate> {
  queryText: unknown;
  candidates: C[];
  documents: Map<string, AssemblyDocumentRow>;
  chunkMetadata: Map<string, Record<string, any> | null>;
  referenced: ReferencedState | null;
  isGPTModel: boolean;
  ragMode: RagMode;
  webSearchEnabled: boolean;
  applyRelevanceFilter: boolean;
}

export interface FilteredCandidates<C extends AssemblyCandidate = AssemblyCandidate> {
  queryTerms: string[];
  usedDocuments: UsedDocument[];
  relevantChunks: C[];
  context: string;
  chunkKeptBy: Map<string, KeptBy>;
  docKeptBy: Map<string, KeptBy>;
  applyRelevanceFilter: boolean;
}

export interface AssembleOutput<C extends AssemblyCandidate = AssemblyCandidate> {
  context: string;
  usedDocuments: UsedDocument[];
  relevantChunks: C[];
  kept: KeptChunk[];
  queryTerms: string[];
  sourceImages: SourceImage[];
  links: ExtractedURL[];
  refusalCandidate: boolean;
}

export function normalizeQueryText(_input: unknown): string {
  return '';
}

export function filterCandidates<C extends AssemblyCandidate>(_input: AssembleInput<C>): FilteredCandidates<C> {
  return {
    queryTerms: [],
    usedDocuments: [],
    relevantChunks: [],
    context: '',
    chunkKeptBy: new Map(),
    docKeptBy: new Map(),
    applyRelevanceFilter: true,
  };
}

export function buildContext<C extends AssemblyCandidate>(
  _filtered: FilteredCandidates<C>,
  _input: AssembleInput<C>,
): AssembleOutput<C> {
  return {
    context: '',
    usedDocuments: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    sourceImages: [],
    links: [],
    refusalCandidate: false,
  };
}

export function assembleContext<C extends AssemblyCandidate>(input: AssembleInput<C>): AssembleOutput<C> {
  return buildContext(filterCandidates(input), input);
}
