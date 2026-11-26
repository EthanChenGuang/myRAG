/** Glossary seam for chunk translation (D-29). XLG-05 (Phase 6.2) fills it; until then it returns no terms. */
export interface GlossaryTerm {
  source: string;
  target: string;
}

export interface Glossary {
  /** Stored with every translation as glossary_version, so translations made with an older glossary can be found later. */
  version: string;
  terms: readonly GlossaryTerm[];
}

export interface GlossaryScope {
  tenantKey: string;
}

export const NO_GLOSSARY_VERSION = 'none';

/** The terms to keep for one tenant and language pair. Returns no terms, version `none`, until XLG-05. */
export async function glossaryFor(_scope: GlossaryScope, _source: string, _target: string): Promise<Glossary> {
  return { version: NO_GLOSSARY_VERSION, terms: [] };
}
