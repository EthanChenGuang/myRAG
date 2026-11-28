import { getLanguageSettings } from '../lang/settings';
import { getLanguagePack, type LanguagePack } from '../lang/registry';
import { fixedText } from '../lang/texts';
import type { ContextBlock } from '../types';

export type DecomposedAnswerBlockRef = Pick<ContextBlock, 'alias' | 'isImage' | 'subQuestionIndexes'>;

export interface DecomposedAnswerInput {
  /** The final QueryPlan's sub-questions, in plan order (indexes match ContextBlock.subQuestionIndexes). */
  subQuestions: readonly string[];
  /** The rewrite gate fired R3_COMPARISON. */
  comparison: boolean;
  /** Sub-questions without a supporting block after rerank and coverage reservation (see uncoveredSubQuestions). */
  uncoveredIndexes: readonly number[];
  /** The final context blocks in render order. */
  blocks: readonly DecomposedAnswerBlockRef[];
  /** The answer language. */
  language: string | null;
  /** A citation strategy labelled the blocks (aliases exist). */
  citationsActive: boolean;
  /**
   * GEN-01 Citations path: the block aliases in the order the documents are attached. When set, a part names its
   * documents by their 1-based position in this list instead of by alias.
   */
  documentOrder?: readonly string[];
}

type QueryLayerTexts = NonNullable<LanguagePack['texts']['query_layer']>;
type BlockTexts = Record<'label' | 'intro' | 'parts' | 'citeOwn' | 'compareOrder', string>;

const FALLBACK_LANGUAGE = 'en';

function blockTexts(texts: QueryLayerTexts | undefined): BlockTexts | null {
  if (!texts) return null;
  const {
    decomposed_answer_block_label: label,
    decomposed_answer_intro: intro,
    decomposed_answer_parts: parts,
    decomposed_answer_cite_own: citeOwn,
    decomposed_answer_compare_order: compareOrder,
  } = texts;
  if (!label || !intro || !parts || !citeOwn || !compareOrder) return null;
  return { label, intro, parts, citeOwn, compareOrder };
}

/** The first of the answer language, the primary language and English whose pack holds every block text. */
function resolvePack(language: string | null): { code: string; pack: LanguagePack; texts: BlockTexts } | null {
  const codes = [language, getLanguageSettings().primary, FALLBACK_LANGUAGE];
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0) continue;
    const pack = getLanguagePack(code);
    const texts = blockTexts(pack?.texts.query_layer);
    if (pack && texts) return { code, pack, texts };
  }
  return null;
}

/** D-12: sub-question indexes in [0, count) that no non-image block carries. */
export function uncoveredSubQuestions(count: number, blocks: readonly DecomposedAnswerBlockRef[]): number[] {
  const covered = new Set<number>();
  for (const block of blocks) {
    if (block.isImage) continue;
    for (const index of block.subQuestionIndexes ?? []) covered.add(index);
  }
  return Array.from({ length: Math.max(0, count) }, (_, index) => index).filter((index) => !covered.has(index));
}

/**
 * 06.2 G2: the fixed texts buildDecomposedAnswerBlock uses for a plan of `count` sub-questions in `language`, joined in one
 * string, or null when it would return null for every input of that plan (fewer than two sub-questions, no pack). The semantic
 * cache folds it into systemPromptHash, so a text change in the language pack also gives a new key.
 */
export function decomposedAnswerTemplate(count: number, language: string | null): string | null {
  if (count < 2) return null;
  const resolved = resolvePack(language);
  if (!resolved) return null;
  const { code, pack, texts } = resolved;
  return [code, texts.label, texts.intro, texts.parts, texts.citeOwn, texts.compareOrder, fixedText('labels.not_covered', code), pack.list_separator].join('\u0000');
}

/** A sub-question is data: one line, whitespace collapsed. */
function dataLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function documentPositions(aliases: readonly string[], order: readonly string[]): string[] {
  const positions = aliases.map((alias) => order.indexOf(alias)).filter((index) => index >= 0);
  return [...new Set(positions)].sort((a, b) => a - b).map((index) => String(index + 1));
}

/**
 * D-11, D-12: the localized per-sub-question instruction, or null for fewer than two sub-questions or when no pack
 * holds the texts (the switch-off behaviour). Every sentence comes from the language pack; an uncovered part carries
 * the GEN-08 labels.not_covered text.
 */
export function buildDecomposedAnswerBlock(input: DecomposedAnswerInput): string | null {
  if (input.subQuestions.length < 2) return null;
  const resolved = resolvePack(input.language);
  if (!resolved) return null;
  const { code, pack, texts } = resolved;
  const uncovered = new Set(input.uncoveredIndexes);
  const notCovered = fixedText('labels.not_covered', code);

  const lines = [texts.label, texts.intro];
  input.subQuestions.forEach((question, index) => {
    const head = `${index + 1}. ${dataLine(question)}`;
    if (uncovered.has(index)) {
      lines.push(`${head} “${notCovered}”`);
      return;
    }
    const aliases = input.citationsActive
      ? [
          ...new Set(
            input.blocks
              .filter((block) => !block.isImage && block.alias && (block.subQuestionIndexes ?? []).includes(index))
              .map((block) => block.alias as string),
          ),
        ]
      : [];
    const refs = input.documentOrder ? documentPositions(aliases, input.documentOrder) : aliases;
    lines.push(refs.length > 0 ? `${head} [${refs.join(pack.list_separator)}]` : head);
  });
  lines.push(texts.parts);
  if (input.citationsActive) lines.push(texts.citeOwn);
  if (input.comparison) lines.push(texts.compareOrder);
  return lines.join('\n');
}
