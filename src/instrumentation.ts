export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const {
        verifyAccessGroupsStartup,
        verifyActiveEmbeddingProfileAtStartup,
        verifyLanguageSettingsAtStartup,
        verifyLanguagesAgainstEmbeddingProfileAtStartup,
        verifyV2Startup,
      } = await import('@/lib/rag');
      // [RAG Languages] D-02: the language check logs once and never throws.
      await Promise.all([
        verifyActiveEmbeddingProfileAtStartup(),
        verifyV2Startup(),
        Promise.resolve().then(() => verifyLanguageSettingsAtStartup()),
        verifyLanguagesAgainstEmbeddingProfileAtStartup(),
        verifyAccessGroupsStartup(),
      ]);
    } catch {
      // The check logs its own failures; a broken import must not stop the server from starting.
    }
  }
}
