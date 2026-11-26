import { z } from 'zod/v3';
import type { RetrievalFilterInput, RetrievalFilters, VersionScope } from '@/lib/rag/backend/types';
import type { Profile, RunRetrievalInput } from '@/lib/rag/types';
import { RetrievalFiltersSchema } from '@/lib/rag-eval/contracts.generated';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { loadRagConfig, type AttributeFilterMode } from '@/lib/rag/config';
import { getRagDeps } from '@/lib/rag/deps';

const DOC_TYPE_VALUES = [
  'general',
  'financial_report',
  'contract_legal',
  'invoice_receipt',
  'product_technical',
  'scanned_image',
] as const;

function registryCodes(): [string, ...string[]] {
  const [first, ...rest] = getLanguageRegistry().packs.map((pack) => pack.code);
  if (first === undefined) throw new Error('[Retrieval Filters] the language registry lists no codes');
  return [first, ...rest];
}

const LANGUAGE_VALUES = registryCodes();

const amountPattern = /^-?\d+(\.\d{1,4})?$/;

/** D-38: the three fixed scope dimensions; values are slugs checked against the contract and then the tenant vocabulary. */
export const SCOPE_DIMENSIONS = ['region', 'legal_entity', 'department'] as const;
type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

const scopeValuesSchema = z.array(z.string()).max(50).optional();

const retrievalFilterBodySchema = z
  .object({
    dateRange: z
      .object({
        from: z.string().date(),
        to: z.string().date(),
      })
      .strict()
      .optional(),
    sources: z.array(z.string().min(1)).optional(),
    documentIds: z.array(z.string().uuid()).optional(),
    docTypes: z.array(z.enum(DOC_TYPE_VALUES)).optional(),
    languages: z.array(z.enum(LANGUAGE_VALUES)).optional(),
    invoice: z
      .object({
        supplier: z.string().min(1),
        amountMin: z.string().regex(amountPattern),
        amountMax: z.string().regex(amountPattern),
        currency: z.string().min(3).max(3),
      })
      .strict()
      .optional(),
    scopes: z
      .object({ region: scopeValuesSchema, legal_entity: scopeValuesSchema, department: scopeValuesSchema })
      .strict()
      .optional(),
    includeUntagged: z.boolean().optional(),
    versions: z
      .union([
        z.enum(['current', 'all']),
        z
          .object({ from: z.string().date().optional(), to: z.string().date().optional() })
          .strict()
          .refine((range) => range.from !== undefined || range.to !== undefined, { message: 'versions needs from or to' }),
      ])
      .optional(),
  })
  .strict();

/** D-12: limits of an explicit attributes filter (the contract's AttributeFilter). */
const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_ATTRIBUTE_KEYS = 30;
const MAX_ATTRIBUTE_VALUES = 50;
const MAX_ATTRIBUTE_VALUE_LENGTH = 200;

/** Accepted only while RAG_ATTRIBUTE_FILTER is effectively on; entries are checked by attributeFilterIssues for their paths. */
const retrievalFilterBodyWithAttributesSchema = retrievalFilterBodySchema.extend({ attributes: z.unknown().optional() });

type BodyShape = z.infer<typeof retrievalFilterBodySchema> & { attributes?: Record<string, string[]> };
type ContractFilters = z.infer<typeof RetrievalFiltersSchema>;

const LIST_FIELDS: { body: keyof BodyShape; path: string }[] = [
  { body: 'sources', path: 'sources' },
  { body: 'documentIds', path: 'documentIds' },
  { body: 'docTypes', path: 'docTypes' },
  { body: 'languages', path: 'languages' },
];

function issue(path: string, message: string): { path: string; message: string } {
  return { path, message };
}

/** An empty object or a dimension with an empty list is no filter for that dimension (DATA-18 empty edge). */
function nonEmptyScopes(scopes: BodyShape['scopes']): Partial<Record<ScopeDimension, string[]>> | undefined {
  if (!scopes) return undefined;
  const out: Partial<Record<ScopeDimension, string[]>> = {};
  for (const dimension of SCOPE_DIMENSIONS) {
    const values = scopes[dimension];
    if (values && values.length > 0) out[dimension] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sorted, de-duplicated dimension:value tags, so neither dimension nor value order reaches the request or the cache key. */
function scopeTags(scopes: Partial<Record<ScopeDimension, string[]>>): string[] {
  const tags = new Set<string>();
  for (const dimension of SCOPE_DIMENSIONS) {
    for (const value of scopes[dimension] ?? []) tags.add(`${dimension}:${value}`);
  }
  return [...tags].sort();
}

function attributeFilterIssues(raw: unknown): { path: string; message: string }[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [issue('attributes', 'attributes must be an object')];
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTE_KEYS) return [issue('attributes', `attributes allows at most ${MAX_ATTRIBUTE_KEYS} keys`)];
  const issues: { path: string; message: string }[] = [];
  for (const [key, values] of entries) {
    const path = `attributes.${key}`;
    if (!ATTRIBUTE_KEY.test(key)) {
      issues.push(issue(path, 'attribute key must match ^[a-z][a-z0-9_]{0,39}$'));
      continue;
    }
    if (!Array.isArray(values)) {
      issues.push(issue(path, 'attribute values must be a list'));
      continue;
    }
    if (values.length > MAX_ATTRIBUTE_VALUES) {
      issues.push(issue(path, `an attribute allows at most ${MAX_ATTRIBUTE_VALUES} values`));
      continue;
    }
    values.forEach((value, index) => {
      if (typeof value !== 'string' || value.length === 0 || [...value].length > MAX_ATTRIBUTE_VALUE_LENGTH) {
        issues.push(issue(`${path}.${index}`, `an attribute value is a string of 1 to ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`));
      }
    });
  }
  return issues;
}

/** Keys sorted, values sorted and de-duplicated; a key with an empty list is no filter for it. */
function canonicalAttributes(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(raw as Record<string, string[]>).sort()) {
    const values = [...new Set((raw as Record<string, string[]>)[key])].sort();
    if (values.length > 0) out[key] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function bodyToContract(body: BodyShape): Record<string, unknown> {
  const out: Record<string, unknown> = { current_only: true };
  if (body.attributes) out.attributes = body.attributes;
  const scopes = nonEmptyScopes(body.scopes);
  if (scopes) {
    out.scopes = scopes;
    if (body.includeUntagged === true) out.include_untagged = true;
  }
  if (body.dateRange) out.date_range = { from: body.dateRange.from, to: body.dateRange.to };
  if (body.sources) out.sources = body.sources;
  if (body.documentIds) out.document_ids = body.documentIds;
  if (body.docTypes) out.doc_types = body.docTypes;
  if (body.languages) out.languages = body.languages;
  if (body.versions !== undefined) out.versions = body.versions;
  if (body.invoice) {
    out.invoice = {
      supplier: body.invoice.supplier,
      amount_min: body.invoice.amountMin,
      amount_max: body.invoice.amountMax,
      currency: body.invoice.currency,
    };
  }
  return out;
}

function contractToFilterInput(contract: ContractFilters): RetrievalFilterInput {
  const out: RetrievalFilterInput = {};
  if (contract.attributes && Object.keys(contract.attributes).length > 0) {
    out.attributes = Object.fromEntries(Object.entries(contract.attributes).map(([key, values]) => [key, [...values]]));
  }
  if (contract.date_range) {
    out.dateRange = { from: contract.date_range.from, to: contract.date_range.to };
  }
  if (contract.sources) out.sources = [...contract.sources];
  if (contract.document_ids) out.documentIds = [...contract.document_ids];
  if (contract.doc_types) out.docTypes = [...contract.doc_types];
  if (contract.languages) out.languages = [...contract.languages];
  if (contract.invoice) {
    out.invoice = {
      supplier: contract.invoice.supplier,
      amountMin: Number(contract.invoice.amount_min),
      amountMax: Number(contract.invoice.amount_max),
      currency: contract.invoice.currency,
    };
  }
  if (contract.versions !== undefined && contract.versions !== 'current') {
    const versions = contract.versions;
    out.versionScope =
      versions === 'all'
        ? 'all'
        : { ...(versions.from !== undefined ? { from: versions.from } : {}), ...(versions.to !== undefined ? { to: versions.to } : {}) };
  }
  if (contract.scopes) {
    const tags = scopeTags(contract.scopes);
    if (tags.length > 0) {
      out.scopes = tags;
      if (contract.include_untagged === true) out.scopesIncludeUntagged = true;
    }
  }
  return out;
}

function snakePathToCamel(path: readonly (string | number)[]): string {
  const joined = path.map(String).join('.');
  return joined
    .replace(/^date_range/, 'dateRange')
    .replace(/^document_ids/, 'documentIds')
    .replace(/^doc_types/, 'docTypes')
    .replace(/^amount_min/, 'amountMin')
    .replace(/^amount_max/, 'amountMax')
    .replace(/^include_untagged/, 'includeUntagged');
}

function hasFilterFields(filters: RetrievalFilterInput): boolean {
  return (
    filters.dateRange !== undefined ||
    filters.sources !== undefined ||
    filters.documentIds !== undefined ||
    filters.docTypes !== undefined ||
    filters.languages !== undefined ||
    filters.invoice !== undefined ||
    filters.scopes !== undefined ||
    filters.versionScope !== undefined ||
    filters.attributes !== undefined
  );
}

function effectiveAttributeFilter(): AttributeFilterMode {
  return loadRagConfig(getRagDeps().ragEnv()).v2.attributeFilter;
}

/**
 * D-12, D-30: `attributes` is a recognized key only while RAG_ATTRIBUTE_FILTER is effectively on (`options.attributeFilter`, else the
 * effective switch); while it is off a body carrying it gets today's unrecognized-key answer.
 */
export function parseRetrievalFilters(
  body: unknown,
  options: { attributeFilter?: AttributeFilterMode } = {},
): { ok: true; filters?: RetrievalFilterInput } | { ok: false; details: { path: string; message: string }[] } {
  if (body === undefined) return { ok: true };

  const attributesOn =
    typeof body === 'object' && body !== null && 'attributes' in body && (options.attributeFilter ?? effectiveAttributeFilter()) !== 'off';
  const parsed = (attributesOn ? retrievalFilterBodyWithAttributesSchema : retrievalFilterBodySchema).safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      details: parsed.error.errors.map((e) => {
        if (e.code === 'unrecognized_keys' && 'keys' in e && Array.isArray(e.keys) && e.keys[0]) {
          return issue([...e.path, String(e.keys[0])].join('.'), e.message);
        }
        return issue(e.path.join('.') || 'retrievalFilters', e.message);
      }),
    };
  }

  const data: BodyShape = { ...parsed.data, attributes: undefined };
  if (attributesOn) {
    const raw = (parsed.data as { attributes?: unknown }).attributes;
    const attributeIssues = attributeFilterIssues(raw);
    if (attributeIssues.length > 0) return { ok: false, details: attributeIssues };
    data.attributes = canonicalAttributes(raw);
  }
  if (data.attributes === undefined) delete data.attributes;

  for (const { body: field, path } of LIST_FIELDS) {
    const value = data[field];
    if (Array.isArray(value) && value.length === 0) {
      return { ok: false, details: [issue(path, `${path} must not be an empty list`)] };
    }
  }

  if (data.dateRange && data.dateRange.from > data.dateRange.to) {
    return { ok: false, details: [issue('dateRange', 'dateRange.from must be on or before dateRange.to')] };
  }

  if (data.invoice) {
    const min = Number(data.invoice.amountMin);
    const max = Number(data.invoice.amountMax);
    if (min > max) {
      return {
        ok: false,
        details: [issue('invoice', 'invoice.amountMin must be less than or equal to amountMax')],
      };
    }
  }

  const versions = data.versions;
  if (typeof versions === 'object' && versions.from !== undefined && versions.to !== undefined && versions.from > versions.to) {
    return { ok: false, details: [issue('versions', 'versions.from must be on or before versions.to')] };
  }

  const contractPayload = bodyToContract(data);
  const validated = RetrievalFiltersSchema.safeParse(contractPayload);
  if (!validated.success) {
    return {
      ok: false,
      details: validated.error.errors.map((e) => ({
        path: snakePathToCamel(e.path) || 'retrievalFilters',
        message: e.message,
      })),
    };
  }

  const filters = contractToFilterInput(validated.data);
  if (!hasFilterFields(filters)) return { ok: true };
  return { ok: true, filters };
}

/** An id no document has: an empty intersection of two document lists must match nothing, and an empty list reads as no filter downstream. */
const NO_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

export function buildRetrievalFilters(input: {
  explicit?: RetrievalFilterInput;
  referencedDocumentIds: string[];
  /** From effectiveOnFor, never from the request body. */
  effectiveOn?: string;
  /** D-30: documents the attribute stage resolved; intersected last, an empty result matches nothing. */
  attributeDocumentIds?: readonly string[];
}): RetrievalFilters {
  const explicit = input.explicit ?? {};
  const result: RetrievalFilters = { currentOnly: true };

  if (explicit.dateRange) {
    result.dateRange = { ...explicit.dateRange };
  }
  if (explicit.sources) result.sources = [...explicit.sources];
  if (explicit.docTypes) result.docTypes = [...explicit.docTypes];
  if (explicit.languages) result.languages = [...explicit.languages];
  if (explicit.invoice) result.invoice = { ...explicit.invoice };
  if (explicit.scopes && explicit.scopes.length > 0) {
    result.scopes = [...explicit.scopes];
    if (explicit.scopesIncludeUntagged === true) result.scopesIncludeUntagged = true;
  }

  const explicitIds = explicit.documentIds;
  const referenced = input.referencedDocumentIds;

  if (explicitIds && explicitIds.length > 0 && referenced.length > 0) {
    const refSet = new Set(referenced);
    const narrowed = explicitIds.filter((id) => refSet.has(id));
    result.documentIds = narrowed.length > 0 ? narrowed : [NO_DOCUMENT_ID];
  } else if (referenced.length > 0) {
    result.documentIds = [...referenced];
  } else if (explicitIds && explicitIds.length > 0) {
    result.documentIds = [...explicitIds];
  }

  if (input.attributeDocumentIds !== undefined) {
    const attributeIds = new Set(input.attributeDocumentIds);
    const narrowed = result.documentIds ? result.documentIds.filter((id) => attributeIds.has(id)) : [...input.attributeDocumentIds];
    result.documentIds = narrowed.length > 0 ? narrowed : [NO_DOCUMENT_ID];
  }

  if (input.effectiveOn) result.effectiveOn = input.effectiveOn;
  return result;
}
/** D-44: today's UTC date while RAG_EFFECTIVE_DATES is on; the zone is always UTC, never the server's. */
export function effectiveOnFor(config: { effectiveDates: boolean }, nowMs: number): string | undefined {
  if (!config.effectiveDates) return undefined;
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * D-12, D-40, D-58: the version scope a request actually reads. The request's ask counts only while RAG_VERSION_SCOPE is
 * effective (which already needs the lexical leg); voice always reads current versions, and embed also needs
 * RAG_EMBED_VERSION_SCOPE. `ignored` marks a non-current ask that was not honoured (trace code versions_ignored).
 */
export function effectiveVersionScope(
  config: { v2: { versionScope: boolean; embedVersionScope: boolean } },
  profile: Profile,
  requested: VersionScope | undefined,
  channel?: RunRetrievalInput['channel'],
): { scope: VersionScope; ignored: boolean } {
  if (requested === undefined || requested === 'current') return { scope: 'current', ignored: false };
  const embed = profile === 'embed' || channel === 'embed';
  const allowed = config.v2.versionScope && profile !== 'voice' && (!embed || config.v2.embedVersionScope);
  return allowed ? { scope: requested, ignored: false } : { scope: 'current', ignored: true };
}

export function isCurrentVersionScope(scope: VersionScope | undefined): boolean {
  return scope === undefined || scope === 'current';
}
