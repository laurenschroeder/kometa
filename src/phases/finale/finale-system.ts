import { createSystem } from '@iwsdk/core';

// Placeholder for the real zoom-out + stardust-regeneration finale
// sequence. Modeled as "just another phase" — relies purely on its
// configured timeoutSeconds (see index.ts) and never sets
// globals.phaseComplete, which is what proves the director needs no
// special-cased branch for a phase with no win condition.
export class FinaleSystem extends createSystem({}) {}
