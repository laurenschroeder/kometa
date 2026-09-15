// Single source of truth for achievement copy — edit here, not in
// ui/start-menu.uikitml (whose achievement-row element ids are hand-matched
// to these `id`s, same coupling convention ui/phase-menu.uikitml already
// uses for its per-phase buttons).
export interface AchievementDef {
  id: string;
  title: string;
  description: string;
}

// Every entry here is tied to a specific mission/gameplay outcome rather
// than just "you reached the next phase" (the old list's shape) — see
// achievement-system.ts's own class comment for why that means this system
// no longer drives unlocks itself; each one is fired directly by whichever
// system owns that moment.
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'full-sweep', title: 'Full Sweep', description: 'Clear every mote from all three Stardust swirls before the phase ends.' },
  { id: 'ambidextrous', title: 'Ambidextrous', description: 'Toss the comet to your other hand and catch it.' },
  { id: 'true-believer', title: 'True Believer', description: "Finish Pebbles with one type making up 90% or more of what you gathered." },
  { id: 'perfect-balance', title: 'Perfect Balance', description: 'Finish Pebbles with all three types gathered in close to even measure.' },
  { id: 'soul-collector', title: 'Soul Collector', description: 'Gather every detached soul in the graveyard.' },
  { id: 'green-thumb', title: 'Green Thumb', description: 'Gather every seed offered to you.' },
  { id: 'faced-the-mob', title: 'Faced the Mob', description: 'Face every last member of the angry, grieving crowd.' },
  { id: 'eternal-light', title: 'Eternal Light', description: 'Choose to orbit the planet forever.' },
  { id: 'into-the-unknown', title: 'Into the Unknown', description: 'Choose to launch onward into the universe.' },
  { id: 'complete-collection', title: 'Complete Collection', description: 'Experience every combination of comet type and final choice.' },
];
