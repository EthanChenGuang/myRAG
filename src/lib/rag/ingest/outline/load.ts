import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SectionOutlineFileSchema, type CompiledOutline, type SectionOutlineSet } from './schema';

type FailureReason = 'unreadable' | 'invalid_json' | 'invalid_schema';

class OutlineFileError extends Error {
  readonly reason: FailureReason;
  readonly issuePaths: string[];

  constructor(reason: FailureReason, issuePaths: string[] = []) {
    super(`[RAG Outline] ${reason}`);
    this.name = 'OutlineFileError';
    this.reason = reason;
    this.issuePaths = issuePaths;
  }
}

const cache = new Map<string, SectionOutlineSet | null>();

/** Validates and compiles the parsed outline file; throws on invalid input. */
export function compileSectionOutlines(raw: unknown): SectionOutlineSet {
  const parsed = SectionOutlineFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OutlineFileError(
      'invalid_schema',
      parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    );
  }
  return parsed.data.outlines.map(
    (outline): CompiledOutline => ({
      id: outline.id,
      version: outline.version,
      tenantKeys: outline.tenant_keys ? outline.tenant_keys.map((key) => key.toLowerCase()) : null,
      detect: new RegExp(outline.detect.pattern, 'iu'),
      withinChars: outline.detect.within_chars,
      sections: outline.sections.map((section) => ({ key: section.key, level: section.level, pattern: new RegExp(section.pattern, 'giu') })),
      variantStart: outline.sections.findIndex((section) => section.key === outline.variant_start),
      variantLabel: outline.variant_label,
      crossRefPrefixes: (outline.cross_ref_prefixes ?? []).map((prefix) => prefix.toLowerCase()),
      tocMaxSpanChars: outline.toc ? outline.toc.max_span_chars : null,
    }),
  );
}

function readOutlineFile(resolved: string): SectionOutlineSet {
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    throw new OutlineFileError('unreadable');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OutlineFileError('invalid_json');
  }
  return compileSectionOutlines(raw);
}

/**
 * RAG_SECTION_OUTLINES: the compiled outlines of the file, cached per resolved path for the life of the process. An empty path is off;
 * a file that cannot be used is off with one warning per path. Never throws.
 */
export function loadSectionOutlines(filePath: string | null | undefined): SectionOutlineSet | null {
  const trimmed = (filePath ?? '').trim();
  if (trimmed === '') return null;
  const resolved = path.resolve(process.cwd(), trimmed);
  if (cache.has(resolved)) return cache.get(resolved) ?? null;
  let outlines: SectionOutlineSet | null;
  try {
    outlines = readOutlineFile(resolved);
  } catch (error) {
    const reason: FailureReason = error instanceof OutlineFileError ? error.reason : 'invalid_schema';
    const issues = error instanceof OutlineFileError ? error.issuePaths : [];
    console.warn('[RAG Outline] outline file ignored', { path: resolved, reason, issues });
    outlines = null;
  }
  cache.set(resolved, outlines);
  return outlines;
}

export function resetSectionOutlinesForTests(): void {
  cache.clear();
}
