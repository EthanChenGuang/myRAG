import { describe, expect, it } from 'vitest';
import { fixedText } from '@/lib/rag/lang/texts';
import { knowledgeBaseUnavailableMessage, noKnowledgeBaseResponse } from '@/lib/rag/generation/messages';
import { attachedDocumentsSentence, citationInstruction } from '@/lib/rag/generation/citations/instructions';
import { answerQualityStrings } from '@/translations/answer-quality';

// D-10: the English registry values equal today's constants byte for byte; zh and it badge and notice values equal today's
// zh and it strings where they exist. One test per constant.

const STATES = ['verified', 'possibly_unreliable', 'not_checked'] as const;

describe('registry texts equal today\'s constants (D-10, D-12)', () => {
  it('notices.no_information (en) equals the strict refusal', () => {
    expect(fixedText('notices.no_information', 'en')).toBe(noKnowledgeBaseResponse('en'));
  });

  it.each(['en', 'zh', 'it'])('notices.kb_unavailable (%s) equals knowledgeBaseUnavailableMessage', (code) => {
    expect(fixedText('notices.kb_unavailable', code)).toBe(knowledgeBaseUnavailableMessage(code));
  });

  it.each(['en', 'zh', 'it'])('instructions.citation (%s) equals citationInstruction', (code) => {
    expect(fixedText('instructions.citation', code)).toBe(citationInstruction(code));
  });

  it.each(['en', 'zh', 'it'])('instructions.attached_documents (%s) equals attachedDocumentsSentence', (code) => {
    expect(fixedText('instructions.attached_documents', code)).toBe(attachedDocumentsSentence(code));
  });

  it.each(['en', 'zh', 'it'])('notices.document_updated_or_removed (%s) equals documentUpdatedOrRemoved', (code) => {
    expect(fixedText('notices.document_updated_or_removed', code)).toBe(answerQualityStrings(code).documentUpdatedOrRemoved);
  });

  for (const state of STATES) {
    it.each(['en', 'zh', 'it'])(`labels.badge_${state} (%s) equals badgeLabels.${state}`, (code) => {
      expect(fixedText(`labels.badge_${state}`, code)).toBe(answerQualityStrings(code).badgeLabels[state]);
    });

    it.each(['en', 'zh', 'it'])(`labels.badge_tooltip_${state} (%s) equals badgeTooltips.${state}`, (code) => {
      expect(fixedText(`labels.badge_tooltip_${state}`, code)).toBe(answerQualityStrings(code).badgeTooltips[state]);
    });
  }
});
