export function parseScopeToken(_metadata?: string): string | undefined {
    return undefined;
}

export class ActiveUserGuard {
    claim(_identity: string): boolean {
        return true;
    }

    release(_identity: string): boolean {
        return false;
    }

    get active(): string | undefined {
        return undefined;
    }
}
