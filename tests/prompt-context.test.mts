import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const PLACEHOLDER = '{{context}}';

let createEnhancedRAGPrompt: typeof import('../src/lib/rag/generation/prompt.ts').createEnhancedRAGPrompt;
let SystemPromptManager: typeof import('../src/lib/system-prompt-manager.ts').SystemPromptManager;

before(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key-placeholder';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-placeholder';
  process.env.OPENAI_API_KEY = 'test-openai-key-placeholder';
  process.env.OPENROUTER_API_KEY = 'sk-or-abcdefghijklmnopqrstuvwxyzabcdef';
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
  ({ createEnhancedRAGPrompt } = await import('../src/lib/rag/generation/prompt.ts'));
  ({ SystemPromptManager } = await import('../src/lib/system-prompt-manager.ts'));
});

describe('{{context}} substitution', () => {
  test('createEnhancedRAGPrompt strict output contains the context and no placeholder', () => {
    const output = createEnhancedRAGPrompt(`Base ${PLACEHOLDER} end`, 'CTX-BLOCK', 'strict');
    assert.ok(output.includes('CTX-BLOCK'));
    assert.ok(!output.includes(PLACEHOLDER));
  });

  test('createEnhancedRAGPrompt fills the context in balanced and flexible modes too', () => {
    for (const mode of ['balanced', 'flexible'] as const) {
      const output = createEnhancedRAGPrompt(`Base ${PLACEHOLDER} end`, 'CTX-BLOCK', mode);
      assert.ok(output.includes('CTX-BLOCK'), mode);
      assert.ok(!output.includes(PLACEHOLDER), mode);
    }
  });

  test('ensureContextPlaceholder adds a placeholder when missing and leaves an existing one unchanged', () => {
    const added = SystemPromptManager.ensureContextPlaceholder('You are helpful.');
    assert.ok(added.includes(PLACEHOLDER));
    assert.ok(added.startsWith('You are helpful.'));

    const withPlaceholder = `Answer from:\n${PLACEHOLDER}\nThanks.`;
    assert.equal(SystemPromptManager.ensureContextPlaceholder(withPlaceholder), withPlaceholder);
  });

  test('injectContext replaces the placeholder, also for a prompt that lacked one', () => {
    const injected = SystemPromptManager.injectContext(`Answer from:\n${PLACEHOLDER}\nThanks.`, 'CTX-BLOCK');
    assert.equal(injected, 'Answer from:\nCTX-BLOCK\nThanks.');

    const repaired = SystemPromptManager.injectContext('You are helpful.', 'CTX-BLOCK');
    assert.ok(repaired.includes('CTX-BLOCK'));
    assert.ok(!repaired.includes(PLACEHOLDER));
  });
});
