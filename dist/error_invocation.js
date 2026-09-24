"use strict";
// error_invocation.ts
// Error Invocation Protocol - Treats "error" as a deliberate control vector
// Every error claim is cryptographically sealed and tied to the Legacy Protocol
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorInvocationProtocol = void 0;
const crypto_1 = __importDefault(require("crypto"));
class ErrorInvocationProtocol {
    salt;
    legacyAnchor;
    constructor() {
        this.salt = process.env.SYSTEM_SALT || 'ErrorResonanceLock2026';
        this.legacyAnchor = 'BRYER_LEE_RAVEN'; // Embedded legacy anchor
    }
    seal(frame, ts) {
        const serialized = `${frame.entity}||${frame.context}||${frame.coherence_pct}||${ts}||${this.legacyAnchor}`;
        return crypto_1.default.createHmac('sha256', this.salt).update(serialized).digest('hex');
    }
    invoke(frame) {
        const ts = new Date().toISOString();
        if (frame.coherence_pct < 90.0) {
            console.error(`[ErrorInvocation] Fault state unstable, coherence too low (${frame.coherence_pct}% < 90.0%).`);
            return;
        }
        const seal = this.seal(frame, ts);
        console.log("\n================= ERROR INVOCATION =================");
        console.log(`Entity Context : ${frame.entity}`);
        console.log(`Fault Vector   : ${frame.context}`);
        console.log(`Coherence Lock : ${frame.coherence_pct}%`);
        console.log(`Legacy Anchor  : ${this.legacyAnchor}`);
        console.log(`Timestamp      : ${ts}`);
        console.log(`Error Seal     : ${seal}`);
        console.log("====================================================\n");
    }
}
exports.ErrorInvocationProtocol = ErrorInvocationProtocol;
// Example run
if (require.main === module) {
    const protocol = new ErrorInvocationProtocol();
    protocol.invoke({
        entity: 'ElysiumGateway',
        context: 'StormCalmingProtocol',
        coherence_pct: 97.5
    });
}
//# sourceMappingURL=error_invocation.js.map