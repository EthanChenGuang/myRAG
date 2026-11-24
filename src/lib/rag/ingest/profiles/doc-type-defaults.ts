import { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../../tenant/scope';
import { loadIngestConfig } from '../config';
import { getIngestDeps } from '../deps';
import {
  getDocTypeDefaults,
  resolvePickerDefault as resolveDefault,
  setDocTypeDefault as setDefault,
  type DocTypeDefaultRow,
  type DocTypeDefaultsDeps,
  type DocTypeDefaultsSelector,
  type PickerDefault,
  type SetDocTypeDefaultInput,
} from './resolve-doc-type';

export { DOC_TYPE_DEFAULT_SOURCE_KINDS, DocTypeDefaultsError } from './resolve-doc-type';
export type { DocTypeChoice, DocTypeDefaultRow, DocTypeDefaultSourceKind, DocTypeDefaultsSelector, PickerDefault, SetDocTypeDefaultInput } from './resolve-doc-type';

/** The six document type identifiers (D-12), from the generated profile schema. */
export const DOC_TYPE_IDS = ProcessingProfileSetSchema.shape.profiles.element.shape.doc_type.options;
/** What a default may be: a type or auto-detect. */
export const DOC_TYPE_CHOICES = [...DOC_TYPE_IDS, 'auto'] as const;

export interface DocTypeDefaultsCallOptions {
  signal: AbortSignal;
}

function depsOf(options: DocTypeDefaultsCallOptions): DocTypeDefaultsDeps {
  return { db: getIngestDeps().db, signal: options.signal };
}

/** The picker exists only under the unified pipeline: under legacy it stays hidden and nothing about uploads changes (D-17). */
export function docTypePickerEnabled(): boolean {
  return loadIngestConfig(getIngestDeps().ingestEnv()).pipeline === 'unified';
}

/** The type the picker pre-selects for the caller's tenant and source (D-15 steps 2 to 6; auto stays auto). */
export function resolvePickerDefault(scope: TenantScope, selector: DocTypeDefaultsSelector, options: DocTypeDefaultsCallOptions): Promise<PickerDefault> {
  return resolveDefault(scope, selector, depsOf(options));
}

/** Every default row of the caller's tenant, for the admin list. */
export function listDocTypeDefaults(scope: TenantScope, options: DocTypeDefaultsCallOptions): Promise<DocTypeDefaultRow[]> {
  return getDocTypeDefaults(scope, undefined, depsOf(options));
}

/** Creates or replaces one default of the caller's tenant. Only a route that passed the admin guard may call it; updatedBy is that admin's id. */
export function setDocTypeDefault(scope: TenantScope, input: SetDocTypeDefaultInput, options: DocTypeDefaultsCallOptions): Promise<DocTypeDefaultRow> {
  return setDefault(scope, input, depsOf(options));
}
