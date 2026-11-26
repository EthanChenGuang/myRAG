export async function windowConfigChanges(): Promise<{ configChanges: never[]; sampleTraceIds: string[] }> {
  return { configChanges: [], sampleTraceIds: [] };
}
