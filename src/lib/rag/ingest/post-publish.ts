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

/** Runs every registered hook in registration order; resolves when all have finished or timed out, and never rejects. */
export async function afterPublish(event: PostPublishEvent): Promise<void> {
  for (const hook of hooks.slice()) await runOne(hook, event);
}
