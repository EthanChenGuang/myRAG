import { fixedText } from '../lang/texts';
import { parseAnswerMarkers } from './citations/marker-parser';

/** D-12: report-only; never triggers a regeneration. */
export interface AnswerStructure {
  /** Numbered parts 1..subQuestionCount found in the answer. */
  parts: number;
  /** Parts with at least one valid citation marker; null (not measured) when no citation strategy labelled the blocks. */
  cited_parts: number | null;
  /** Parts that state the GEN-08 labels.not_covered text of the answer language. */
  uncovered_parts: number;
}

export interface AnswerStructureInput {
  answer: string;
  subQuestionCount: number;
  language: string | null;
  /** The request's block aliases; null or empty when no citation strategy ran. */
  aliases: ReadonlySet<string> | null;
}

// A part starts a line with its number: optional heading marks or bold, an optional opening bracket, then a terminator.
const PART_START = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[(（]?(\d{1,2})(?:[.)、:：）]|\*\*)(?!\d)/;

function splitParts(answer: string, count: number): string[] {
  const parts: string[] = [];
  const seen = new Set<number>();
  let current: string[] | null = null;
  for (const line of answer.split(/\r?\n/)) {
    const match = PART_START.exec(line);
    const number = match ? Number(match[1]) : NaN;
    if (number >= 1 && number <= count && !seen.has(number)) {
      seen.add(number);
      if (current) parts.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) parts.push(current.join('\n'));
  return parts;
}

export function measureAnswerStructure(input: AnswerStructureInput): AnswerStructure {
  const parts = splitParts(input.answer, Math.max(0, Math.floor(input.subQuestionCount)));
  const aliases = input.aliases && input.aliases.size > 0 ? input.aliases : null;
  const notCovered = fixedText('labels.not_covered', input.language ?? '');
  return {
    parts: parts.length,
    cited_parts: aliases ? parts.filter((part) => parseAnswerMarkers(part, aliases).valid.length > 0).length : null,
    uncovered_parts: parts.filter((part) => part.includes(notCovered)).length,
  };
}
