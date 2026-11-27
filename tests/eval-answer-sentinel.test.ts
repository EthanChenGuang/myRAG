import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildEvalSystemPrompt, EVAL_DEFAULT_SYSTEM_PROMPT } from '@/lib/rag-eval/answer';
import { createEnhancedRAGPrompt, readSecurityConfig } from '@/lib/rag';
import { REFERENCE_NOTICE, wrapDocuments } from '@/lib/rag/context/wrap';
import { SystemPromptManager } from '@/lib/system-prompt-manager';

const REPO_ROOT = path.resolve(__dirname, '..');
const chatRoute = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/chat/route.ts'), 'utf8');
const answerSource = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/rag-eval/answer.ts'), 'utf8');

const evalRoute = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/internal/rag/run/route.ts'), 'utf8');

const PRE_POST_EXPRESSION = "preContext + '\\n\\nContext:\\n{{context}}\\n\\n' + postContext";

function compact(source: string): string {
  return source.replace(/\s+/g, '');
}

/** D-04, D-07: the chat route appends the answer-rule block to the citation-decorated enhanced prompt. */
const CHAT_COMPOSITION = compact(
  'answerTurn.composeSystemPrompt(citationSession.decorateSystemPrompt(createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode, answerLanguage)),',
);
/** The eval route's decorateSystemPrompt hook: the same composer, after the same citation decoration. */
const EVAL_COMPOSITION = compact(
  'answerTurn.composeSystemPrompt(citationSession ? citationSession.decorateSystemPrompt(prompt) : prompt, answerRuleOptions)',
);

function composesAnswerRules(chatSource: string, evalSource: string): boolean {
  return compact(chatSource).includes(CHAT_COMPOSITION) && compact(evalSource).includes(EVAL_COMPOSITION);
}

function extractDefaultPrompt(source: string): string {
  const marker = 'const defaultSystemPrompt = `';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('defaultSystemPrompt literal not found in the chat route');
  const bodyStart = start + marker.length;
  const end = source.indexOf('`;', bodyStart);
  if (end === -1) throw new Error('defaultSystemPrompt literal is not terminated');
  return source.slice(bodyStart, end);
}

describe('eval answer prompt assembly stays tied to the chat route', () => {
  test('the default system prompt text is identical', () => {
    expect(EVAL_DEFAULT_SYSTEM_PROMPT).toBe(extractDefaultPrompt(chatRoute));
  });

  test('the pre/post assembly expression appears in both files', () => {
    expect(chatRoute).toContain(PRE_POST_EXPRESSION);
    expect(answerSource).toContain(PRE_POST_EXPRESSION);
  });

  test('the newline unescaping of the three prompt variables appears in both files', () => {
    const unescape = ".replace(/\\\\n/g, '\\n')";
    for (const [source, prefix] of [
      [chatRoute, 'env'],
      [answerSource, 'promptEnv'],
    ] as const) {
      expect(source).toContain(`(${prefix}.RAG_PRE_CONTEXT || '')${unescape}`);
      expect(source).toContain(`(${prefix}.RAG_POST_CONTEXT || '')${unescape}`);
      expect(source).toContain(`${prefix}.RAG_SYSTEM_PROMPT${unescape}`);
    }
  });

  test('ensureContextPlaceholder runs before the enhanced prompt or injectContext', () => {
    for (const source of [chatRoute, answerSource]) {
      const ensure = source.indexOf('SystemPromptManager.ensureContextPlaceholder(ragSystemPrompt)');
      const enhanced = source.indexOf('createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode, answerLanguage)');
      const inject = source.indexOf('SystemPromptManager.injectContext(ragSystemPrompt, context)');
      expect(ensure).toBeGreaterThan(-1);
      expect(enhanced).toBeGreaterThan(ensure);
      expect(inject).toBeGreaterThan(enhanced);
    }
  });

  test('the context-length branch selects the enhanced prompt in both files', () => {
    expect(chatRoute).toContain('if (context.length > 0) {');
    expect(answerSource).toContain('if (context.length > 0) {');
  });

  test('the generation temperature literal matches', () => {
    expect(chatRoute).toContain('temperature: 0.1,');
    expect(answerSource).toContain('temperature: 0.1,');
  });

  describe('Phase 5.2 composition, cap and chain (D-07, D-29, RESEARCH Pitfall 21)', () => {
    test('both paths call the composer seam after the citation decoration', () => {
      expect(composesAnswerRules(chatRoute, evalRoute)).toBe(true);
    });

    test('the check fails when either composer call is removed', () => {
      const chatWithout = chatRoute.replace(/answerTurn\.composeSystemPrompt\(\s*citationSession\.decorateSystemPrompt/g, '(citationSession.decorateSystemPrompt');
      const evalWithout = evalRoute.replace('answerTurn.composeSystemPrompt(', '(');
      expect(chatWithout).not.toBe(chatRoute);
      expect(evalWithout).not.toBe(evalRoute);
      expect(composesAnswerRules(chatWithout, evalRoute)).toBe(false);
      expect(composesAnswerRules(chatRoute, evalWithout)).toBe(false);
    });

    test('both paths take the output limit through the same cap helper', () => {
      expect(compact(chatRoute)).toContain(compact('answerTurn.maxOutputTokens(getMaxTokensForModel(safeModelId))'));
      expect(compact(answerSource)).toContain(compact('effectiveMaxOutputTokens(maxOutputTokensForModel(generatorModel)'));
      expect(evalRoute).toContain('answerTurn.decideOutputCap(');
    });

    test('the eval route runs the whole-text twin of the stream chain', () => {
      expect(evalRoute).toContain('applyAnswerPipelineToText(');
    });
  });

  test('the isGPTModel expression matches the chat route', () => {
    const expression = "includes('gpt-4') || modelId.includes('o1') || modelId.includes('chatgpt')";
    expect(answerSource).toContain(expression);
    expect(chatRoute).toContain("model.includes('gpt-4') || model.includes('o1') || model.includes('chatgpt')");
  });

  describe('with RAG_CONTEXT_TAGGING off and on', () => {
    const previous = process.env.RAG_CONTEXT_TAGGING;
    afterEach(() => {
      if (previous === undefined) delete process.env.RAG_CONTEXT_TAGGING;
      else process.env.RAG_CONTEXT_TAGGING = previous;
    });

    function sharedContext(): string {
      const chunk = 'The quillmark relay calibrates its phase offset against the reference beacon.';
      if (!readSecurityConfig().contextTagging) return `=== RELEVANT INFORMATION FROM DOCUMENTS ===\n${chunk}\n=== END OF RELEVANT INFORMATION ===\n`;
      return wrapDocuments([{ id: 'c1', source: 'quillmark-relay.md', text: chunk }]) as string;
    }

    for (const value of [undefined, 'true'] as const) {
      test(`the eval prompt equals the chat route's assembly (RAG_CONTEXT_TAGGING=${value ?? 'unset'})`, () => {
        if (value === undefined) delete process.env.RAG_CONTEXT_TAGGING;
        else process.env.RAG_CONTEXT_TAGGING = value;
        const context = sharedContext();
        const chatTemplate = SystemPromptManager.ensureContextPlaceholder(extractDefaultPrompt(chatRoute));
        for (const ragMode of ['strict', 'balanced', 'flexible'] as const) {
          const evalPrompt = buildEvalSystemPrompt({ context, ragMode, promptEnv: {} });
          expect(evalPrompt).toBe(createEnhancedRAGPrompt(chatTemplate, context, ragMode));
          expect(evalPrompt.split(REFERENCE_NOTICE).length - 1).toBe(value === 'true' ? 1 : 0);
          expect(evalPrompt.split('<documents>').length - 1).toBe(value === 'true' ? 1 : 0);
        }
      });
    }

    test('tagging lives only in the shared assembly: neither file reads the switch', () => {
      for (const source of [chatRoute, answerSource]) {
        expect(source).not.toContain('RAG_CONTEXT_TAGGING');
        expect(source).not.toContain('contextTagging');
      }
    });
  });
});
