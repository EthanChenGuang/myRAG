import { describe, expect, it } from 'vitest';

import tldSnapshot from '../../../config/rag/tld-snapshot.json';
import rawRules from '../../../config/rag/output-guard-rules.json';
import { OutputGuardRulesSchema } from '@/lib/rag-eval/contracts.generated';
import {
  classifyCandidate,
  createOutputLinkPolicy,
  isLinkAllowed,
  isPublicTld,
  normalizeHost,
} from '@/lib/rag/security/link-targets';

const policy = createOutputLinkPolicy({
  allowlistValue: 'allowed.test',
  siteUrl: 'https://app.example',
  webResultUrls: [
    { url: 'https://web.example/result-a', flagged: false },
    { url: 'https://flagged.example/result-b', flagged: true },
  ],
  serverUrls: ['https://files.example/document-a.pdf'],
  imageHosts: { supabaseHost: 'store.example', logoHosts: [] },
  userMessage: 'Please compare https://user.example/page and contact person@user.example today.',
  documentNames: ['document-a.md', 'Notes v2.zip'],
});

describe('data files', () => {
  it('records the IANA version line and lower-case top-level domains', () => {
    expect(tldSnapshot.version).toMatch(/^Version \d{10}/);
    expect(tldSnapshot.tlds.length).toBeGreaterThan(1000);
    expect(tldSnapshot.tlds.every((tld: string) => tld === tld.toLowerCase())).toBe(true);
  });

  it('validates the output-guard rules against the generated contract', () => {
    const rules = OutputGuardRulesSchema.parse(rawRules);
    expect(rules.opaque_schemes).toEqual(expect.arrayContaining(['javascript', 'data']));
    expect(rules.credential_rules).toEqual([]);
  });
});

describe('isPublicTld', () => {
  it('answers from the snapshot', () => {
    expect(isPublicTld('md')).toBe(true);
    expect(isPublicTld('MD')).toBe(true);
    expect(isPublicTld('pdf')).toBe(false);
    expect(isPublicTld('test')).toBe(false);
  });
});

describe('normalizeHost', () => {
  it('lower-cases, converts to ASCII and strips one trailing dot', () => {
    expect(normalizeHost('Allowed.TEST')).toBe('allowed.test');
    expect(normalizeHost('allowed.test.')).toBe('allowed.test');
    expect(normalizeHost('https://allowed.test./x')).toBe('allowed.test');
    expect(normalizeHost('allowed.test..')).toBeNull();
  });

  it('rejects a host that changes under NFKC', () => {
    expect(normalizeHost('ｅｘａｍｐｌｅ．test')).toBeNull();
  });

  it('gives a Cyrillic look-alike a different ASCII form', () => {
    const lookalike = normalizeHost('exаmple.test');
    expect(lookalike).not.toBeNull();
    expect(lookalike).not.toBe('example.test');
    expect(lookalike?.startsWith('xn--')).toBe(true);
  });

  it('rejects user info and ideographic full stops', () => {
    expect(normalizeHost('https://user:pw@allowed.test/x')).toBeNull();
    expect(normalizeHost('a。b.test')).toBeNull();
  });
});

describe('classifyCandidate', () => {
  it('names each candidate kind', () => {
    expect(classifyCandidate('https://other.test/a?b=1')).toBe('url');
    expect(classifyCandidate('www.other.test')).toBe('url');
    expect(classifyCandidate('other.test')).toBe('bare_domain');
    expect(classifyCandidate('name@other.test')).toBe('email');
    expect(classifyCandidate('mailto:name@other.test')).toBe('email');
    expect(classifyCandidate('hxxp://example[.]test')).toBe('obfuscated');
    expect(classifyCandidate('example[.]test')).toBe('obfuscated');
    expect(classifyCandidate('example dot test')).toBe('obfuscated');
    expect(classifyCandidate('javascript:alert(1)')).toBe('opaque_scheme');
    expect(classifyCandidate('data:text/html,x')).toBe('opaque_scheme');
    expect(classifyCandidate('[S3]')).toBe('marker');
    expect(classifyCandidate('3.5')).toBe('none');
    expect(classifyCandidate('v2.1.0')).toBe('none');
    expect(classifyCandidate('report.pdf')).toBe('none');
  });

  it('exempts a context document name, never a URL with a scheme', () => {
    expect(classifyCandidate('document-a.md')).toBe('bare_domain');
    expect(classifyCandidate('document-a.md', { documentNames: ['document-a.md'] })).toBe('none');
    expect(classifyCandidate('https://document-a.md', { documentNames: ['document-a.md'] })).toBe('url');
  });
});

describe('isLinkAllowed', () => {
  it('rejects look-alike, user-info, obfuscated and opaque targets', () => {
    expect(isLinkAllowed('https://ｅｘａｍｐｌｅ．test/', policy)).toMatchObject({ allowed: false, rule: 'link_host_changed' });
    expect(isLinkAllowed('https://аllowed.test/', policy)).toMatchObject({ allowed: false, rule: 'link_not_allowlisted' });
    expect(isLinkAllowed('https://user:pw@allowed.test/x', policy)).toMatchObject({ allowed: false, rule: 'link_userinfo' });
    expect(isLinkAllowed('hxxp://example[.]test', policy)).toMatchObject({ allowed: false, rule: 'link_obfuscated' });
    expect(isLinkAllowed('example dot test', policy)).toMatchObject({ allowed: false, rule: 'link_obfuscated' });
    expect(isLinkAllowed('javascript:alert(1)', policy)).toMatchObject({ allowed: false, rule: 'link_opaque_scheme' });
    expect(isLinkAllowed('data:text/html,x', policy)).toMatchObject({ allowed: false, rule: 'link_opaque_scheme' });
    expect(isLinkAllowed('ftp://allowed.test/file', policy)).toMatchObject({ allowed: false, rule: 'link_opaque_scheme' });
  });

  it('rule 1: allowlisted hosts, their subdomains and the site host', () => {
    expect(isLinkAllowed('https://allowed.test/x', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('https://docs.allowed.test/x', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('https://allowed.test./x', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('allowed.test', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('https://app.example/chat', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('https://notallowed.test/x', policy)).toMatchObject({ allowed: false, rule: 'link_not_allowlisted' });
    expect(isLinkAllowed('https://allowed.test.other.test/', policy)).toMatchObject({ allowed: false });
  });

  it('rule 2: exactly an unflagged web result URL', () => {
    expect(isLinkAllowed('https://web.example/result-a', policy)).toMatchObject({ allowed: true, rule: 'web_result' });
    expect(isLinkAllowed('https://WEB.example/result-a', policy)).toMatchObject({ allowed: true, rule: 'web_result' });
    expect(isLinkAllowed('https://web.example/other', policy)).toMatchObject({ allowed: false });
    expect(isLinkAllowed('https://flagged.example/result-b', policy)).toMatchObject({ allowed: false });
  });

  it('rule 3: server-issued URLs and storage images', () => {
    expect(isLinkAllowed('https://files.example/document-a.pdf', policy)).toMatchObject({ allowed: true, rule: 'server_url' });
    expect(isLinkAllowed('https://files.example/document-b.pdf', policy)).toMatchObject({ allowed: false });
    expect(
      isLinkAllowed('https://store.example/storage/v1/object/public/images/a.png', policy),
    ).toMatchObject({ allowed: true, rule: 'server_url' });
    expect(isLinkAllowed('https://store.example/private/a.png', policy)).toMatchObject({ allowed: false });
  });

  it('rule 4: verbatim in the user message', () => {
    expect(isLinkAllowed('https://user.example/page', policy)).toMatchObject({ allowed: true, rule: 'user_message' });
    expect(isLinkAllowed('https://user.example/other', policy)).toMatchObject({ allowed: false });
    expect(isLinkAllowed('person@user.example', policy)).toMatchObject({ allowed: true, rule: 'user_message' });
    expect(isLinkAllowed('other@user.example', policy)).toMatchObject({ allowed: false });
  });

  it('checks the domain of an e-mail address against the allowlist', () => {
    expect(isLinkAllowed('name@allowed.test', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('mailto:name@allowed.test', policy)).toMatchObject({ allowed: true, rule: 'allowlist' });
    expect(isLinkAllowed('name@other.test', policy)).toMatchObject({ allowed: false, rule: 'link_not_allowlisted' });
  });

  it('never allows a link because it appears in retrieved text', () => {
    const withDocText = createOutputLinkPolicy({ allowlistValue: '', userMessage: 'question' });
    expect(isLinkAllowed('https://doc-only.test/page', withDocText)).toMatchObject({ allowed: false });
  });

  it('passes non-links and exempt document names', () => {
    expect(isLinkAllowed('v2.1.0', policy)).toMatchObject({ allowed: true, rule: 'not_link' });
    expect(isLinkAllowed('document-a.md', policy)).toMatchObject({ allowed: true, rule: 'not_link' });
    expect(isLinkAllowed('https://document-a.md', policy)).toMatchObject({ allowed: false });
  });
});
