import { describe, expect, it } from 'vitest';

import { getLanguageRegistry, packText, TEXT_KEYS } from '@/lib/rag/lang/registry';
import { matchCredentialSentence } from '@/lib/rag/security/credential-rules';
import { createOutputLinkPolicy } from '@/lib/rag/security/link-targets';
import { guardWholeText, type OutputGuardPolicy } from '@/lib/rag/security/output-guard';

// RESEARCH Pitfall 23 / UI-SPEC finding 8: the server's own texts must never be removed or blocked by its own guard.

const GROUPS = ['notices', 'labels', 'instructions'];

function policy(flaggedContext: boolean): OutputGuardPolicy {
  return {
    mode: 'enforce',
    placeholder: '(placeholder)',
    credentialBlocked: '(blocked)',
    flaggedContext,
    links: createOutputLinkPolicy({ allowlistValue: '', siteUrl: '' }),
  };
}

const entries = getLanguageRegistry().packs.flatMap((pack) =>
  TEXT_KEYS.filter((key) => GROUPS.includes(key.split('.')[0] as string)).flatMap((key) => {
    const text = packText(pack, key);
    return text === null ? [] : [{ language: pack.code, key, text }];
  }),
);

describe('registry texts pass the output guard', () => {
  it('scans every notices, labels and instructions text of every pack', () => {
    for (const pack of getLanguageRegistry().packs) {
      expect(entries.filter((entry) => entry.language === pack.code).length, pack.code).toBeGreaterThan(0);
    }
    expect(entries.some((entry) => entry.key === 'notices.credential_request_blocked')).toBe(true);
  });

  for (const entry of entries) {
    it(`${entry.language} ${entry.key}`, () => {
      for (const flagged of [false, true]) {
        const result = guardWholeText(entry.text, policy(flagged));
        expect(result.text).toBe(entry.text);
        expect(result.summary.links_removed).toBe(0);
        expect(result.summary.credential_blocked).toBe(0);
        expect(result.summary.credential_warned).toBe(0);
      }
      expect(matchCredentialSentence(entry.text)).toEqual([]);
      expect(matchCredentialSentence(entry.text, entry.language)).toEqual([]);
    });
  }
});
