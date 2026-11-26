import { queueConfigFromProcessEnv, type QueueConfig } from './queue-config';
import { enqueueTranslateJobs } from './translate/enqueue';
import { TRANSLATION_HOOK, registerTranslationHook, translationAfterPublishOn } from './translate/produce';
import { SUPERSESSION_HOOK, registerSupersessionHook, supersessionDetectOn } from './versions/detect';

/**
 * The one place that runs work after a document version becomes current (D-29, D-41). The publish stage calls afterPublish once its
 * outcome is `published`; approval, rebuild activation and quarantine release call it too. A hook never fails or delays ingestion:
 * each runs in registration order inside its own time budget, and a failure or timeout is logged with ids only.
 */
export interface PostPublishEvent {
  documentId: string;
  tenantKey: string;
}

export type PostPublishHook = (event: PostPublishEvent, signal: AbortSignal) => Promise<void> | void;

export interface PostPublishHookOptions {
  /** Defaults to DEFAULT_HOOK_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

interface RegisteredHook {
  name: string;
  run: PostPublishHook;
  timeoutMs: number;
}

const hooks: RegisteredHook[] = [];

/** Registers a hook under a unique name; registering the same name again replaces it in place. */
export function registerPostPublishHook(name: string, run: PostPublishHook, options: PostPublishHookOptions = {}): void {
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;
  const entry: RegisteredHook = { name, run, timeoutMs };
  const index = hooks.findIndex((hook) => hook.name === name);
  if (index >= 0) hooks[index] = entry;
  else hooks.push(entry);
}

export function unregisterPostPublishHook(name: string): void {
  const index = hooks.findIndex((hook) => hook.name === name);
  if (index >= 0) hooks.splice(index, 1);
}

/** Enqueuing makes a few ledger calls and no model call. */
export const QUEUED_TRANSLATION_HOOK_TIMEOUT_MS = 10_000;

let queueConfigSource: () => QueueConfig = queueConfigFromProcessEnv;

/** Tests only: the queue configuration the translation hook reads (the process one is frozen at import). */
export function setPostPublishQueueConfigForTests(source: (() => QueueConfig) | null): void {
  queueConfigSource = source ?? queueConfigFromProcessEnv;
}

function asyncIngestOn(): boolean {
  try {
    return queueConfigSource().ingestAsync;
  } catch {
    return false;
  }
}

/**
 * D-41: the supersession detector is a hook only while RAG_SUPERSESSION_DETECT=on. D-29: chunk translation is a hook only while
 * RAG_DOC_TRANSLATION=on and the deployment is not monolingual: with asynchronous ingestion off it translates inline within its budget,
 * with it on it only enqueues ledger jobs of kind translate (enqueueTranslateJob, one per target) for the worker. Both check the tenant's
 * own setting first. Off, each is removed and nothing runs.
 */
function syncBuiltInHooks(): void {
  if (supersessionDetectOn()) registerSupersessionHook(registerPostPublishHook);
  else unregisterPostPublishHook(SUPERSESSION_HOOK);
  if (!translationAfterPublishOn()) unregisterPostPublishHook(TRANSLATION_HOOK);
  else if (asyncIngestOn()) {
    registerPostPublishHook(
      TRANSLATION_HOOK,
      async (event, signal) => {
        await enqueueTranslateJobs(event, signal);
      },
      { timeoutMs: QUEUED_TRANSLATION_HOOK_TIMEOUT_MS },
    );
  } else registerTranslationHook(registerPostPublishHook);
}

export function resetPostPublishHooksForTests(): void {
  hooks.length = 0;
}

class HookTimeout extends Error {
  constructor() {
    super('post-publish hook timed out');
    this.name = 'HookTimeout';
  }
}

async function runOne(hook: RegisteredHook, event: PostPublishEvent): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HookTimeout());
    }, hook.timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => hook.run(event, controller.signal)), timeout]);
  } catch (error) {
    console.warn('[Ingest] post-publish hook failed', {
      hook: hook.name,
      documentId: event.documentId,
      error: error instanceof HookTimeout ? 'timeout' : error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const inflight = new Set<Promise<void>>();

/** Runs every registered hook in registration order; resolves when all have finished or timed out, and never rejects. */
export async function afterPublish(event: PostPublishEvent): Promise<void> {
  const run = (async () => {
    syncBuiltInHooks();
    for (const hook of hooks.slice()) await runOne(hook, event);
  })();
  inflight.add(run);
  try {
    await run;
  } finally {
    inflight.delete(run);
  }
}

/** Tests only: resolves once every afterPublish started so far (and any it started in turn) has finished. */
export async function postPublishSettledForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}
