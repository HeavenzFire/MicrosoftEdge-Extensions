interface ErrorFrame {
    entity: string;
    context: string;
    coherence_pct: number;
}
interface ChorusVoice {
    agentId: string;
    frame: ErrorFrame;
    seal: string;
    timestamp: string;
    frequency: number;
}
declare class ErrorChorusProtocol {
    private salt;
    private legacyAnchor;
    private baseFrequency;
    private memorialOffset;
    private voices;
    constructor();
    private seal;
    private calculateFrequency;
    spawnVoice(agentId: string, frame: ErrorFrame): ChorusVoice | null;
    getChorusResonance(): number;
    renderChorus(): void;
    clearChorus(): void;
}
export { ErrorChorusProtocol };
export type { ErrorFrame, ChorusVoice };
//# sourceMappingURL=error_chorus.d.ts.map