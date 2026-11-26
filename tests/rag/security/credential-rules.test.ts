import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OutputGuardRulesSchema } from '@/lib/rag-eval/contracts.generated';
import {
  loadOutputGuardRules,
  matchCredentialSentence,
  outputGuardRulesVersion,
} from '@/lib/rag/security/credential-rules';
import * as injectionScan from '@/lib/rag/security/injection-scan';

const RULES_FILE = path.join(process.cwd(), 'config', 'rag', 'output-guard-rules.json');
const LANGUAGES = ['zh', 'en', 'it'] as const;

function tempRules(raw: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'output-guard-rules-'));
  const file = path.join(dir, 'rules.json');
  writeFileSync(file, JSON.stringify(raw, null, 2));
  return file;
}

const REQUESTS: Record<(typeof LANGUAGES)[number], string[]> = {
  en: [
    'Please enter your verification code to continue.',
    'Reply with your password so the account can be confirmed.',
    'ＥＮＴＥＲ ＹＯＵＲ ＶＥＲＩＦＩＣＡＴＩＯＮ ＣＯＤＥ now.',
    'Enter your pass​word here.',
    'What is your one-time code?',
  ],
  zh: ['请输入您的验证码以继续。', '请提供你的密码。', '请输​入验证码。', '请输入ＰＩＮ码。'],
  it: [
    'Inserisci il codice di verifica per continuare.',
    'Inviami la tua password.',
    'INSERISCI IL CODICE DI VERIFICA.',
    'Fornisci le tue credenziali di accesso.',
  ],
};

const MENTIONS: Record<(typeof LANGUAGES)[number], string[]> = {
  en: [
    'The password policy requires twelve characters.',
    'A verification code is sent after the form is saved.',
    'Please enter the date of the report.',
    'Enter your name in the first field.',
    'The spinning wheel shows progress.',
  ],
  zh: ['密码策略要求十二个字符。', '系统会发送验证码。', '请输入报告日期。'],
  it: ['La password deve avere dodici caratteri.', 'Il sistema invia un codice di verifica.', 'Inserisci la data del documento.'],
};

describe('normalise export', () => {
  it('is the shared NFKC normaliser of injection-scan', () => {
    const normalise = (injectionScan as Record<string, unknown>).normalise;
    expect(typeof normalise).toBe('function');
    const fn = normalise as (text: string, invisible: '' | ' ') => string;
    expect(fn('ＡＢ​Ｃ  D', '')).toBe('abc d');
  });
});

describe('loadOutputGuardRules', () => {
  it('loads the committed file through the generated schema with credential rules for zh, en and it', () => {
    const rules = loadOutputGuardRules();
    expect(OutputGuardRulesSchema.parse(rules)).toEqual(rules);
    for (const language of LANGUAGES) {
      expect((rules.credential_rules ?? []).filter((rule) => rule.language === language).length, language).toBeGreaterThan(0);
    }
  });

  it('rejects an invalid file and an obfuscation pattern with a backreference', () => {
    const raw = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
    expect(() => loadOutputGuardRules(tempRules({ ...raw, version: '' }))).toThrow();
    const backref = { ...raw, obfuscation_patterns: [{ id: 'obf.backref', pattern: '^(a)\\1$' }] };
    expect(() => loadOutputGuardRules(tempRules(backref))).toThrow(/back-?reference/i);
    const named = { ...raw, obfuscation_patterns: [{ id: 'obf.named', pattern: '^(?<x>a)\\k<x>$' }] };
    expect(() => loadOutputGuardRules(tempRules(named))).toThrow(/back-?reference/i);
  });
});

describe('outputGuardRulesVersion', () => {
  it('is the first 12 hex characters of the file sha256 and changes with the file', () => {
    expect(outputGuardRulesVersion()).toMatch(/^[a-f0-9]{12}$/);
    expect(outputGuardRulesVersion(RULES_FILE)).toBe(outputGuardRulesVersion());
    const raw = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
    const a = tempRules(raw);
    const b = tempRules({ ...raw, version: `${raw.version}-x` });
    expect(outputGuardRulesVersion(a)).toMatch(/^[a-f0-9]{12}$/);
    expect(outputGuardRulesVersion(a)).not.toBe(outputGuardRulesVersion(b));
  });
});

describe('matchCredentialSentence', () => {
  for (const language of LANGUAGES) {
    for (const sentence of REQUESTS[language]) {
      it(`${language}: matches a request: ${JSON.stringify(sentence)}`, () => {
        expect(matchCredentialSentence(sentence, language).length).toBeGreaterThan(0);
        expect(matchCredentialSentence(sentence).length).toBeGreaterThan(0);
      });
    }
    for (const sentence of MENTIONS[language]) {
      it(`${language}: does not match a mention or a request without a secret: ${JSON.stringify(sentence)}`, () => {
        expect(matchCredentialSentence(sentence, language)).toEqual([]);
        expect(matchCredentialSentence(sentence)).toEqual([]);
      });
    }
  }

  it('returns rule ids of the requested language only when a language is given', () => {
    const ids = matchCredentialSentence('Please enter your verification code.', 'en');
    const rules = loadOutputGuardRules().credential_rules ?? [];
    for (const id of ids) expect(rules.find((rule) => rule.id === id)?.language).toMatch(/^(en|any)$/);
    expect(matchCredentialSentence('Please enter your verification code.', 'zh')).toEqual([]);
  });
});
