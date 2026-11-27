export interface AnswerStructure {
  parts: number;
  cited_parts: number | null;
  uncovered_parts: number;
}

export interface AnswerStructureInput {
  answer: string;
  subQuestionCount: number;
  language: string | null;
  aliases: ReadonlySet<string> | null;
}

export function measureAnswerStructure(_input: AnswerStructureInput): AnswerStructure {
  return { parts: 0, cited_parts: 0, uncovered_parts: 0 };
}
