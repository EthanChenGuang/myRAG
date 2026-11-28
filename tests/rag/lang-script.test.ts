import { describe, expect, it } from 'vitest';
import { chineseScript, SIMPLIFIED_ONLY, TRADITIONAL_ONLY } from '@/lib/rag/lang/script';

describe('chineseScript', () => {
  it('classifies a Simplified sentence as hans', () => {
    expect(chineseScript('这是我们说的时候，国家发展得很快。')).toBe('hans');
  });

  it('classifies the same sentence in Traditional characters as hant', () => {
    expect(chineseScript('這是我們說的時候，國家發展得很快。')).toBe('hant');
  });

  it('classifies longer Traditional prose as hant', () => {
    expect(chineseScript('根據文件說明，員工應該在三個工作日內完成報銷申請，並將發票寄給財務部門。')).toBe('hant');
  });

  it('classifies longer Simplified prose as hans', () => {
    expect(chineseScript('根据文件说明，员工应该在三个工作日内完成报销申请，并将发票寄给财务部门。')).toBe('hans');
  });

  it('returns ambiguous for text with only shared characters', () => {
    expect(chineseScript('中文')).toBe('ambiguous');
    expect(chineseScript('人大')).toBe('ambiguous');
  });

  it('returns hans for mixed text with more Simplified-only hits', () => {
    expect(chineseScript('这们说時')).toBe('hans');
  });

  it('never returns hans for mixed text without more Simplified-only hits', () => {
    expect(chineseScript('这時')).not.toBe('hans');
    expect(chineseScript('这時們')).not.toBe('hans');
  });

  it('returns ambiguous without Han characters', () => {
    expect(chineseScript('')).toBe('ambiguous');
    expect(chineseScript('The policy applies to everyone.')).toBe('ambiguous');
    expect(chineseScript('12345 !?')).toBe('ambiguous');
  });

  it('keeps the two committed sets paired, disjoint and of the planned size', () => {
    const simplified = [...SIMPLIFIED_ONLY];
    const traditional = [...TRADITIONAL_ONLY];
    expect(simplified.length).toBe(traditional.length);
    expect(simplified.length).toBeGreaterThanOrEqual(60);
    expect(new Set(simplified).size).toBe(simplified.length);
    expect(new Set(traditional).size).toBe(traditional.length);
    for (const char of simplified) expect(TRADITIONAL_ONLY.has(char), char).toBe(false);
    for (const char of [...simplified, ...traditional]) expect(/^\p{Script=Han}$/u.test(char), char).toBe(true);
  });
});
