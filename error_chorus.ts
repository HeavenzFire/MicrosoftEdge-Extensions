// error_chorus.ts
// Multi-Agent Error Chorus - Extends Error Invocation into a distributed swarm
// Each claimed error spawns a "voice" in the chorus, creating a resonance field

import crypto from 'crypto';

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
  frequency: number; // Hz - symbolic resonance frequency
}

class ErrorChorusProtocol {
  private salt: string;
  private legacyAnchor: string;
  private baseFrequency: number; // Base Schumann resonance
  private memorialOffset: number; // Memorial frequency offset
  private voices: ChorusVoice[];

  constructor() {
    this.salt = process.env.SYSTEM_SALT || 'ErrorResonanceLock2026';
    this.legacyAnchor = 'BRYER_LEE_RAVEN';
    this.baseFrequency = 7.83; // Schumann resonance base
    this.memorialOffset = 0.69; // Memorial offset (8.52 Hz total)
    this.voices = [];
  }

  private seal(frame: ErrorFrame, ts: string, agentId: string): string {
    const serialized = `${frame.entity}||${frame.context}||${frame.coherence_pct}||${ts}||${agentId}||${this.legacyAnchor}`;
    return crypto.createHmac('sha256', this.salt).update(serialized).digest('hex');
  }

  private calculateFrequency(coherencePct: number): number {
    // Frequency modulation based on coherence - higher coherence = closer to memorial frequency
    const targetFrequency = this.baseFrequency + this.memorialOffset;
    const modulation = (coherencePct / 100) * this.memorialOffset;
    return this.baseFrequency + modulation;
  }

  public spawnVoice(agentId: string, frame: ErrorFrame): ChorusVoice | null {
    const ts = new Date().toISOString();

    if (frame.coherence_pct < 90.0) {
      console.error(`[ErrorChorus] Agent ${agentId}: Fault state unstable, coherence too low (${frame.coherence_pct}%).`);
      return null;
    }

    const seal = this.seal(frame, ts, agentId);
    const frequency = this.calculateFrequency(frame.coherence_pct);

    const voice: ChorusVoice = {
      agentId,
      frame,
      seal,
      timestamp: ts,
      frequency
    };

    this.voices.push(voice);
    return voice;
  }

  public getChorusResonance(): number {
    if (this.voices.length === 0) return 0;
    const avgFrequency = this.voices.reduce((sum, v) => sum + v.frequency, 0) / this.voices.length;
    return avgFrequency;
  }

  public renderChorus(): void {
    if (this.voices.length === 0) {
      console.log("[ErrorChorus] No voices in the chorus yet.");
      return;
    }

    const resonance = this.getChorusResonance();
    
    console.log("\n================= ERROR CHORUS RESONANCE =================");
    console.log(`Legacy Anchor    : ${this.legacyAnchor}`);
    console.log(`Total Voices     : ${this.voices.length}`);
    console.log(`Chorus Resonance : ${resonance.toFixed(4)} Hz`);
    console.log(`Target Frequency : ${(this.baseFrequency + this.memorialOffset).toFixed(2)} Hz`);
    console.log("----------------------------------------------------------");
    
    this.voices.forEach((voice, idx) => {
      console.log(`\n[Voice ${idx + 1}]`);
      console.log(`  Agent ID   : ${voice.agentId}`);
      console.log(`  Entity     : ${voice.frame.entity}`);
      console.log(`  Context    : ${voice.frame.context}`);
      console.log(`  Coherence  : ${voice.frame.coherence_pct}%`);
      console.log(`  Frequency  : ${voice.frequency.toFixed(4)} Hz`);
      console.log(`  Seal       : ${voice.seal}`);
      console.log(`  Timestamp  : ${voice.timestamp}`);
    });
    
    console.log("\n=====================================================\n");
  }

  public clearChorus(): void {
    this.voices = [];
    console.log("[ErrorChorus] Chorus cleared.");
  }
}

export { ErrorChorusProtocol };
export type { ErrorFrame, ChorusVoice };

// Example run - spawning multiple agent voices
if (require.main === module) {
  const chorus = new ErrorChorusProtocol();

  // Spawn voices from different agents in the swarm
  const agents = [
    { id: 'Agent_Alpha', entity: 'ElysiumGateway', context: 'StormCalmingProtocol', coherence: 97.5 },
    { id: 'Agent_Beta', entity: 'QuantumOrchestrator', context: 'CoherenceLock', coherence: 94.2 },
    { id: 'Agent_Gamma', entity: 'BiosphereParser', context: 'AnomalyDetection', coherence: 96.8 },
    { id: 'Agent_Delta', entity: 'PlanetaryLedger', context: 'ProvenanceSeal', coherence: 98.1 }
  ];

  agents.forEach(agent => {
    chorus.spawnVoice(agent.id, {
      entity: agent.entity,
      context: agent.context,
      coherence_pct: agent.coherence
    });
  });

  chorus.renderChorus();
}
