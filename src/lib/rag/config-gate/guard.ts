import fs from 'fs';
import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { applyEnvUpdates, envFilePath, readEnvFile } from '@/lib/env-file';
import { monitorSettings, type ConfigGateMode } from '@/lib/rag/monitor/config';
import { getSupabaseAdmin } from '@/lib/supabase';
import { buildChangeRecord, decideSave, insertChangeRecord, readCheck, type ConfigGateCheck, type RagGateInput } from './gate-core';
import { RAG_AFFECTING_NAMES, ragAffectingDiff } from './settings-hash';

export const RAG_GATE_REQUIRED_MESSAGE =
  'This change affects RAG answers. Open the Config UI (npm run config), run the setting check there and save once it passes, or save there with a typed reason.';

export const RAG_GATE_INVALID_REASON_MESSAGE = 'An override reason must be 10 to 500 characters.';

export type AppGuardRoute = 'config' | 'rag-prompt' | 'models';

export interface GuardAppEnvWriteInput {
  updates: Record<string, string>;
  ragGate: unknown;
  actorUserId: string;
  route: AppGuardRoute;
  /** Repository root holding eval/out/config-gate/; defaults to process.cwd(). */
  root?: string;
}

export type GuardAppEnvWriteResult =
  | { ok: true; ragGate: { record_id: string; gate_result: string } | null }
  | { ok: false; response: NextResponse };

const NO_STORE = { 'Cache-Control': 'no-store' };
const MODE_RANK: Record<ConfigGateMode, number> = { off: 0, warn: 1, enforce: 2 };

const RagGateSchema = z.union([
  z.object({ override: z.object({ reason: z.string() }).strict(), check_id: z.string().optional() }).strict(),
  z.object({ check_id: z.string() }).strict(),
  z.object({ skipped: z.literal(true) }).strict(),
]);

function refuse(status: 400 | 409 | 503, body: Record<string, unknown>): GuardAppEnvWriteResult {
  return { ok: false, response: NextResponse.json({ success: false, ...body }, { status, headers: NO_STORE }) };
}

function required(): GuardAppEnvWriteResult {
  return refuse(409, { error: 'rag_gate_required', message: RAG_GATE_REQUIRED_MESSAGE });
}

function processMode(): ConfigGateMode {
  return monitorSettings({ RAG_CONFIG_GATE: process.env.RAG_CONFIG_GATE }).configGate;
}

/** The stricter of the running process's mode and the one in .env.local, so a mode set in the file applies before a restart. */
function effectiveMode(fromProcess: ConfigGateMode, fileValues: Record<string, string>): ConfigGateMode {
  const fromFile = monitorSettings({ RAG_CONFIG_GATE: fileValues.RAG_CONFIG_GATE }).configGate;
  return MODE_RANK[fromFile] > MODE_RANK[fromProcess] ? fromFile : fromProcess;
}

function writesCleanly(updates: Record<string, string>): boolean {
  try {
    const envPath = envFilePath();
    applyEnvUpdates(fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '', updates);
    return true;
  } catch {
    return false;
  }
}

/**
 * D-10, D-15, D-16: decides one app write of .env.local before writeEnvUpdates runs. Mode off returns at once without reading a
 * check or writing a record. A save that changes no RAG-affecting name is written without a check. Otherwise the save needs a passed
 * check of the proposed hash or an override reason in enforce mode, and every written RAG-affecting change gets a change record.
 * Never throws: an internal failure refuses with 409 in enforce mode and writes without a record in warn mode.
 */
export async function guardAppEnvWrite(input: GuardAppEnvWriteInput): Promise<GuardAppEnvWriteResult> {
  let mode: ConfigGateMode = processMode();
  let before: Record<string, string>;
  try {
    before = readEnvFile();
  } catch {
    // The env writer fails on the same file; off stays a pass-through, warn and enforce fail closed.
    if (mode === 'off') return { ok: true, ragGate: null };
    console.error('[Config Gate] env file unreadable', { route: input.route, mode });
    return mode === 'enforce' ? required() : { ok: true, ragGate: null };
  }
  try {
    mode = effectiveMode(mode, before);
    if (mode === 'off') return { ok: true, ragGate: null };

    const after = { ...before, ...input.updates };
    if (ragAffectingDiff(before, after, RAG_AFFECTING_NAMES).length === 0) return { ok: true, ragGate: null };

    let ragGate: RagGateInput = null;
    if (input.ragGate !== undefined && input.ragGate !== null) {
      const parsed = RagGateSchema.safeParse(input.ragGate);
      if (parsed.success) ragGate = parsed.data;
      else if (mode === 'enforce') return refuse(400, { error: 'invalid_rag_gate', message: RAG_GATE_REQUIRED_MESSAGE });
    }

    const root = input.root ?? process.cwd();
    let matched: ConfigGateCheck | null = null;
    const decision = await decideSave({
      mode,
      before,
      after,
      ragGate,
      readCheck: (id: string) => {
        matched = readCheck(root, id);
        return matched;
      },
    });

    if (decision.kind === 'refuse') {
      console.warn('[Config Gate] app save refused', { route: input.route, error: decision.error });
      return decision.error === 'invalid_reason'
        ? refuse(400, { error: 'invalid_reason', message: RAG_GATE_INVALID_REASON_MESSAGE })
        : required();
    }

    // A write the env writer would refuse anyway leaves no record; the route answers it through its own error path.
    if (!writesCleanly(input.updates)) return { ok: true, ragGate: null };

    const check: ConfigGateCheck | null = decision.checkId ? matched : null;
    const row = buildChangeRecord({
      actor: input.actorUserId,
      source: 'config_ui',
      gateResult: decision.gateResult,
      before,
      after,
      check,
      overrideReason: decision.overrideReason,
    });

    let inserted: { ok: true; id: string } | { ok: false; reason: string } = { ok: false, reason: 'insert_failed' };
    try {
      const admin = getSupabaseAdmin();
      if (admin) inserted = await insertChangeRecord(admin, row);
    } catch {
      inserted = { ok: false, reason: 'insert_failed' };
    }

    if (!inserted.ok) {
      console.error('[Config Gate] change record insert failed', { route: input.route, result: decision.gateResult });
      if (decision.overrideReason !== null) return refuse(503, { error: 'rag_gate_record_failed' });
      return { ok: true, ragGate: null };
    }

    console.log('[Config Gate] app save recorded', { route: input.route, result: decision.gateResult, recordId: inserted.id });
    return { ok: true, ragGate: { record_id: inserted.id, gate_result: decision.gateResult } };
  } catch {
    console.error('[Config Gate] app guard failed', { route: input.route, mode });
    return mode === 'enforce' ? required() : { ok: true, ragGate: null };
  }
}
