import { describe, expect, it } from 'vitest';
import { USAGE, parseEmbeddingArgs } from '@/lib/rag/embeddings/cli';

const TENANT = 'u:11111111-1111-4111-8111-111111111111';
const VERSION = 'ft-widget-model-001';

describe('rag:embedding ft-* argument parsing', () => {
  it('accepts ft-consent grant, revoke and list', () => {
    expect(parseEmbeddingArgs(['ft-consent', 'grant', TENANT, '--ref', 'TICKET-123'])).toEqual({
      ok: true,
      command: 'ft-consent-grant',
      tenantKey: TENANT,
      evidenceRef: 'TICKET-123',
      scope: 'private',
    });
    expect(parseEmbeddingArgs(['ft-consent', 'grant', 's:default', '--scope', 'deployment', '--ref', 'AGREEMENT-7'])).toEqual({
      ok: true,
      command: 'ft-consent-grant',
      tenantKey: 's:default',
      evidenceRef: 'AGREEMENT-7',
      scope: 'deployment',
    });
    expect(parseEmbeddingArgs(['ft-consent', 'revoke', TENANT])).toEqual({ ok: true, command: 'ft-consent-revoke', tenantKey: TENANT, pruneRoot: null });
    expect(parseEmbeddingArgs(['ft-consent', 'revoke', TENANT, '--prune-root', '/tmp/bundles'])).toEqual({
      ok: true,
      command: 'ft-consent-revoke',
      tenantKey: TENANT,
      pruneRoot: '/tmp/bundles',
    });
    expect(parseEmbeddingArgs(['ft-consent', 'list'])).toEqual({ ok: true, command: 'ft-consent-list' });
  });

  it('rejects a grant without --ref, a bad tenant key, a bad scope and stray arguments', () => {
    for (const argv of [
      ['ft-consent', 'grant', TENANT],
      ['ft-consent', 'grant', TENANT, '--ref'],
      ['ft-consent', 'grant', TENANT, '--ref', ''],
      ['ft-consent', 'grant', 'tenant-a', '--ref', 'TICKET-1'],
      ['ft-consent', 'grant', 'u:not-a-uuid', '--ref', 'TICKET-1'],
      ['ft-consent', 'grant', TENANT, '--ref', 'TICKET-1', '--scope', 'none'],
      ['ft-consent', 'grant', TENANT, '--ref', 'TICKET-1', '--other', 'x'],
      ['ft-consent', 'revoke'],
      ['ft-consent', 'revoke', 'o:bad'],
      ['ft-consent', 'revoke', TENANT, '--prune-root'],
      ['ft-consent', 'list', 'extra'],
      ['ft-consent'],
      ['ft-consent', 'frobnicate'],
    ]) {
      expect(parseEmbeddingArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('accepts ft-models register, list and retire', () => {
    expect(parseEmbeddingArgs(['ft-models', 'register', 'card.json'])).toEqual({ ok: true, command: 'ft-models-register', cardPath: 'card.json' });
    expect(parseEmbeddingArgs(['ft-models', 'list'])).toEqual({ ok: true, command: 'ft-models-list' });
    expect(parseEmbeddingArgs(['ft-models', 'retire', VERSION])).toEqual({ ok: true, command: 'ft-models-retire', versionId: VERSION });
    for (const argv of [['ft-models', 'register'], ['ft-models', 'list', 'x'], ['ft-models', 'retire'], ['ft-models', 'retire', 'Bad Id'], ['ft-models', 'retire', 'model-without-prefix']]) {
      expect(parseEmbeddingArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('accepts ft-bind only for the two fixed slots', () => {
    expect(parseEmbeddingArgs(['ft-bind', 'ft-a-1024', VERSION])).toEqual({ ok: true, command: 'ft-bind', slot: 'ft-a-1024', versionId: VERSION });
    expect(parseEmbeddingArgs(['ft-bind', 'ft-b-1024', VERSION])).toEqual({ ok: true, command: 'ft-bind', slot: 'ft-b-1024', versionId: VERSION });
    for (const argv of [['ft-bind', 'ft-c-1024', VERSION], ['ft-bind', 'voyage-4-large-1024', VERSION], ['ft-bind', 'ft-a-1024'], ['ft-bind', 'ft-a-1024', 'bad version'], ['ft-bind', 'ft-a-1024', VERSION, 'extra']]) {
      expect(parseEmbeddingArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('accepts ft-clear with an optional batch size from 1 to 10000', () => {
    expect(parseEmbeddingArgs(['ft-clear', 'ft-a-1024'])).toEqual({ ok: true, command: 'ft-clear', slot: 'ft-a-1024', batch: 1000 });
    expect(parseEmbeddingArgs(['ft-clear', 'ft-b-1024', '--batch', '25'])).toEqual({ ok: true, command: 'ft-clear', slot: 'ft-b-1024', batch: 25 });
    for (const argv of [['ft-clear'], ['ft-clear', 'ft-x-1024'], ['ft-clear', 'ft-a-1024', '--batch'], ['ft-clear', 'ft-a-1024', '--batch', '0'], ['ft-clear', 'ft-a-1024', '--batch', '10001'], ['ft-clear', 'ft-a-1024', '--batch', '2.5']]) {
      expect(parseEmbeddingArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('accepts ft-release-rollback only with --ack drop-rollback', () => {
    expect(parseEmbeddingArgs(['ft-release-rollback', '--ack', 'drop-rollback'])).toEqual({ ok: true, command: 'ft-release-rollback' });
    for (const argv of [['ft-release-rollback'], ['ft-release-rollback', '--ack'], ['ft-release-rollback', '--ack', 'yes'], ['ft-release-rollback', '--ack', 'drop-rollback', 'extra']]) {
      expect(parseEmbeddingArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('accepts ft-check for a slot', () => {
    expect(parseEmbeddingArgs(['ft-check', 'ft-a-1024'])).toEqual({ ok: true, command: 'ft-check', slot: 'ft-a-1024' });
    for (const argv of [['ft-check'], ['ft-check', 'ft-z-1024'], ['ft-check', 'ft-a-1024', 'extra']]) {
      expect(parseEmbeddingArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('keeps the existing commands unchanged and lists the new ones in the usage', () => {
    expect(parseEmbeddingArgs(['status'])).toEqual({ ok: true, command: 'status' });
    expect(parseEmbeddingArgs(['set-status', 'ft-a-1024', 'active']).ok).toBe(false);
    for (const usage of ['ft-consent grant', 'ft-consent revoke', 'ft-consent list', 'ft-models register', 'ft-models list', 'ft-models retire', 'ft-bind', 'ft-clear', 'ft-release-rollback --ack drop-rollback', 'ft-check']) {
      expect(USAGE).toContain(usage);
    }
  });
});

describe('post-bind guidance', () => {
  it('names the global re-embed for an unscoped slot and the tenant-filtered binding backfill for a scoped one', async () => {
    const { bindGuidance } = await import('@/lib/rag/embeddings/finetune-ops');
    const version = { id: VERSION, queryPrompt: 'query: ', documentPrompt: 'passage: ' };
    const unscoped = bindGuidance('ft-b-1024', version).join('\n');
    expect(unscoped).toContain(`RAG_FT_SLOT_B_MODEL=${VERSION}`);
    expect(unscoped).toContain('RAG_FT_SLOT_B_QUERY_PROMPT="query: "');
    expect(unscoped).toContain('npm run rag:reembed -- --profile ft-b-1024');
    expect(unscoped).not.toContain('--tenant');
    const scoped = bindGuidance('ft-a-1024', version, TENANT).join('\n');
    expect(scoped).toContain(`npm run rag:reembed -- --profile ft-a-1024 --tenant ${TENANT}`);
    expect(scoped).toContain('binding backfill');
  });
});
