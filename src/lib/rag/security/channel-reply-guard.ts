import { env } from '@/lib/env';
import { readAnswerConfig } from '../generation/answer-config';
import { emitNotice, renderNoticeAsText } from '../generation/notices';
import { fixedText } from '../lang/texts';
import { getLanguageSettings, languageVariablesUnset } from '../lang/settings';
import { resolveTenantScope } from '../tenant/resolve-chat';
import { scopeKey } from '../tenant/scope';
import { createOutputLinkPolicy } from './link-targets';
import { guardWholeText, type OutputGuardLinkSummary } from './output-guard';
import { recordOutputGuardEvents } from './security-events';

export interface ChannelReplyGuardInput {
  text: string;
  /** The user's own message of this turn; a URL in it may appear in the reply. */
  userMessage: string;
  /** The server-side owner of the channel session; never taken from the incoming message. */
  ownerUserId?: string | null;
  channel: 'whatsapp';
}

export interface ChannelReplyGuardResult {
  text: string;
  /** True whenever the guard is not off: the provider is asked never to fetch a link preview for the reply. */
  linkPreviewOff: boolean;
}

function hasFindings(summary: OutputGuardLinkSummary): boolean {
  return summary.links_removed > 0 || summary.credential_blocked > 0 || summary.credential_warned > 0;
}

async function recordFindings(summary: OutputGuardLinkSummary, input: ChannelReplyGuardInput): Promise<void> {
  try {
    const owner = input.ownerUserId;
    const resolved = await resolveTenantScope({
      getUser: async () => (owner ? { id: owner } : null),
      signal: AbortSignal.timeout(5000),
    });
    if (!resolved.ok || !resolved.scope) return;
    recordOutputGuardEvents(summary, {
      tenantKey: scopeKey(resolved.scope),
      traceId: null,
      blocks: [],
      channel: input.channel,
      removedTargets: summary.removedTargets,
      matchedPhrases: [],
    });
  } catch {
    console.warn('[RAG Security] output guard events not recorded', { channel: input.channel });
  }
}

/**
 * D-40, D-41: the whole-text guard for a non-streamed channel reply. Off returns the text unchanged and reads no language
 * setting. Enforce fails closed (a guard failure throws); flag keeps the text. The policy is the allowlist, the site host
 * and the user's message; web result URLs are not available here, so a web-result link outside the allowlist is replaced.
 */
export async function guardChannelReply(input: ChannelReplyGuardInput): Promise<ChannelReplyGuardResult> {
  const mode = readAnswerConfig().outputGuard;
  if (mode === 'off') return { text: input.text, linkPreviewOff: false };

  const language = languageVariablesUnset() ? '' : getLanguageSettings().primary ?? '';
  let result: { text: string; summary: OutputGuardLinkSummary };
  try {
    result = guardWholeText(input.text, {
      mode,
      links: createOutputLinkPolicy({
        allowlistValue: env.RAG_OUTPUT_LINK_ALLOWLIST,
        siteUrl: env.NEXT_PUBLIC_SITE_URL,
        userMessage: input.userMessage,
      }),
      placeholder: fixedText('notices.link_removed', language),
      language,
    });
  } catch (error) {
    console.error('[RAG Security] output guard failed', { channel: input.channel, mode });
    if (mode === 'enforce') throw error;
    return { text: input.text, linkPreviewOff: true };
  }

  let text = result.text;
  if (mode === 'enforce' && result.summary.credential_warned > 0) {
    text += renderNoticeAsText(emitNotice('credential_request_warning', { language }));
  }
  if (hasFindings(result.summary)) await recordFindings(result.summary, input);
  return { text, linkPreviewOff: true };
}
