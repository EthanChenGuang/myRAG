export type AnswerStyle = 'classic' | 'concise';

export const ANSWER_STYLES: readonly AnswerStyle[] = ['classic', 'concise'];

export const CLASSIC_FORMATTING_INSTRUCTION = `Always format your responses using this exact markdown structure:

1. Start with a single clear H1 heading using # (not ##)
2. Use ## for section headings (H2)
3. Use hyphen (-) not bullet character (•) for all bullet points
4. Never use asterisks (**) in headings or section titles
5. Keep whitespace between sections for readability
6. Always end your response with a short paragraph (2-3 sentences) that encourages the user to continue the conversation with you. This should include 2-3 specific follow-up questions the user might want to ask related to the topic.

Example format:
# Main Title

## First Section
- First bullet point
- Second bullet point
- Third bullet point

## Second Section
- First bullet point
- Second bullet point

Would you like to know more about specific aspects of this topic? I can explain how to implement this solution in practice, discuss common challenges you might face, or share some examples of successful applications.

Follow this format consistently for all responses.`;

export const CONCISE_FORMATTING_INSTRUCTION = `Format your responses concisely in markdown:

1. Start with a one-line direct answer to the question.
2. When there is more than one key fact, list them as short bullets in the form "- Label: **value** — detail".
3. Never use markdown headings (#, ##, ### or deeper). When the answer has distinct parts, start each part with a short bold label on its own line, for example **Education**.
4. Use hyphen (-) not bullet character (•) for bullet points.
5. Keep the answer brief: no preamble, no restating the question, no filler.
6. Answer in the same language the user wrote in.
7. Keep the citation rule: when you use information from the documents, include the **Source:** Document Name line.

Example format:
A one-line direct answer.

- Label: **value** — detail
- Label: **value** — detail

**Source:** Document Name`;

export const CONCISE_CTA_INSTRUCTION = `End every response with suggested follow-up questions in exactly this structure:

1. After the answer and its **Source:** line, write a markdown horizontal rule on its own line: ---
2. Below it, list up to 3 follow-up questions, each on its own single short line starting with "↳ ".
3. Phrase each follow-up as the user would ask it, as a question, not as an offer from you.
4. No heading, no intro or outro sentence and no paragraph around the follow-ups: only the --- line and the ↳ lines.

Example:
---
↳ A related question?
↳ Another related question?`;

export const STRICT_CONCISE_FOLLOWUP_ADDENDUM = `Strict knowledge-base mode: every follow-up question must be answerable from the knowledge-base context you were given. Never suggest or offer general knowledge, typical figures, estimates or anything else from outside the provided documents, and never suggest a question the context cannot answer.`;

const warnedValues = new Set<string>();

/** Reads RAG_ANSWER_STYLE. Empty means classic; an unknown value warns once per value and falls back to classic. */
export function resolveAnswerStyle(
  raw: string | undefined | null,
  warn: (message: string) => void = (message) => console.warn(message),
): AnswerStyle {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'classic';
  if ((ANSWER_STYLES as readonly string[]).includes(value)) return value as AnswerStyle;
  if (!warnedValues.has(value)) {
    warnedValues.add(value);
    warn(`[RAG Config] RAG_ANSWER_STYLE="${raw}" is not one of ${ANSWER_STYLES.join(', ')}; using classic.`);
  }
  return 'classic';
}

export function resetAnswerStyleWarningsForTests(): void {
  warnedValues.clear();
}

/** The formatting system instruction. Classic is the historical text byte for byte. */
export function buildFormattingInstruction(style: AnswerStyle): string {
  return style === 'concise' ? CONCISE_FORMATTING_INSTRUCTION : CLASSIC_FORMATTING_INSTRUCTION;
}

/** The concise closing follow-up instruction; strict mode keeps follow-ups inside the knowledge base. */
export function buildConciseCtaInstruction(ragMode: string): string {
  return ragMode === 'strict'
    ? `${CONCISE_CTA_INSTRUCTION}\n\n${STRICT_CONCISE_FOLLOWUP_ADDENDUM}`
    : CONCISE_CTA_INSTRUCTION;
}
