// Single source of truth for achievement copy — edit here, not in
// ui/start-menu.uikitml (whose achievement-row element ids are hand-matched
// to these `id`s, same coupling convention ui/phase-menu.uikitml already
// uses for its per-phase buttons).
export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  // Stumble-upon achievements: the Achievements page shows SECRET_TITLE/
  // SECRET_DESCRIPTION in place of the real copy until unlocked (see
  // StartMenuSystem._refreshAchievementRows). The real title/description
  // here are what it swaps in, so keep them matching the menu's wording.
  secret?: boolean;
}

export const SECRET_TITLE = '?';
// ASCII "..." — the MSDF font atlases only bake printable ASCII.
export const SECRET_DESCRIPTION = 'Keep exploring...';

// Every entry here is tied to a specific mission/gameplay outcome rather
// than just "you reached the next phase" (the old list's shape) — see
// achievement-system.ts's own class comment for why that means this system
// no longer drives unlocks itself; each one is fired directly by whichever
// system owns that moment.
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'stargazer', title: 'Stargazer', description: 'Wander far enough from the comet to gather a distant speck of stardust.', secret: true },
  { id: 'far-side', title: 'Far Side', description: 'Seed the side of the planet facing directly away from where you started.', secret: true },
  { id: 'second-thoughts', title: 'Second Thoughts', description: 'Linger at both choice zones before finally committing to one.', secret: true },
  { id: 'full-sweep', title: 'Full Sweep', description: 'Clear every mote from all three Stardust swirls before the phase ends.' },
  { id: 'ambidextrous', title: 'Ambidextrous', description: 'Toss the comet to your other hand and catch it.', secret: true },
  { id: 'true-believer', title: 'True Believer', description: "Finish collecting pebbles with one type making up 90% or more of what you gathered." },
  { id: 'perfect-balance', title: 'Perfect Balance', description: 'Finish collecting pebbles with all three types gathered in close to even measure.' },
  { id: 'soul-collector', title: 'Soul Collector', description: 'Gather every detached soul in the graveyard.' },
  { id: 'green-thumb', title: 'Green Thumb', description: 'Gather every seed offered to you.' },
  { id: 'faced-the-mob', title: 'Faced the Mob', description: 'Face every last member of the angry, grieving crowd.' },
  { id: 'eternal-light', title: 'Eternal Light', description: 'Choose to orbit the planet forever.' },
  { id: 'into-the-unknown', title: 'Into the Unknown', description: 'Choose to launch onward into the universe.' },
  { id: 'indecisive', title: 'Indecisive', description: "Let the clock run out without choosing your comet's fate.", secret: true },
  { id: 'complete-collection', title: 'Complete Collection', description: 'Experience every combination of comet type and final choice.' },
];
