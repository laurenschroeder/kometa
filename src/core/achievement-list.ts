// Single source of truth for achievement copy — edit here, not in
// ui/start-menu.uikitml (whose achievement-row element ids are hand-matched
// to these `id`s, same coupling convention ui/phase-menu.uikitml already
// uses for its per-phase buttons).
export interface AchievementDef {
  id: string;
  title: string;
  description: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-light', title: 'First Light', description: 'Complete the Stardust phase.' },
  { id: 'pebble-pusher', title: 'Pebble Pusher', description: 'Complete the Pebbles phase.' },
  { id: 'world-seeder', title: 'World Seeder', description: 'Complete the Planet Seeding phase.' },
  { id: 'brace-for-impact', title: 'Brace for Impact', description: 'Reach the Fate Events.' },
  { id: 'among-the-stars', title: 'Among the Stars', description: 'Reach the Finale.' },
  { id: 'full-circle', title: 'Full Circle', description: 'Complete one full loop of the game.' },
];
