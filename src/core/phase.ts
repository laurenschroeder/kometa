export enum Phase {
  Stardust = 'stardust',
  Pebbles = 'pebbles',
  Constellations = 'constellations',
  Seeding = 'seeding',
  FateEvents = 'fateEvents',
  Launch = 'launch',
  Finale = 'finale',
}

// Canonical cycle order — the single source of truth GameDirectorSystem
// advances through, so adding/reordering a phase never requires touching
// director logic itself.
export const PHASE_ORDER: readonly Phase[] = [
  Phase.Stardust,
  Phase.Pebbles,
  Phase.Seeding,
  Phase.Constellations,
  Phase.FateEvents,
  Phase.Launch,
  Phase.Finale,
];

export function nextPhase(current: Phase): Phase {
  const idx = PHASE_ORDER.indexOf(current);
  return PHASE_ORDER[(idx + 1) % PHASE_ORDER.length];
}
