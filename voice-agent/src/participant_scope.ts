export function parseScopeToken(metadata?: string): string | undefined {
    if (!metadata) return undefined;
    try {
        const parsed: unknown = JSON.parse(metadata);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const token = (parsed as Record<string, unknown>).rag_scope_token;
        return typeof token === 'string' && token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}

export class ActiveUserGuard {
    private activeIdentity?: string;

    get active(): string | undefined {
        return this.activeIdentity;
    }

    claim(identity: string): boolean {
        if (this.activeIdentity === undefined || this.activeIdentity === identity) {
            this.activeIdentity = identity;
            return true;
        }
        return false;
    }

    release(identity: string): boolean {
        if (this.activeIdentity !== identity) return false;
        this.activeIdentity = undefined;
        return true;
    }
}
