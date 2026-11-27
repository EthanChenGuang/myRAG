import { z } from 'zod/v3';

export const OUTLINE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const PatternSchema = z.string().min(1).max(400);

const OutlineSectionSchema = z
  .object({
    key: z.string().min(1).max(32),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    pattern: PatternSchema,
  })
  .strict();

const OutlineSchema = z
  .object({
    id: z.string().regex(OUTLINE_ID_PATTERN),
    version: z.number().int().min(1),
    tenant_keys: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
    detect: z
      .object({
        pattern: PatternSchema,
        within_chars: z.number().int().min(1).max(200000),
      })
      .strict(),
    sections: z.array(OutlineSectionSchema).min(1).max(200),
    variant_start: z.string().min(1).max(32),
    variant_label: z.enum(['body', 'title']).default('body'),
    cross_ref_prefixes: z.array(z.string().min(1).max(40)).max(50).optional(),
    toc: z.object({ max_span_chars: z.number().int().min(1).max(20000) }).strict().optional(),
  })
  .strict();

function patternProblem(source: string): string | null {
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, 'iu');
  } catch {
    return 'pattern does not compile';
  }
  return compiled.test('') ? 'pattern matches the empty string' : null;
}

export const SectionOutlineFileSchema = z
  .object({
    schema_version: z.literal(1),
    outlines: z.array(OutlineSchema).min(1).max(50),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.outlines.forEach((outline, index) => {
      if (ids.has(outline.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outlines', index, 'id'], message: 'duplicate outline id' });
      ids.add(outline.id);
      const keys = new Set<string>();
      outline.sections.forEach((section, sectionIndex) => {
        if (keys.has(section.key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outlines', index, 'sections', sectionIndex, 'key'], message: 'duplicate section key' });
        }
        keys.add(section.key);
        const problem = patternProblem(section.pattern);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outlines', index, 'sections', sectionIndex, 'pattern'], message: problem });
      });
      if (!keys.has(outline.variant_start)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outlines', index, 'variant_start'], message: 'variant_start names no section' });
      }
      const detectProblem = patternProblem(outline.detect.pattern);
      if (detectProblem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outlines', index, 'detect', 'pattern'], message: detectProblem });
    });
  });

export type SectionOutlineFile = z.infer<typeof SectionOutlineFileSchema>;

export interface CompiledOutlineSection {
  key: string;
  level: 1 | 2 | 3;
  pattern: RegExp;
}

export interface CompiledOutline {
  id: string;
  version: number;
  /** Lower-cased; null: every tenant. */
  tenantKeys: string[] | null;
  /** Flags `iu`. */
  detect: RegExp;
  withinChars: number;
  /** Patterns with flags `giu`. */
  sections: CompiledOutlineSection[];
  /** Index into sections. */
  variantStart: number;
  variantLabel: 'body' | 'title';
  /** Lower-cased. */
  crossRefPrefixes: string[];
  tocMaxSpanChars: number | null;
}

export type SectionOutlineSet = readonly CompiledOutline[];

export interface SectionOutlineReport {
  outline_id: string;
  version: number;
  /** Variant labels in document order; document text, never logged. */
  variants: string[];
  markers_found: number;
  markers_kept: number;
  markers_dropped: number;
}

export interface SectionOutlineInput {
  outlines: SectionOutlineSet | null;
  tenantKey: string | null;
}
