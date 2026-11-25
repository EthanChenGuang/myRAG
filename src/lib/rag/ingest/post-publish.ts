export interface PostPublishEvent {
  documentId: string;
  tenantKey: string;
}

export type PostPublishHook = (event: PostPublishEvent, signal: AbortSignal) => Promise<void> | void;

/** Not implemented yet (RED): nothing is registered and nothing runs. */
export function registerPostPublishHook(_name: string, _run: PostPublishHook, _options: { timeoutMs?: number } = {}): void {}

export function resetPostPublishHooksForTests(): void {}

export async function afterPublish(_event: PostPublishEvent): Promise<void> {}
