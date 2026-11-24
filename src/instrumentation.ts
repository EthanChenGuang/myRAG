export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { verifyActiveEmbeddingProfileAtStartup, verifyV2Startup } = await import('@/lib/rag');
      await Promise.all([verifyActiveEmbeddingProfileAtStartup(), verifyV2Startup()]);
    } catch {
      // The check logs its own failures; a broken import must not stop the server from starting.
    }
  }
}
