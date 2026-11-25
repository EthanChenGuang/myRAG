import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FeedbackMiningConfigError,
  loadFeedbackMiningConfig,
  readFeedbackLoopConfig,
} from '@/lib/rag/feedback-loop/config';

const SECRET_32 = 'p'.repeat(32);
const SECRET_31 = 'q'.repeat(31);

function read(source: Record<string, string | undefined>) {
  const logged: string[] = [];
  const config = readFeedbackLoopConfig(source, (message) => logged.push(message));
  return { config, logged };
}

describe('readFeedbackLoopConfig (D-26)', () => {
  it('returns every switch off for an empty environment, without warnings', () => {
    const { config, logged } = read({});
    expect(config).toMatchObject({
      retrievalLog: 'off',
      retentionDays: 30,
      refusalFeedback: false,
      embedFeedback: false,
      embedFeedbackEnabled: false,
      embedFeedbackSecret: null,
      sourceOpenSignal: false,
      domainExpertReview: false,
      anyEnabled: false,
    });
    expect(config.warnings).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('reads at call time', () => {
    const source: Record<string, string | undefined> = {};
    expect(read(source).config.retrievalLog).toBe('off');
    source.RAG_RETRIEVAL_LOG = 'masked_query';
    expect(read(source).config.retrievalLog).toBe('masked_query');
  });

  it('accepts the three log levels', () => {
    for (const level of ['off', 'ids', 'masked_query']) {
      expect(read({ RAG_RETRIEVAL_LOG: level }).config.retrievalLog).toBe(level);
    }
  });

  it('falls back to off with one [Feedback Loop] warning for an unknown log level', () => {
    const { config, logged } = read({ RAG_RETRIEVAL_LOG: 'verbose' });
    expect(config.retrievalLog).toBe('off');
    expect(config.warnings.map((w) => w.code)).toEqual(['invalid_retrieval_log']);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[Feedback Loop\] /);
    expect(logged[0]).not.toContain('verbose');
  });

  it.each(['0', '400', '-3', '7.5', 'thirty'])('reads retention %s as 30 with one warning', (raw) => {
    const { config, logged } = read({ RAG_RETRIEVAL_LOG_RETENTION_DAYS: raw });
    expect(config.retentionDays).toBe(30);
    expect(config.warnings.map((w) => w.code)).toEqual(['invalid_retention_days']);
    expect(logged).toHaveLength(1);
  });

  it.each([['1', 1], ['365', 365], [' 90 ', 90]])('accepts retention %s', (raw, days) => {
    const { config, logged } = read({ RAG_RETRIEVAL_LOG_RETENTION_DAYS: raw });
    expect(config.retentionDays).toBe(days);
    expect(logged).toEqual([]);
  });

  it('turns booleans on only for "true" and warns on other non-empty values', () => {
    const on = read({ RAG_REFUSAL_FEEDBACK: 'true', RAG_SOURCE_OPEN_SIGNAL: 'true', RAG_DOMAIN_EXPERT_REVIEW: 'true' }).config;
    expect([on.refusalFeedback, on.sourceOpenSignal, on.domainExpertReview]).toEqual([true, true, true]);
    expect(on.anyEnabled).toBe(true);
    const { config, logged } = read({ RAG_REFUSAL_FEEDBACK: 'yes', RAG_DOMAIN_EXPERT_REVIEW: '1', RAG_SOURCE_OPEN_SIGNAL: 'false' });
    expect([config.refusalFeedback, config.sourceOpenSignal, config.domainExpertReview]).toEqual([false, false, false]);
    expect(config.warnings.map((w) => w.code).sort()).toEqual(['invalid_boolean', 'invalid_boolean']);
    expect(logged).toHaveLength(2);
  });

  it('keeps the embed control off with a 31-character secret and warns without the secret', () => {
    const { config, logged } = read({ RAG_EMBED_FEEDBACK: 'true', RAG_EMBED_FEEDBACK_SECRET: SECRET_31 });
    expect(config.embedFeedback).toBe(true);
    expect(config.embedFeedbackEnabled).toBe(false);
    expect(config.embedFeedbackSecret).toBeNull();
    expect(config.warnings.map((w) => w.code)).toEqual(['embed_feedback_secret_too_short']);
    expect(logged).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(SECRET_31);
    expect(JSON.stringify(config)).not.toContain(SECRET_31);
  });

  it('enables the embed control with a 32-character secret, exposed only on its dedicated field', () => {
    const { config, logged } = read({ RAG_EMBED_FEEDBACK: 'true', RAG_EMBED_FEEDBACK_SECRET: SECRET_32 });
    expect(config.embedFeedbackEnabled).toBe(true);
    expect(config.embedFeedbackSecret).toBe(SECRET_32);
    expect(logged).toEqual([]);
    expect(JSON.stringify(config)).not.toContain(SECRET_32);
    expect(Object.keys(config)).not.toContain('embedFeedbackSecret');
    const others = Object.entries(config).filter(([key]) => key !== 'embedFeedbackSecret');
    expect(JSON.stringify(others)).not.toContain(SECRET_32);
  });

  it('never exposes the secret while the embed switch is off', () => {
    const { config, logged } = read({ RAG_EMBED_FEEDBACK: 'false', RAG_EMBED_FEEDBACK_SECRET: SECRET_32 });
    expect(config.embedFeedbackEnabled).toBe(false);
    expect(config.embedFeedbackSecret).toBeNull();
    expect(logged).toEqual([]);
  });

  it('logs one warning per invalid value and never a configured value', () => {
    const { config, logged } = read({
      RAG_RETRIEVAL_LOG: 'everything',
      RAG_RETRIEVAL_LOG_RETENTION_DAYS: '999',
      RAG_EMBED_FEEDBACK: 'true',
      RAG_EMBED_FEEDBACK_SECRET: SECRET_31,
    });
    expect(config.warnings).toHaveLength(3);
    expect(logged).toHaveLength(3);
    for (const line of logged) {
      expect(line).toMatch(/^\[Feedback Loop\] /);
      expect(line).not.toMatch(/everything|999|q{31}/);
    }
  });
});

describe('loadFeedbackMiningConfig (D-13)', () => {
  const committed = path.join(process.cwd(), 'config/rag/feedback-mining.json');

  it('validates the committed file and returns it with the sha256 of its bytes', () => {
    const { config, sha256 } = loadFeedbackMiningConfig();
    expect(sha256).toBe(createHash('sha256').update(fs.readFileSync(committed)).digest('hex'));
    expect(config).toMatchObject({
      schema_version: 1,
      per_tenant_limit: 50,
      window_days: 7,
      open_item_ttl_days: 90,
      low_score_ceiling: { similarity: 0.35, rerank: 0.2 },
      refused_high_score_floor: { similarity: 0.55, rerank: 0.5 },
    });
    expect(config.notes).toMatch(/uncalibrated/i);
    expect(config.notes).toMatch(/report-only/i);
  });

  function tempFile(body: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-mining-'));
    const file = path.join(dir, 'feedback-mining.json');
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }

  it('applies the schema defaults when optional fields are absent', () => {
    const file = tempFile({
      schema_version: 1,
      low_score_ceiling: { similarity: 0.3, rerank: 0.1 },
      refused_high_score_floor: { similarity: 0.6, rerank: 0.4 },
    });
    const { config } = loadFeedbackMiningConfig(file);
    expect(config).toMatchObject({ per_tenant_limit: 50, window_days: 7, open_item_ttl_days: 90 });
  });

  it.each([
    ['a per-tenant limit above 500', { per_tenant_limit: 501 }],
    ['a window of 32 days', { window_days: 32 }],
    ['a schema version 2', { schema_version: 2 }],
    ['an unknown field', { extra: true }],
    ['a missing rerank threshold', { low_score_ceiling: { similarity: 0.3 } }],
  ])('throws a typed error naming the path for %s', (_label, patch) => {
    const body = {
      schema_version: 1,
      per_tenant_limit: 50,
      window_days: 7,
      open_item_ttl_days: 90,
      low_score_ceiling: { similarity: 0.35, rerank: 0.2 },
      refused_high_score_floor: { similarity: 0.55, rerank: 0.5 },
      ...patch,
    };
    const file = tempFile(body);
    let caught: unknown;
    try {
      loadFeedbackMiningConfig(file);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FeedbackMiningConfigError);
    expect((caught as FeedbackMiningConfigError).path).toBe(file);
    expect((caught as Error).message).toContain(file);
  });

  it('throws a typed error for invalid JSON', () => {
    const file = tempFile('{ not json');
    expect(() => loadFeedbackMiningConfig(file)).toThrow(FeedbackMiningConfigError);
  });
});
