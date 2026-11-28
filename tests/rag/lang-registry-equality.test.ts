import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLanguageRegistry, type LanguageRegistry } from '@/lib/rag/lang/registry';
import { ENGLISH_POSSESSIVE, LEXICAL_VERSION, lexicalTokens } from '@/lib/rag/lexical/tokenize';
import lexicalRules from '@/lib/rag/lexical/rules.json';
import rewriteGateLexicon from '@/lib/rag/query/rewrite-gate.lexicon.json';
import { knowledgeBaseUnavailableMessage, noKnowledgeBaseResponse } from '@/lib/rag/generation/messages';
import { attachedDocumentsSentence, citationInstruction } from '@/lib/rag/generation/citations/instructions';
import { answerQualityStrings } from '@/translations/answer-quality';

// D-05: the tokenizer (Phase 4.2) and the refusal texts (Phase 5.2) do not read the registry yet;
// these checks keep each consumer and the registry in step until they do.

const ROOT = path.resolve(__dirname, '..', '..');
const shippedRaw = (): { packs: Array<Record<string, unknown>> } =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rag', 'language-packs.json'), 'utf8'));

type Pack = LanguageRegistry['packs'][number];

const LEXICAL_STOPWORDS = lexicalRules.stopwords as Record<string, string[]>;
// Rules the rewrite gate reads per language; elliptical_leading and stopwords exist for en and it only.
const GATE_RULES = ['pronouns', 'relative_time', 'comparison', 'elliptical', 'compound', 'vague', 'small_talk', 'question_markers', 'first_person'] as const;

const canonical = (value: unknown): unknown =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : value;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** One check per consumer; each returns the codes whose pack disagrees with that consumer's current constant. */
const CONSUMERS: Record<string, (packs: Pack[]) => string[]> = {
  'tokenizer lexical stopwords': (packs) =>
    packs.filter((pack) => !same(pack.stopwords.lexical, LEXICAL_STOPWORDS[pack.code])).map((p) => p.code),
  'tokenizer folding': (packs) => {
    const prefixes = packs.flatMap((pack) => pack.folding.elision_prefixes);
    const suffixes = packs.flatMap((pack) => pack.folding.elision_suffixes);
    const bad = packs.filter((pack) => !pack.folding.accents).map((p) => p.code);
    if (!same(prefixes, lexicalRules.elisionPrefixes)) bad.push('elision_prefixes');
    if (!same(suffixes.map((suffix) => `${suffix}\\b`), [ENGLISH_POSSESSIVE.source])) bad.push('elision_suffixes');
    return bad;
  },
  'strict_refusal text': (packs) =>
    packs.filter((pack) => pack.texts.strict_refusal !== noKnowledgeBaseResponse(pack.code)).map((p) => p.code),
  'knowledge base unavailable notice': (packs) =>
    packs.filter((pack) => pack.texts.knowledge_base_unavailable !== knowledgeBaseUnavailableMessage(pack.code)).map((p) => p.code),
  'citation notices': (packs) =>
    packs
      .filter(
        (pack) =>
          pack.texts.citation_instruction !== citationInstruction(pack.code) ||
          pack.texts.attached_documents !== attachedDocumentsSentence(pack.code),
      )
      .map((p) => p.code),
  'groundedness badge texts': (packs) =>
    packs
      .filter((pack) => {
        const strings = answerQualityStrings(pack.code);
        return !same(pack.texts.groundedness_badges, strings.badgeLabels) || !same(pack.texts.groundedness_tooltips, strings.badgeTooltips);
      })
      .map((p) => p.code),
  'rewrite-gate lexicon key': (packs) =>
    packs
      .filter((pack) => {
        const key = pack.rewrite_gate_lexicon;
        return key === null || GATE_RULES.some((rule) => !Object.prototype.hasOwnProperty.call(rewriteGateLexicon[rule], key));
      })
      .map((p) => p.code),
};

const shipped = parseLanguageRegistry(shippedRaw()).packs;

describe('registry equals the current constants, one check per consumer', () => {
  it.each(Object.keys(CONSUMERS))('%s', (consumer) => {
    expect(CONSUMERS[consumer]!(shipped)).toEqual([]);
  });

  it('zh detection has no stopword list: detect.ts decides zh by Han share', () => {
    expect(shipped.find((pack) => pack.code === 'zh')?.stopwords.detection).toEqual([]);
  });

  it('the tokenizer folds accents for every language and LEXICAL_VERSION is not bumped', () => {
    expect(lexicalTokens('Città perché')).toEqual(['citta', 'perche']);
    expect(LEXICAL_VERSION).toBe(2);
  });

  it('changing one detection stopword fails no consumer check: detect.ts reads the registry (03.2-10)', () => {
    const raw = shippedRaw();
    const italian = raw.packs.find((pack) => pack.code === 'it') as { stopwords: { detection: string[] } };
    italian.stopwords.detection = [...italian.stopwords.detection.slice(1), 'parolanuova'];
    const drifted = parseLanguageRegistry(raw).packs;
    const failing = Object.entries(CONSUMERS)
      .filter(([, check]) => check(drifted).length > 0)
      .map(([name]) => name);
    expect(failing).toEqual([]);
  });
});
