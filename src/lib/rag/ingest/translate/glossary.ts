import { loadRagConfig } from '../../config';
import { getRagDeps } from '../../deps';
import { loadTenantGlossary, type GlossaryPair, type LoadGlossaryOptions } from '../../query/glossary';
import { scopeForStoredTenantKey } from '../../tenant/ingestion-job';

/**
 * Glossary seam for chunk translation (Phase 3.2 D-29), filled by XLG-05 (Phase 6.2 D-14). With RAG_TRANSLATION_GLOSSARY effective (the
 * same query-layer config as the query side) it returns the tenant's TERM translation pairs for one direction and the TERM effective
 * version; otherwise no terms and version `none`, as before. Logs no term.
 */
export interface GlossaryTerm {
  source: string;
  target: string;
}

export interface Glossary {
  /** Stored with every translation as glossary_version, so translations made with an older glossary can be found later. */
  version: string;
  terms: readonly GlossaryTerm[];
  /** D-14: the direction's pairs for the per-chunk check (requiredTranslations, enforceGlossary); absent while the switch is off. */
  pairs?: readonly GlossaryPair[];
}

export interface GlossaryScope {
  tenantKey: string;
}

export const NO_GLOSSARY_VERSION = 'none';

/** The switch is on but the tenant's glossary cannot be read: the run stops and the chunks stay pending, never translated unenforced. */
export class GlossaryUnavailable extends Error {
  constructor() {
    super('[Translation] glossary unavailable');
    this.name = 'GlossaryUnavailable';
  }
}

function glossaryEffective(): boolean {
  try {
    return loadRagConfig(getRagDeps().ragEnv()).queryAdditions.effective.translationGlossary;
  } catch {
    return false;
  }
}

/** The terms the prompt lists for these pairs: one per source surface. */
export function glossaryTerms(pairs: ReadonlyArray<Pick<GlossaryPair, 'sources' | 'target'>>): GlossaryTerm[] {
  return pairs.flatMap((pair) => pair.sources.map((source) => ({ source, target: pair.target })));
}

/** The terms to keep for one tenant and language pair. Throws GlossaryUnavailable only while the switch is effective. */
export async function glossaryFor(scope: GlossaryScope, source: string, target: string, options: LoadGlossaryOptions = {}): Promise<Glossary> {
  if (!glossaryEffective()) return { version: NO_GLOSSARY_VERSION, terms: [] };
  const tenantScope = scopeForStoredTenantKey(scope.tenantKey);
  if (!tenantScope) throw new GlossaryUnavailable();
  const loaded = await loadTenantGlossary(tenantScope, options);
  if (!loaded || loaded.tenantKey !== scope.tenantKey) throw new GlossaryUnavailable();
  const pairs = loaded.pairs.filter((pair) => pair.sourceLanguage === source && pair.targetLanguage === target && pair.target.trim() !== '');
  return { version: loaded.version, terms: glossaryTerms(pairs), pairs };
}
