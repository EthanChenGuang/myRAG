export class FeedbackMiningConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export function readFeedbackLoopConfig(_source?: Record<string, string | undefined>, _log?: (message: string) => void): any {
  return { warnings: [] };
}

export function loadFeedbackMiningConfig(_filePath?: string): any {
  return { config: {}, sha256: '' };
}
