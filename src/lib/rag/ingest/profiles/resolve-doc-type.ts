import { ProcessingProfileSetSchema, type DocTypeDetection } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';
import type { IngestConfig } from '../config';
import type { DocTypeOrigin, IngestIdentity, IngestSource, IngestState } from '../types';
import { DOC_TYPE_CONFIDENCE_FLOOR, detectDocType, type DetectDocTypeInput } from './detect-doc-type';
import { detectDocTypeWithLlm } from './llm-detect';
import { getProcessingProfile, profileFor, type DocType, type ProcessingProfile } from './load';

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
  /** The admin user who makes the change; the route takes it from the admin guard result. */
  updatedBy: string;
}

export interface ResolveDocTypeInput {
  picked?: DocTypeChoice;
  source: IngestSource;
  nangoConnectionId?: string | null;
  nangoFolderId?: string | null;
  filename: string;
  mimeType: string;
  /** Only when the text is already at hand (a text upload); a file is detected from its name until it is parsed. */
  text?: string | null;
  textLayerPageShare?: number | null;
}

export interface ResolveDocTypeDeps {
  db: () => RpcClient | null;
  config: IngestConfig;
  signal: AbortSignal;
}

export type DocTypeDefaultsDeps = Pick<ResolveDocTypeDeps, 'db' | 'signal'>;

export interface ResolvedDocType {
  docType: DocType;
  origin: DocTypeOrigin;
  profile: ProcessingProfile;
  /** Set when auto-detection decided the type. */
  detection: DocTypeDetection | null;
  warnings: string[];
}

export interface RefineParse {
  text: string;
  textLayerPageShare?: number | null;
}

/** The part of the stage context the refinement reads and updates; StageContext satisfies it. */
export interface RefineContext {
  identity: IngestIdentity | null;
  state: IngestState;
  config: IngestConfig;
  signal: AbortSignal;
  warnings: string[];
  input: { filename: string; mimeType: string; source?: IngestSource };
}

export interface RefineOutcome {
  changed: boolean;
  docType: DocType;
  profile: ProcessingProfile;
  /** True when the new profile parses differently and no re-parse has happened yet; the caller re-parses once. */
  parserOptionsDiffer: boolean;
  detection: DocTypeDetection | null;
}

const DOC_TYPES: readonly DocType[] = ProcessingProfileSetSchema.shape.profiles.element.shape.doc_type.options;

/** Reason words the SQL functions raise; only these ever leave this module, never the rest of a message. */
const KNOWN_REASONS = new Set(['invalid_tenant_key', 'invalid_source_kind', 'invalid_doc_type', 'actor_required', 'invalid_argument']);

const MAX_REF_LENGTH = 200;

type Row = Record<string, unknown>;

/** A failed defaults call. Carries the function name, the error code and a reason word only: the database message can echo input. */
export class DocTypeDefaultsError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly reason: string | null;

  constructor(rpc: string, code: string | null, reason: string | null = null) {
    super(`[Doc Type Defaults] ${rpc} failed${code ? ` (${code})` : ''}${reason ? ` ${reason}` : ''}`);
    this.name = 'DocTypeDefaultsError';
    this.rpc = rpc;
    this.code = code;
    this.reason = reason;
  }
}

function isDocType(value: unknown): value is DocType {
  return typeof value === 'string' && (DOC_TYPES as readonly string[]).includes(value);
}

function isDocTypeChoice(value: unknown): value is DocTypeChoice {
  return value === 'auto' || isDocType(value);
}

function isSourceKind(value: unknown): value is DocTypeDefaultSourceKind {
  return typeof value === 'string' && (DOC_TYPE_DEFAULT_SOURCE_KINDS as readonly string[]).includes(value);
}

function reasonOf(message: string | undefined): string | null {
  const word = /^[a-z_]+/.exec(message ?? '')?.[0];
  return word !== undefined && KNOWN_REASONS.has(word) ? word : null;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function present(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function tenantKeyOf(scope: TenantScope): string {
  assertTenantScope(scope);
  return scopeKey(scope).toLowerCase();
}

async function callRpc(deps: DocTypeDefaultsDeps, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  const db = deps.db();
  if (!db) throw new DocTypeDefaultsError(rpc, 'db_unavailable');
  deps.signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(deps.signal);
  deps.signal.throwIfAborted();
  if (response.error) throw new DocTypeDefaultsError(rpc, response.error.code ?? null, reasonOf(response.error.message));
  return (response.data ?? []) as Row[];
}

/** Maps a returned row; a row of another tenant or one this build cannot read is dropped, never used. */
function parseRow(row: Row, tenantKey: string, warnings: string[]): DocTypeDefaultRow | null {
  if (text(row, 'tenant_key') !== tenantKey) {
    console.error('[Ingest] doc type defaults returned a row outside the caller tenant; dropped');
    return null;
  }
  const sourceKind = row.source_kind;
  const docType = row.doc_type;
  if (!isSourceKind(sourceKind) || !isDocTypeChoice(docType)) {
    warnings.push('doc_type_default_invalid');
    return null;
  }
  return {
    sourceKind,
    sourceRef: text(row, 'source_ref'),
    docType,
    updatedBy: text(row, 'updated_by'),
    updatedAt: text(row, 'updated_at'),
  };
}

/**
 * The default rows of the caller's tenant. With a selector: the tenant default, the default of that source and, for Nango,
 * the connection and folder rows. Without one: every row of the tenant (the admin list). Throws DocTypeDefaultsError on failure.
 */
export async function getDocTypeDefaults(
  scope: TenantScope,
  selector: DocTypeDefaultsSelector | undefined,
  deps: DocTypeDefaultsDeps,
): Promise<DocTypeDefaultRow[]> {
  return loadDefaults(scope, selector, deps, []);
}

async function loadDefaults(
  scope: TenantScope,
  selector: DocTypeDefaultsSelector | undefined,
  deps: DocTypeDefaultsDeps,
  warnings: string[],
): Promise<DocTypeDefaultRow[]> {
  const tenantKey = tenantKeyOf(scope);
  const rows = await callRpc(deps, 'rag_get_doc_type_defaults', {
    p_tenant_key: tenantKey,
    p_source: selector?.source ?? null,
    p_connection_id: present(selector?.nangoConnectionId),
    p_folder_id: present(selector?.nangoFolderId),
  });
  return rows.map((row) => parseRow(row, tenantKey, warnings)).filter((row): row is DocTypeDefaultRow => row !== null);
}

function refused(rpc: string, reason: string): DocTypeDefaultsError {
  return new DocTypeDefaultsError(rpc, null, reason);
}

function normaliseRef(rpc: string, kind: DocTypeDefaultSourceKind, ref: string | null | undefined): string | null {
  if (ref === undefined || ref === null) return null;
  const trimmed = ref.trim();
  if (kind !== 'nango' || trimmed === '' || trimmed.length > MAX_REF_LENGTH) throw refused(rpc, 'invalid_argument');
  return trimmed;
}

/**
 * Creates or replaces one default of the caller's tenant. The tenant key comes from the scope only. Executable by the server role
 * only in the database; whoever calls this must have passed the admin guard first.
 */
export async function setDocTypeDefault(
  scope: TenantScope,
  input: SetDocTypeDefaultInput,
  deps: DocTypeDefaultsDeps,
): Promise<DocTypeDefaultRow> {
  const rpc = 'rag_set_doc_type_default';
  const tenantKey = tenantKeyOf(scope);
  if (!isSourceKind(input.sourceKind)) throw refused(rpc, 'invalid_source_kind');
  if (!isDocTypeChoice(input.docType)) throw refused(rpc, 'invalid_doc_type');
  const actor = typeof input.updatedBy === 'string' ? input.updatedBy.trim() : '';
  if (actor === '' || actor.length > MAX_REF_LENGTH) throw refused(rpc, 'actor_required');
  const ref = normaliseRef(rpc, input.sourceKind, input.sourceRef);
  const rows = await callRpc(deps, rpc, {
    p_tenant_key: tenantKey,
    p_source_kind: input.sourceKind,
    p_source_ref: ref,
    p_doc_type: input.docType,
    p_updated_by: actor,
  });
  const row = rows[0] ? parseRow(rows[0], tenantKey, []) : null;
  if (!row) throw new DocTypeDefaultsError(rpc, 'bad_response');
  return row;
}

/** Removes one default of the caller's tenant; false when there was none. Same access rule as setDocTypeDefault. */
export async function deleteDocTypeDefault(
  scope: TenantScope,
  input: { sourceKind: DocTypeDefaultSourceKind; sourceRef?: string | null },
  deps: DocTypeDefaultsDeps,
): Promise<boolean> {
  const rpc = 'rag_delete_doc_type_default';
  const tenantKey = tenantKeyOf(scope);
  if (!isSourceKind(input.sourceKind)) throw refused(rpc, 'invalid_source_kind');
  const ref = normaliseRef(rpc, input.sourceKind, input.sourceRef);
  const rows = await callRpc(deps, rpc, { p_tenant_key: tenantKey, p_source_kind: input.sourceKind, p_source_ref: ref });
  return rows[0]?.deleted === true;
}

interface DefaultChoice {
  value: DocTypeChoice;
  origin: 'source_default' | 'tenant_default';
}

type Choice = DefaultChoice | { value: DocTypeChoice; origin: 'picked' };

/** Steps 2 to 5 of the order: Nango folder, Nango connection, source, tenant. */
function chooseDefault(rows: readonly DocTypeDefaultRow[], input: ResolveDocTypeInput): DefaultChoice | null {
  const nango = input.source === 'nango';
  const folderId = present(input.nangoFolderId);
  const connectionId = present(input.nangoConnectionId);
  const find = (kind: DocTypeDefaultSourceKind, ref: string | null) => rows.find((row) => row.sourceKind === kind && row.sourceRef === ref);

  const folder = nango && folderId !== null ? find('nango', folderId) : undefined;
  if (folder) return { value: folder.docType, origin: 'source_default' };
  const connection = nango && connectionId !== null ? find('nango', connectionId) : undefined;
  if (connection) return { value: connection.docType, origin: 'source_default' };
  const source = input.source === 'ai_to_rag' ? undefined : find(input.source, null);
  if (source) return { value: source.docType, origin: 'source_default' };
  const tenant = find('tenant', null);
  if (tenant) return { value: tenant.docType, origin: 'tenant_default' };
  return null;
}

export interface PickerDefault {
  docType: DocTypeChoice;
  origin: 'source_default' | 'tenant_default' | 'fallback';
}

/**
 * The default the upload picker pre-selects: steps 2 to 6 of the D-15 order for the caller's tenant, with an auto default returned as auto
 * (no detection runs here). Throws DocTypeDefaultsError when the defaults cannot be read; the picker route reports that, it does not guess.
 */
export async function resolvePickerDefault(scope: TenantScope, selector: DocTypeDefaultsSelector, deps: DocTypeDefaultsDeps): Promise<PickerDefault> {
  const rows = await loadDefaults(scope, selector, deps, []);
  const choice = chooseDefault(rows, {
    source: selector.source,
    nangoConnectionId: selector.nangoConnectionId,
    nangoFolderId: selector.nangoFolderId,
    filename: '',
    mimeType: '',
  });
  return choice === null ? { docType: 'general', origin: 'fallback' } : { docType: choice.value, origin: choice.origin };
}

/** Rules first; the optional classifier runs only when the switch is on, the rules are below the floor and there is text. */
async function runDetection(input: DetectDocTypeInput, config: IngestConfig, signal: AbortSignal, warnings: string[]): Promise<DocTypeDetection> {
  const rules = detectDocType(input);
  if (rules.confidence >= DOC_TYPE_CONFIDENCE_FLOOR || !config.docTypeLlmDetect) return rules;
  const text = input.text;
  if (typeof text !== 'string' || text.trim() === '') return rules;
  const outcome = await detectDocTypeWithLlm({ filename: input.filename, text, signal });
  if (!outcome.ok) {
    warnings.push(outcome.warning);
    return rules;
  }
  const answer = outcome.detection;
  return answer.doc_type !== 'general' && answer.confidence < DOC_TYPE_CONFIDENCE_FLOOR ? { ...answer, doc_type: 'general' } : answer;
}

function resolved(docType: DocType, origin: DocTypeOrigin, detection: DocTypeDetection | null, warnings: string[]): ResolvedDocType {
  return { docType, origin, profile: getProcessingProfile(docType), detection, warnings };
}

/**
 * The one place that decides a document's type (D-15): picked, then the Nango folder default, the Nango connection default, the
 * source default, the tenant default, then general. A winning auto runs detection. The defaults are read for the caller's tenant only;
 * an unreadable defaults table is reported as a warning and resolves to general, as before the table existed.
 */
export async function resolveDocType(
  scope: TenantScope,
  input: ResolveDocTypeInput,
  deps: ResolveDocTypeDeps,
): Promise<ResolvedDocType> {
  assertTenantScope(scope);
  const warnings: string[] = [];

  let choice: Choice | null = null;
  if (input.picked !== undefined) {
    if (!isDocTypeChoice(input.picked)) {
      warnings.push('doc_type_invalid');
      return resolved('general', 'fallback', null, warnings);
    }
    choice = { value: input.picked, origin: 'picked' };
  } else {
    let rows: DocTypeDefaultRow[] = [];
    try {
      rows = await loadDefaults(
        scope,
        { source: input.source, nangoConnectionId: input.nangoConnectionId, nangoFolderId: input.nangoFolderId },
        deps,
        warnings,
      );
    } catch (error) {
      if (deps.signal.aborted) throw error;
      const failure = error instanceof DocTypeDefaultsError ? error : null;
      console.warn('[Ingest] doc type defaults unavailable', { rpc: failure?.rpc ?? null, code: failure?.code ?? null });
      warnings.push('doc_type_defaults_unavailable');
    }
    choice = chooseDefault(rows, input);
  }

  if (choice === null) return resolved('general', 'fallback', null, warnings);
  if (choice.value !== 'auto') return resolved(choice.value, choice.origin, null, warnings);

  const detection = await runDetection(
    { filename: input.filename, mimeType: input.mimeType, text: input.text ?? null, textLayerPageShare: input.textLayerPageShare ?? null },
    deps.config,
    deps.signal,
    warnings,
  );
  return resolved(detection.doc_type, 'auto', detection, warnings);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameParserOptions(a: ProcessingProfile, b: ProcessingProfile): boolean {
  return stable(a.parser) === stable(b.parser);
}

/**
 * True when a parse made for the `stored` profile is a valid parse for the `wanted` one (D-18): the parser options are equal, except that
 * pictures the stored parse generated and the wanted profile does not ask for are simply left unused. The other way round (the wanted
 * profile needs pictures the stored parse did not generate) is a different parse.
 */
export function storedParseServes(stored: ProcessingProfile, wanted: ProcessingProfile): boolean {
  const comparable = wanted.parser.docling.generate_picture_images
    ? wanted.parser
    : { ...wanted.parser, docling: { ...wanted.parser.docling, generate_picture_images: stored.parser.docling.generate_picture_images } };
  return stable(stored.parser) === stable(comparable);
}

/**
 * Second step of detection (F-10): on the parsed text, a type that was auto-detected may change once. A type that was picked, came
 * from a default or fell back is never changed. Updates the identity and the state slice; the caller re-parses once when
 * parserOptionsDiffer is true and records it in state.docTypeDetection.reparsed.
 */
export async function refineDocTypeAfterParse(ctx: RefineContext, parse: RefineParse): Promise<RefineOutcome> {
  const identity = ctx.identity;
  const unchanged = (): RefineOutcome => ({
    changed: false,
    docType: identity?.docType ?? 'general',
    profile: identity?.profile ?? getProcessingProfile('general'),
    parserOptionsDiffer: false,
    detection: null,
  });
  if (!identity || identity.docTypeOrigin !== 'auto') return unchanged();
  const previous = ctx.state.docTypeDetection;
  if (previous && previous.refined !== null) return unchanged();

  const detection = await runDetection(
    { filename: ctx.input.filename, mimeType: ctx.input.mimeType, text: parse.text, textLayerPageShare: parse.textLayerPageShare ?? null },
    ctx.config,
    ctx.signal,
    ctx.warnings,
  );
  const base = previous ?? { signals: [], refined: null, reparsed: false };
  const target = detection.doc_type !== 'general' && detection.confidence >= DOC_TYPE_CONFIDENCE_FLOOR && detection.doc_type !== identity.docType ? detection.doc_type : null;
  if (target === null) {
    ctx.state.docTypeDetection = { ...base, refined: identity.docType };
    return unchanged();
  }

  const profile = ctx.input.source ? profileFor(ctx.input.source, target) : getProcessingProfile(target);
  const differ = !base.reparsed && !sameParserOptions(identity.profile, profile);
  identity.docType = target;
  identity.profile = profile;
  ctx.state.docTypeDetection = { ...base, signals: detection.signals, refined: target, detection };
  return { changed: true, docType: target, profile, parserOptionsDiffer: differ, detection };
}
