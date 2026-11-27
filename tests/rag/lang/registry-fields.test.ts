import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { calcIntentTermsFor, numberFormatFor } from '@/lib/rag/lang/registry-fields';
import { resetLanguageRegistryForTests, setLanguageRegistryForTests } from '@/lib/rag/lang/registry';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { fixedText, MissingTextParameterError } from '@/lib/rag/lang/texts';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'config', 'rag', 'language-packs.json');
const raw = (): { packs: Array<Record<string, any>> } => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

const savedPrimary = process.env.RAG_PRIMARY_LANGUAGE;
const savedSupported = process.env.RAG_SUPPORTED_LANGUAGES;

function setLanguages(supported: string | undefined, primary: string | undefined): void {
  if (supported === undefined) delete process.env.RAG_SUPPORTED_LANGUAGES;
  else process.env.RAG_SUPPORTED_LANGUAGES = supported;
  if (primary === undefined) delete process.env.RAG_PRIMARY_LANGUAGE;
  else process.env.RAG_PRIMARY_LANGUAGE = primary;
  resetLanguageSettingsForTests();
}

afterEach(() => {
  setLanguages(savedSupported, savedPrimary);
  resetLanguageRegistryForTests();
});

describe('numberFormatFor (D-74)', () => {
  it('reads each pack from the registry', () => {
    expect(numberFormatFor('it').decimal_marks).toEqual([',']);
    expect(numberFormatFor('it').group_separators).toContain('.');
    expect(numberFormatFor('en').decimal_marks).toEqual(['.']);
    expect(numberFormatFor('zh').fullwidth_digits).toBe(true);
    expect(numberFormatFor('zh').magnitude_words).toContainEqual({ word: '万', power: 4 });
  });

  it.each(['es', '__proto__', 'constructor', ''])('falls back to the primary language for %j, as fixedText does', (code) => {
    setLanguages('zh,en,it', 'it');
    expect(numberFormatFor(code)).toEqual(numberFormatFor('it'));
    expect(numberFormatFor(code).decimal_marks).toEqual([',']);
  });

  it('falls back to English while the languages are not configured', () => {
    setLanguages(undefined, undefined);
    expect(numberFormatFor('es')).toEqual(numberFormatFor('en'));
  });

  it('reads a replaced registry', () => {
    const registry = raw();
    registry.packs.find((pack) => pack.code === 'en')!.number_format.decimal_marks = ['·'];
    setLanguageRegistryForTests(registry);
    expect(numberFormatFor('en').decimal_marks).toEqual(['·']);
  });
});

describe('calcIntentTermsFor (D-70)', () => {
  it('returns the case-folded, deduplicated terms of the pack', () => {
    const terms = calcIntentTermsFor('en');
    expect(terms).toContain('how many');
    expect(terms).toContain('in total');
    expect(terms.every((term) => term === term.toLowerCase())).toBe(true);
    const registry = raw();
    registry.packs.find((pack) => pack.code === 'en')!.calc_intent_terms = ['Total', 'IN TOTAL'];
    setLanguageRegistryForTests(registry);
    expect(calcIntentTermsFor('en')).toEqual(['total', 'in total']);
  });

  it('falls back the way fixedText does', () => {
    setLanguages('zh,en,it', 'zh');
    expect(calcIntentTermsFor('es')).toEqual(calcIntentTermsFor('zh'));
  });

  it('holds no digit in any shipped term', () => {
    for (const code of ['zh', 'en', 'it']) {
      expect(calcIntentTermsFor(code).length).toBeGreaterThan(0);
      for (const term of calcIntentTermsFor(code)) expect(term, `${code}: ${term}`).not.toMatch(/\d/u);
    }
  });
});

describe('trailing-block tag (D-72)', () => {
  it('is a fixed ASCII tag pair', () => {
    expect(CALC_BLOCK_OPEN).toBe('<calc_trace>');
    expect(CALC_BLOCK_CLOSE).toBe('</calc_trace>');
    for (const tag of [CALC_BLOCK_OPEN, CALC_BLOCK_CLOSE]) expect(tag).toMatch(/^[\x21-\x7e]+$/);
  });

  it('holds nothing the guard treats as a link start and differs from the Phase 5.2 sentinel', () => {
    for (const tag of [CALC_BLOCK_OPEN, CALC_BLOCK_CLOSE]) {
      expect(tag).not.toMatch(/\[|\]\(|https?:|www\.|:\/\/|\.[a-z]{2,}/i);
      expect(tag).not.toBe(NO_ANSWER_SENTINEL);
      expect(NO_ANSWER_SENTINEL).not.toContain(tag);
    }
  });

  it('fills the calculation_block instruction in every language', () => {
    for (const code of ['zh', 'en', 'it']) {
      const text = fixedText('instructions.calculation_block', code, { open: CALC_BLOCK_OPEN, close: CALC_BLOCK_CLOSE });
      expect(text).toContain(CALC_BLOCK_OPEN);
      expect(text).toContain(CALC_BLOCK_CLOSE);
      expect(text.indexOf(CALC_BLOCK_OPEN)).toBeLessThan(text.indexOf(CALC_BLOCK_CLOSE));
    }
  });

  it('throws without the tag parameters, as fixedText does for a missing parameter', () => {
    expect(() => fixedText('instructions.calculation_block', 'en')).toThrow(MissingTextParameterError);
    expect(() => fixedText('instructions.calculation_block', 'en', { open: CALC_BLOCK_OPEN })).toThrow(MissingTextParameterError);
  });

  it('is defined once and the readers hold no per-language table', () => {
    const block = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rag', 'calc', 'block-tag.ts'), 'utf8');
    const fields = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rag', 'lang', 'registry-fields.ts'), 'utf8');
    for (const source of [block, fields]) {
      expect(source).not.toMatch(/['"](?:zh|en|it)['"]\s*:/);
      expect(source).not.toMatch(/process\.env/);
    }
    expect(fields).toMatch(/getLanguagePack/);
  });
});
