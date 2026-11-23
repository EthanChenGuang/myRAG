export const adminIds = new Set<string>();
export const adminDb = { failing: false };

export function createFakeAdminDb() {
  return {
    from(table: string) {
      if (table !== 'admin_users') throw new Error(`unexpected table ${table}`);
      let id: string | undefined;
      const builder = {
        select: () => builder,
        eq: (_column: string, value: string) => {
          id = value;
          return builder;
        },
        abortSignal: () => builder,
        maybeSingle: async () => {
          if (adminDb.failing) return { data: null, error: { message: 'down' } };
          return { data: id && adminIds.has(id) ? { id } : null, error: null };
        },
      };
      return builder;
    },
    auth: {},
  };
}
