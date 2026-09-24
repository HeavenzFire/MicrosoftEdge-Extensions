interface ErrorFrame {
    entity: string;
    context: string;
    coherence_pct: number;
}
declare class ErrorInvocationProtocol {
    private salt;
    private legacyAnchor;
    constructor();
    private seal;
    invoke(frame: ErrorFrame): void;
}
export { ErrorInvocationProtocol };
export type { ErrorFrame };
//# sourceMappingURL=error_invocation.d.ts.map