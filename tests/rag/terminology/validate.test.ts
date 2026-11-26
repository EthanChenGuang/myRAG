import { describe, expect, it } from 'vitest';
import type { TerminologyEntry, TerminologyValidationIssue } from '@/lib/rag-eval/contracts.generated';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { validateEntries, type TerminologyValidationContext } from '@/lib/rag/terminology/validate';

const LANGS = getLanguageRegistry().packs.map((pack) => pack.code);
const [L1, L2] = [LANGS[0]!, LANGS[1]!];

let nextId = 0;
function uuid(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`;
}

function entry(canonical: string, variants: string[], extra: Partial<TerminologyEntry> = {}): TerminologyEntry {
  return {
    id: uuid(),
    layer: 'shared',
    canonical,
    variants,
    language: L1 as TerminologyEntry['language'],
    kind: 'synonym',
    mode: 'one_way',
    enabled: true,
    note: null,
    source_language: null,
    target_language: null,
    suppresses_entry_id: null,
    ...extra,
  };
}

function pair(source: string, target: string, extra: Partial<TerminologyEntry> = {}): TerminologyEntry {
  return entry(target, [source], {
    kind: 'translation',
    language: L1 as TerminologyEntry['language'],
    source_language: L1 as TerminologyEntry['source_language'],
    target_language: L2 as TerminologyEntry['target_language'],
    ...extra,
  });
}

function ctx(extra: Partial<TerminologyValidationContext> = {}): TerminologyValidationContext {
  return { layer: 'shared', current: [], enabledLanguages: LANGS, ...extra };
}

function codes(issues: TerminologyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function errors(issues: TerminologyValidationIssue[]): string[] {
  return codes(issues.filter((issue) => issue.severity === 'error'));
}

describe('validateEntries: conflicts, chains and cycles (D-24 rules 1 to 3, 6)', () => {
  it('reports a variant under two canonicals in one language as a conflict naming both ids', () => {
    const a = entry('term gamma delta', ['alpha beta']);
    const b = entry('termine alfa beta', ['Alpha  Beta']);
    const issues = validateEntries([a, b], ctx());
    const conflict = issues.find((issue) => issue.code === 'conflict');
    expect(conflict?.severity).toBe('error');
    expect(conflict?.entry_ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('allows the same variant in two different languages', () => {
    const a = entry('term gamma delta', ['alpha beta']);
    const b = entry('termine alfa beta', ['alpha beta'], { language: L2 as TerminologyEntry['language'] });
    expect(validateEntries([a, b], ctx())).toEqual([]);
  });

  it('lets language any collide with every language', () => {
    const a = entry('term gamma delta', ['alpha beta']);
    const b = entry('termine alfa beta', ['alpha beta'], { language: 'any' });
    expect(errors(validateEntries([a, b], ctx()))).toContain('conflict');
  });

  it('checks candidates against the current layer', () => {
    const existing = entry('term gamma delta', ['alpha beta']);
    const candidate = entry('termine alfa beta', ['alpha beta']);
    const issues = validateEntries([candidate], ctx({ current: [existing] }));
    expect(errors(issues)).toEqual(['conflict']);
    expect(issues[0]!.row).toBe(1);
  });

  it('treats a candidate with the id of a current entry as its replacement', () => {
    const existing = entry('term gamma delta', ['alpha beta']);
    const edited = { ...existing, canonical: 'termine alfa beta' };
    expect(validateEntries([edited], ctx({ current: [existing] }))).toEqual([]);
  });

  it('reports a chain when a variant is the canonical of another entry', () => {
    const a = entry('term gamma delta', ['alpha beta']);
    const b = entry('alpha beta', ['termalpha']);
    expect(errors(validateEntries([a, b], ctx()))).toContain('chain');
  });

  it('reports a cycle through canonicals and variants', () => {
    const a = entry('alpha beta', ['term gamma delta']);
    const b = entry('term gamma delta', ['voce alfa']);
    const c = entry('voce alfa', ['alpha beta']);
    const issues = validateEntries([a, b, c], ctx());
    const cycle = issues.filter((issue) => issue.code === 'cycle');
    expect(cycle).toHaveLength(1);
    expect(cycle[0]!.entry_ids).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
  });

  it('reports overlapping equivalent sets as a conflict', () => {
    const a = entry('term gamma delta', ['alpha beta'], { mode: 'equivalent' });
    const b = entry('term gamma delta', ['voce alfa'], { mode: 'equivalent' });
    expect(errors(validateEntries([a, b], ctx()))).toContain('conflict');
  });

  it('ignores disabled entries for cross-entry rules', () => {
    const a = entry('term gamma delta', ['alpha beta']);
    const b = entry('termine alfa beta', ['alpha beta'], { enabled: false });
    expect(validateEntries([a, b], ctx())).toEqual([]);
  });
});

describe('validateEntries: entry rules (D-24 rules 4, 5 and limits)', () => {
  it('warns about a variant equal to its canonical', () => {
    const issues = validateEntries([entry('term alpha beta', ['Term Alpha Beta', 'termalpha'])], ctx());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'duplicate', severity: 'warning', row: 1 });
  });

  it.each([
    ['a one-character Han variant', '甲'],
    ['a stopword-only variant', 'the of'],
    ['a punctuation-only variant', '?!—'],
  ])('rejects %s', (_label, variant) => {
    const stop = variant === 'the of' ? entry('term alpha beta', [variant], { language: 'any' }) : entry('术语甲乙丙', [variant]);
    expect(errors(validateEntries([stop], ctx()))).toEqual(['invalid_variant']);
  });

  it('accepts a two-character Han variant', () => {
    expect(validateEntries([entry('术语甲乙丙', ['术语'])], ctx())).toEqual([]);
  });

  it('rejects more than 16 variants', () => {
    const variants = Array.from({ length: 17 }, (_, index) => `termalpha${index + 10}`);
    expect(errors(validateEntries([entry('term alpha beta', variants)], ctx()))).toContain('limit');
  });

  it('rejects a variant longer than 64 characters', () => {
    expect(errors(validateEntries([entry('term alpha beta', ['alpha'.repeat(13)])], ctx()))).toContain('limit');
  });

  it('never throws on malformed input', () => {
    const broken = { canonical: 42, variants: 'alpha', language: null } as unknown as TerminologyEntry;
    expect(() => validateEntries([broken], ctx())).not.toThrow();
    expect(validateEntries([broken], ctx()).length).toBeGreaterThan(0);
  });
});

describe('validateEntries: workspace overrides', () => {
  it('reports a workspace entry colliding with a shared entry as an override warning', () => {
    const shared = entry('term gamma delta', ['alpha beta']);
    const mine = entry('termine alfa beta', ['alpha beta'], { layer: 'workspace' });
    const issues = validateEntries([mine], ctx({ layer: 'workspace', shared: [shared] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'override', severity: 'warning' });
    expect(issues[0]!.entry_ids).toEqual(expect.arrayContaining([shared.id, mine.id]));
  });
});

describe('validateEntries: languages and translation pairs (D-24 rules 7 to 9, D-32, D-35)', () => {
  it('rejects a language that is not enabled', () => {
    const issues = validateEntries([entry('term alpha beta', ['termalpha'], { language: L2 as TerminologyEntry['language'] })], ctx({ enabledLanguages: [L1] }));
    expect(errors(issues)).toEqual(['invalid_language']);
  });

  it('accepts language any for every kind except translation', () => {
    for (const kind of ['synonym', 'abbreviation', 'alias', 'identifier', 'misspelling'] as const) {
      const variant = kind === 'identifier' ? 'AB-1234-C' : 'termalpha';
      expect(validateEntries([entry('term alpha beta', [variant], { kind, language: 'any' })], ctx())).toEqual([]);
    }
    expect(errors(validateEntries([pair('术语甲乙丙', 'termalpha', { language: 'any' })], ctx()))).toContain('invalid_translation');
  });

  it('accepts a valid translation pair', () => {
    expect(validateEntries([pair('术语甲乙丙', 'termalpha')], ctx())).toEqual([]);
  });

  it.each<[string, Partial<TerminologyEntry>]>([
    ['target missing', { target_language: null }],
    ['source equal to target', { target_language: L1 as TerminologyEntry['target_language'] }],
    ['language different from source', { language: L2 as TerminologyEntry['language'] }],
    ['mode equivalent', { mode: 'equivalent' }],
  ])('rejects a translation pair with %s', (_label, extra) => {
    expect(errors(validateEntries([pair('术语甲乙丙', 'termalpha', extra)], ctx()))).toContain('invalid_translation');
  });

  it('rejects source_language set on a synonym', () => {
    const synonym = entry('term alpha beta', ['termalpha'], { source_language: L1 as TerminologyEntry['source_language'] });
    expect(errors(validateEntries([synonym], ctx()))).toEqual(['invalid_translation']);
  });

  it('rejects a translation language that is not enabled', () => {
    expect(errors(validateEntries([pair('术语甲乙丙', 'termalpha')], ctx({ enabledLanguages: [L1] })))).toContain('invalid_language');
  });

  it('keeps translation pairs out of same-language chains and conflicts', () => {
    const synonym = entry('术语甲乙丙', ['术语甲']);
    const translation = pair('术语甲乙丙', 'termalpha');
    const sameVariant = pair('术语甲', 'term alpha beta');
    expect(validateEntries([synonym, translation, sameVariant], ctx())).toEqual([]);
  });

  it('reports two targets for one source and language pair as a conflict', () => {
    const a = pair('术语甲乙丙', 'termalpha');
    const b = pair('术语甲乙丙', 'term alpha beta');
    const issues = validateEntries([a, b], ctx());
    expect(errors(issues)).toEqual(['conflict']);
    expect(issues[0]!.entry_ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('allows one source term with two different target languages', () => {
    if (LANGS.length < 3) return;
    const a = pair('术语甲乙丙', 'termalpha');
    const b = pair('术语甲乙丙', 'voce alfa', { target_language: LANGS[2] as TerminologyEntry['target_language'] });
    expect(validateEntries([a, b], ctx())).toEqual([]);
  });

  it('rejects every translation pair when one language is enabled', () => {
    for (const target of LANGS) {
      const candidate = pair('术语甲乙丙', 'termalpha', { target_language: target as TerminologyEntry['target_language'] });
      expect(errors(validateEntries([candidate], ctx({ enabledLanguages: [L1] }))).length).toBeGreaterThan(0);
    }
  });
});

describe('validateEntries: determinism and scale', () => {
  it('sorts issues by row then code and returns the same result twice', () => {
    const list = [entry('term gamma delta', ['alpha beta']), entry('termine alfa beta', ['alpha beta', '甲']), entry('alpha beta', ['termalpha'])];
    const first = validateEntries(list, ctx());
    expect(validateEntries(list, ctx())).toEqual(first);
    const keys = first.map((issue) => [issue.row ?? Number.MAX_SAFE_INTEGER, issue.code] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
  });

  it('validates 5,000 entries in under 500 ms', () => {
    const list = Array.from({ length: 5000 }, (_, index) => entry(`term alpha beta ${index}`, [`termalpha ${index}`, `alpha beta ${index}`]));
    // Warm up once, then keep the best of three runs: one slow run on a loaded CI runner is noise,
    // while a quadratic validator misses the bound on every run.
    expect(validateEntries(list, ctx())).toEqual([]);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      const issues = validateEntries(list, ctx());
      best = Math.min(best, performance.now() - started);
      expect(issues).toEqual([]);
    }
    expect(best).toBeLessThan(500);
  });
});
