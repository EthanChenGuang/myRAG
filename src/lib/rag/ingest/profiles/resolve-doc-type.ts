import type { DocTypeDetection } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import type { TenantScope } from '../../tenant/scope';
import type { IngestConfig } from '../config';
import type { DocTypeOrigin, IngestIdentity, IngestSource, IngestState } from '../types';
import { getProcessingProfile, type DocType, type ProcessingProfile } from './load';

export type DocTypeChoice = DocType | 'auto';

export const DOC_TYPE_DEFAULT_SOURCE_KINDS = ['tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload'] as const;
export type DocTypeDefaultSourceKind = (typeof DOC_TYPE_DEFAULT_SOURCE_KINDS)[number];

export interface DocTypeDefaultRow {
  sourceKind: DocTypeDefaultSourceKind;
  sourceRef: string | null;
  docType: DocTypeChoice;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface DocTypeDefaultsSelector {
  source: IngestSource;
  nangoConnectionId?: string | null;
  nangoFolderId?: string | null;
}

export interface SetDocTypeDefaultInput {
  sourceKind: DocTypeDefaultSourceKind;
  sourceRef?: string | null;
  docType: DocTypeChoice;
  updatedBy: string;
}

export interface ResolveDocTypeInput {
  picked?: DocTypeChoice;
  source: IngestSource;
  nangoConnectionId?: string | null;
  nangoFolderId?: string | null;
  filename: string;
  mimeType: string;
  text?: string | null;
  textLayerPageShare?: number | null;
}

export interface ResolveDocTypeDeps {
  db: () => RpcClient | null;
  config: IngestConfig;
  signal: AbortSignal;
}

export interface ResolvedDocType {
  docType: DocType;
  origin: DocTypeOrigin;
  profile: ProcessingProfile;
  detection: DocTypeDetection | null;
  warnings: string[];
}

export interface RefineParse {
  text: string;
  textLayerPageShare?: number | null;
}

export interface RefineContext {
  identity: IngestIdentity | null;
  state: IngestState;
  config: IngestConfig;
  signal: AbortSignal;
  warnings: string[];
  input: { filename: string; mimeType: string };
}

export interface RefineOutcome {
  changed: boolean;
  docType: DocType;
  profile: ProcessingProfile;
  parserOptionsDiffer: boolean;
  detection: DocTypeDetection | null;
}

export class DocTypeDefaultsError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly reason: string | null;

  constructor(rpc: string, code: string | null, reason: string | null = null) {
    super(`[Doc Type Defaults] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'DocTypeDefaultsError';
    this.rpc = rpc;
    this.code = code;
    this.reason = reason;
  }
}

export async function resolveDocType(_scope: TenantScope, _input: ResolveDocTypeInput, _deps?: ResolveDocTypeDeps): Promise<ResolvedDocType> {
  return { docType: 'general', origin: 'fallback', profile: getProcessingProfile('general'), detection: null, warnings: [] };
}

export async function refineDocTypeAfterParse(ctx: RefineContext, _parse: RefineParse): Promise<RefineOutcome> {
  const docType = ctx.identity?.docType ?? 'general';
  return { changed: false, docType, profile: getProcessingProfile(docType), parserOptionsDiffer: false, detection: null };
}

export async function getDocTypeDefaults(_scope: TenantScope, _selector?: DocTypeDefaultsSelector, _deps?: Pick<ResolveDocTypeDeps, 'db' | 'signal'>): Promise<DocTypeDefaultRow[]> {
  return [];
}

export async function setDocTypeDefault(_scope: TenantScope, input: SetDocTypeDefaultInput, _deps?: Pick<ResolveDocTypeDeps, 'db' | 'signal'>): Promise<DocTypeDefaultRow> {
  return { sourceKind: input.sourceKind, sourceRef: input.sourceRef ?? null, docType: input.docType, updatedBy: null, updatedAt: null };
}

export async function deleteDocTypeDefault(
  _scope: TenantScope,
  _input: { sourceKind: DocTypeDefaultSourceKind; sourceRef?: string | null },
  _deps?: Pick<ResolveDocTypeDeps, 'db' | 'signal'>,
): Promise<boolean> {
  return false;
}
