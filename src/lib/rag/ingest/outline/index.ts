import { loadSectionOutlines } from './load';
import { normalizeWithOutline, type NormalizedOutline } from './normalize';
import type { SectionOutlineInput, SectionOutlineReport } from './schema';

export { compileSectionOutlines, loadSectionOutlines, resetSectionOutlinesForTests } from './load';
export { normalizeWithOutline, type NormalizedOutline } from './normalize';
export {
  OUTLINE_ID_PATTERN,
  SectionOutlineFileSchema,
  type CompiledOutline,
  type CompiledOutlineSection,
  type SectionOutlineFile,
  type SectionOutlineInput,
  type SectionOutlineReport,
  type SectionOutlineSet,
} from './schema';

/** PD-6: the Markdown chunker kinds an outline is tried for. */
export const OUTLINE_CHUNKER_KINDS: ReadonlySet<string> = new Set(['markdown_sections', 'table_aware', 'legal_clauses']);

export function outlineMarkdown(markdown: string, kind: string, input: SectionOutlineInput | null | undefined): NormalizedOutline {
  if (!OUTLINE_CHUNKER_KINDS.has(kind)) return { markdown, report: null };
  return normalizeWithOutline(markdown, input);
}

/** The `metadata.section_outline` value: `<id>@<version>`. */
export function sectionOutlineStamp(report: Pick<SectionOutlineReport, 'outline_id' | 'version'>): string {
  return `${report.outline_id}@${report.version}`;
}

export function sectionOutlineInputFor(filePath: string | null | undefined, tenantKey: string | null): SectionOutlineInput | null {
  const outlines = loadSectionOutlines(filePath);
  return outlines === null ? null : { outlines, tenantKey };
}
