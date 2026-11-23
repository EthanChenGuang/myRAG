import { after } from 'next/server';

/** Runs the task after the response when a request scope exists, otherwise as a detached promise. Never throws; task failures are swallowed. */
export function scheduleAfterResponse(task: () => Promise<void>): void {
  const guarded = async (): Promise<void> => {
    try {
      await task();
    } catch {
      // the task owns its own fallback logging
    }
  };
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}
