import { scanText, type InjectionScanResult } from '../../security/injection-scan';
import { requireDocument, requireIdentity, type StageContext, type StageName, type StageOutcome, type StageSpec } from '../types';

/**
 * Sets the document to quarantined with the rule ids and up to three snippets of the match. Only the rule ids are logged.
 * Called before any chunk is written, so the chunk writer stamps every chunk quarantined and the version is never published.
 */
export async function quarantineDocument(ctx: StageContext, stage: StageName, result: InjectionScanResult): Promise<void> {
  const document = requireDocument(ctx, stage);
  await ctx.writer.setFields(document.id, {
    status: 'quarantined',
    metadata: {
      quarantine: { rule_ids: result.rule_ids, snippets: result.snippets, quarantined_at: new Date().toISOString() },
    },
  });
  ctx.state.quarantine = { ruleIds: result.rule_ids, released: false };
  console.warn('[Ingest] injection scan quarantined a document', { ruleIds: result.rule_ids });
}

/**
 * Scans the parse text for prompt-injection phrasing. A match sets the document to quarantined before any chunk
 * exists, so the chunk writer stamps every chunk quarantined and the D-08 filter keeps them out of every retrieval.
 * The rule ids and up to three snippets go to the document metadata; only the rule ids are logged.
 * If the rules cannot be loaded the run fails closed: text is never published unscanned under quarantine.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  if (ctx.config.injectionScan === 'off') return { kind: 'next', disabled: true, outcome: 'scan_off' };
  const identity = requireIdentity(ctx, 'scan_injection');
  if (!identity.profile.scan_injection) return { kind: 'next', disabled: true, outcome: 'scan_profile_off' };

  let result: InjectionScanResult;
  try {
    result = scanText(ctx.work.parseText ?? '');
  } catch (error) {
    console.error('[Ingest] injection scan unavailable', { reason: error instanceof Error ? error.message : 'unknown' });
    return { kind: 'fail', reason: 'injection_scan_unavailable' };
  }
  if (!result.matched) return { kind: 'next', outcome: 'scan_clean' };

  await quarantineDocument(ctx, 'scan_injection', result);
  return { kind: 'next', outcome: 'quarantined' };
}

export const scanInjectionStage: StageSpec = { name: 'scan_injection', minMsNeeded: 0, run };
