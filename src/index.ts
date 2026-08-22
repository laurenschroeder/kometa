import { AssetType, DomeGradient, SessionMode, World } from '@iwsdk/core';
import { CometAutopilotSystem } from './comet/comet-autopilot-system.js';
import { CometBody } from './comet/comet-body-component.js';
import { CometHandoffSystem } from './comet/comet-handoff-system.js';
import { CometReleased, CometSnapped } from './comet/comet-event-tags.js';
import { CometPhysicsSystem } from './comet/comet-physics-system.js';
import { CometTrail } from './comet/comet-trail-component.js';
import { CometTrailSystem } from './comet/comet-trail-system.js';
import { HandAnchor, HandSide } from './comet/hand-anchor-component.js';
import { AchievementSystem } from './core/achievement-system.js';
import { bootstrapGlobals } from './core/globals.js';
import { GameDirectorSystem } from './core/game-director-system.js';
import { HudText, NotificationHudSystem } from './core/notification-hud-system.js';
import { Phase } from './core/phase.js';
import { PhaseMenuSystem } from './core/phase-menu-system.js';
import { StartMenuSystem } from './core/start-menu-system.js';
import { ConstellationsSystem } from './phases/constellations/constellations-system.js';
import { ConstellationsVfxSystem } from './phases/constellations/constellations-vfx-system.js';
import { FateEventSystem } from './phases/fate-events/fate-event-system.js';
import { FateEventVfxSystem } from './phases/fate-events/fate-event-vfx-system.js';
import { FinaleSystem } from './phases/finale/finale-system.js';
import { OrbitalLaunchSystem } from './phases/orbital-launch/orbital-launch-system.js';
import { OrbitalLaunchVfxSystem } from './phases/orbital-launch/orbital-launch-vfx-system.js';
import { PebbleCometPresentationSystem } from './phases/pebbles/pebble-comet-presentation-system.js';
import { PebbleFieldVfxSystem } from './phases/pebbles/pebble-field-vfx-system.js';
import { PebbleWeavingSystem } from './phases/pebbles/pebble-weaving-system.js';
import { PlanetSeedingSystem } from './phases/planet-seeding/planet-seeding-system.js';
import { PlanetSeedingVfxSystem } from './phases/planet-seeding/planet-seeding-vfx-system.js';
import { StardustSystem } from './phases/stardust/stardust-system.js';
import { StardustVfxSystem } from './phases/stardust/stardust-vfx-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, {
  assets: {
    beepchat1: { url: '/textures/beepchat1.png', type: AssetType.Texture },
    beepchat2: { url: '/textures/beepchat2.png', type: AssetType.Texture },
    beepchat3: { url: '/textures/beepchat3.png', type: AssetType.Texture },
    beepchat4: { url: '/textures/beepchat4.png', type: AssetType.Texture },
    smile1: { url: '/textures/Sprite-0001.png', type: AssetType.Texture },
    smile2: { url: '/textures/Sprite-0002.png', type: AssetType.Texture },
    dustLand: { url: '/audio/dust-land.wav', type: AssetType.Audio },
  },
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: 'always',
    features: { handTracking: true },
  },
  features: {
    locomotion: false,
    grabbing: false,
    physics: false,
    sceneUnderstanding: false,
    // <hudtext> in ui/notification-hud.uikitml — a custom kit tag (not
    // plain <span>) so the "hud" font-family registration can be baked in
    // via defaultOverrides at true component-construction time. See
    // HudText's own comment: setting fontFamilies via setProperties() on
    // an already-built element doesn't retroactively reshape its glyphs.
    spatialUI: { kits: { hudtext: HudText } },
  },
}).then((world) => {
  bootstrapGlobals(world);

  world.renderer.setClearColor(0x000000, 1.0);

  const root = world.activeLevel.value;
  for (const key of ['sky', 'equator', 'ground'] as const) {
    const v = root.getVectorView(DomeGradient, key) as Float32Array;
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 1;
  }
  root.setValue(DomeGradient, '_needsUpdate', true);

  // Components must be registered before any system query references them
  // (query bitmasks are computed at registerSystem time) and before the
  // comet entities below add them.
  world
    .registerComponent(CometBody)
    .registerComponent(HandAnchor)
    .registerComponent(CometTrail)
    .registerComponent(CometSnapped)
    .registerComponent(CometReleased);

  // comet/ (handoff + physics + trail) is the reusable spring-joint
  // mechanic, always on. PebbleCometPresentationSystem is the persistent,
  // ever-evolving comet visual — also always on, never phase-gated (see
  // plan doc). Priorities follow the input(0-9)/simulation(10-19)/
  // visual-sync(20-29) convention — CometHandoffSystem must run before
  // CometPhysicsSystem so a hand switch it decides this frame is what
  // physics follows this same frame.
  world
    .registerSystem(CometHandoffSystem, { priority: 9 })
    .registerSystem(CometPhysicsSystem, { priority: 10 })
    .registerSystem(CometTrailSystem, { priority: 15 })
    .registerSystem(PebbleCometPresentationSystem, { priority: 20 });

  // There's exactly one comet, defaulting to the right hand — see
  // CometHandoffSystem for how it switches (passive drift after 2s with
  // only one hand tracked, or an active toss/catch).
  const comet = world.createEntity();
  comet.addComponent(CometBody);
  comet.addComponent(HandAnchor, { hand: HandSide.Right, palmOffsetZ: 0.08 });
  comet.addComponent(CometTrail);

  // GameDirectorSystem must run at priority 0 — before every phase-gated
  // system — so a transition it detects this tick gates play()/stop()
  // before those systems execute later in the same pass.
  world.registerSystem(GameDirectorSystem, { priority: 0 });
  const director = world.getSystem(GameDirectorSystem)!;

  // Left-hand-pinch dev menu — jumps directly to any phase. Registered after
  // GameDirectorSystem (which it looks up via getSystem in its own init()).
  world.registerSystem(PhaseMenuSystem, { priority: 5 });

  // Gates director.start() behind the Start button's dwell-select — see
  // its own comments. director.start() is called from inside
  // StartMenuSystem itself, not from this file.
  world.registerSystem(StartMenuSystem, { priority: 5 });

  // View-locked HUD flashing each phase's instructional blurb — always-on,
  // reacts to globals.gamePhase directly (see its own gamePhase.subscribe),
  // never GameDirector-managed.
  world.registerSystem(NotificationHudSystem, { priority: 35 });

  // Always-on, gamePhase-driven achievement unlocking (see its own
  // comments) — order relative to NotificationHudSystem doesn't matter,
  // it looks NotificationHudSystem up lazily via getSystem() on unlock.
  world.registerSystem(AchievementSystem, { priority: 36 });

  // StardustVfxSystem is registered but deliberately never passed to
  // definePhase() — its captured-mote pools need to keep rendering through
  // Pebbles and Seeding (see its own gamePhase subscription), so it stays
  // always-on from boot like PebbleCometPresentationSystem, rather than
  // being GameDirector play()/stop()-gated to Stardust only.
  world
    .registerSystem(StardustSystem, { priority: 30 })
    .registerSystem(StardustVfxSystem, { priority: 32 });
  director.definePhase(Phase.Stardust, {
    systems: [world.getSystem(StardustSystem)!],
    timeoutSeconds: 90,
  });

  world
    .registerSystem(PebbleWeavingSystem, { priority: 30 })
    .registerSystem(PebbleFieldVfxSystem, { priority: 32 });
  director.definePhase(Phase.Pebbles, {
    systems: [world.getSystem(PebbleWeavingSystem)!, world.getSystem(PebbleFieldVfxSystem)!],
    timeoutSeconds: 180,
  });

  // ConstellationsVfxSystem is registered but, like StardustVfxSystem/
  // PlanetSeedingVfxSystem, never passed to definePhase() — the winning
  // constellation's stars persist as permanent sky scenery once a winner is
  // set, so it self-gates visibility via gamePhase instead of being
  // director play()/stop()-managed.
  world
    .registerSystem(ConstellationsSystem, { priority: 30 })
    .registerSystem(ConstellationsVfxSystem, { priority: 32 });
  director.definePhase(Phase.Constellations, {
    systems: [world.getSystem(ConstellationsSystem)!],
    timeoutSeconds: 120,
  });

  // PlanetSeedingVfxSystem is registered but, like StardustVfxSystem, never
  // passed to definePhase() — the 9 planets persist as permanent scenery
  // from Seeding onward (matching PebbleCometPresentationSystem's own
  // become-visible-from-Seeding-onward treatment), so it self-gates via
  // gamePhase instead of being director play()/stop()-managed.
  world
    .registerSystem(PlanetSeedingSystem, { priority: 30 })
    .registerSystem(PlanetSeedingVfxSystem, { priority: 32 });
  director.definePhase(Phase.Seeding, {
    systems: [world.getSystem(PlanetSeedingSystem)!],
    timeoutSeconds: 90,
  });

  world
    .registerSystem(FateEventSystem, { priority: 30 })
    .registerSystem(FateEventVfxSystem, { priority: 32 });
  director.definePhase(Phase.FateEvents, {
    systems: [world.getSystem(FateEventSystem)!, world.getSystem(FateEventVfxSystem)!],
    timeoutSeconds: 35,
  });

  world
    .registerSystem(OrbitalLaunchSystem, { priority: 30 })
    .registerSystem(OrbitalLaunchVfxSystem, { priority: 32 });
  // CometAutopilotSystem is an always-on comet/ system (drives the comet
  // once OrbitalLaunchSystem detaches it — see its own comments), but it
  // must be registered after OrbitalLaunchSystem since it looks that system
  // up via getSystem() in its own init(). Registration order only matters
  // for that lookup — its priority (12, simulation band) is what actually
  // controls per-frame execution order, same as NotificationHudSystem(35)
  // above running after every priority-30 phase system despite being
  // registered earlier in this file.
  world.registerSystem(CometAutopilotSystem, { priority: 12 });
  director.definePhase(Phase.Launch, {
    systems: [world.getSystem(OrbitalLaunchSystem)!, world.getSystem(OrbitalLaunchVfxSystem)!],
    timeoutSeconds: 30,
  });

  world.registerSystem(FinaleSystem, { priority: 30 });
  director.definePhase(Phase.Finale, {
    systems: [world.getSystem(FinaleSystem)!],
    // Bumped from 10 — CometAutopilotSystem keeps driving the comet's
    // orbit/launch right through this phase (it's always-on, not
    // phase-gated), so this needs enough time for that payoff to actually
    // read before the loop cuts back to Stardust.
    timeoutSeconds: 18,
  });

  // director.start() is deliberately NOT called here — StartMenuSystem
  // calls it once the Start button is dwell-selected, gating the whole
  // game behind the start menu.
});
