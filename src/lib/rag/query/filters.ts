import { z } from 'zod/v3';
import type { RetrievalFilterInput, RetrievalFilters, VersionScope } from '@/lib/rag/backend/types';
import type { Profile } from '@/lib/rag/types';
import { RetrievalFiltersSchema } from '@/lib/rag-eval/contracts.generated';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';

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

type BodyShape = z.infer<typeof retrievalFilterBodySchema>;
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

function bodyToContract(body: BodyShape): Record<string, unknown> {
  const out: Record<string, unknown> = { current_only: true };
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
    filters.versionScope !== undefined
  );
}

export function parseRetrievalFilters(
  body: unknown
): { ok: true; filters?: RetrievalFilterInput } | { ok: false; details: { path: string; message: string }[] } {
  if (body === undefined) return { ok: true };

  const parsed = retrievalFilterBodySchema.safeParse(body);
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

  for (const { body: field, path } of LIST_FIELDS) {
    const value = parsed.data[field];
    if (Array.isArray(value) && value.length === 0) {
      return { ok: false, details: [issue(path, `${path} must not be an empty list`)] };
    }
  }

  if (parsed.data.dateRange && parsed.data.dateRange.from > parsed.data.dateRange.to) {
    return { ok: false, details: [issue('dateRange', 'dateRange.from must be on or before dateRange.to')] };
  }

  if (parsed.data.invoice) {
    const min = Number(parsed.data.invoice.amountMin);
    const max = Number(parsed.data.invoice.amountMax);
    if (min > max) {
      return {
        ok: false,
        details: [issue('invoice', 'invoice.amountMin must be less than or equal to amountMax')],
      };
    }
  }

  const versions = parsed.data.versions;
  if (typeof versions === 'object' && versions.from !== undefined && versions.to !== undefined && versions.from > versions.to) {
    return { ok: false, details: [issue('versions', 'versions.from must be on or before versions.to')] };
  }

  const contractPayload = bodyToContract(parsed.data);
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
): { scope: VersionScope; ignored: boolean } {
  if (requested === undefined || requested === 'current') return { scope: 'current', ignored: false };
  const allowed = config.v2.versionScope && profile !== 'voice' && (profile !== 'embed' || config.v2.embedVersionScope);
  return allowed ? { scope: requested, ignored: false } : { scope: 'current', ignored: true };
}

export function isCurrentVersionScope(scope: VersionScope | undefined): boolean {
  return scope === undefined || scope === 'current';
}
