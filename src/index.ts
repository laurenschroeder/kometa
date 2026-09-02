import { AssetType, DomeGradient, launchXR, SessionMode, VisibilityState, World } from '@iwsdk/core';
import { CometAudioSystem } from './comet/comet-audio-system.js';
import { CometAutopilotSystem } from './comet/comet-autopilot-system.js';
import { CometBody } from './comet/comet-body-component.js';
import { CometHandoffSystem } from './comet/comet-handoff-system.js';
import { CometCaught, CometReleased, CometSnapped } from './comet/comet-event-tags.js';
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
import { StarfieldSystem } from './core/starfield-system.js';
import { SkyBackdropSystem } from './core/sky-backdrop-system.js';
import { StartMenuSystem } from './core/start-menu-system.js';
import { ConstellationsSystem } from './phases/constellations/constellations-system.js';
import { ConstellationsVfxSystem } from './phases/constellations/constellations-vfx-system.js';
import { EarthSituationsVfxSystem } from './phases/fate-events/earth-situations-vfx-system.js';
import { FateEventSystem } from './phases/fate-events/fate-event-system.js';
import { FateEventVfxSystem } from './phases/fate-events/fate-event-vfx-system.js';
import { EndRunMenuSystem } from './phases/finale/end-run-menu-system.js';
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

  // Explicit, always-visible fallback for entering XR (see index.html) —
  // the `offer: 'always'` config above already asks the browser to show its
  // own native "enter VR" affordance via navigator.xr.offerSession, but
  // that's a Quest-Browser-specific extension to the WebXR spec; browsers
  // without it show nothing at all with no other way in. Shown only while
  // NonImmersive (browser/2D mode) and hidden the instant a session starts;
  // VisibilityState returns to NonImmersive on its own if the session ends,
  // which re-shows it — no separate session-end handling needed here.
  const enterVrButton = document.getElementById('enter-vr-button') as HTMLButtonElement | null;
  if (enterVrButton) {
    enterVrButton.addEventListener('click', () => launchXR(world));
    world.visibilityState.subscribe((state) => {
      enterVrButton.style.display = state === VisibilityState.NonImmersive ? 'block' : 'none';
    });
  }

  world.renderer.setClearColor(0x000000, 1.0);

  // A faint navy->teal gradient instead of a pure void — subtle enough not
  // to read as "daytime sky" in a space setting, just enough haze that the
  // backdrop isn't flat black. StarfieldSystem's background stars and
  // SkyBackdropSystem's hero star render over the top of this.
  const root = world.activeLevel.value;
  const DOME_COLORS: Record<'sky' | 'equator' | 'ground', [number, number, number, number]> = {
    sky: [0.01, 0.02, 0.05, 1],
    equator: [0.02, 0.05, 0.07, 1],
    ground: [0.01, 0.01, 0.02, 1],
  };
  for (const key of ['sky', 'equator', 'ground'] as const) {
    const v = root.getVectorView(DomeGradient, key) as Float32Array;
    v.set(DOME_COLORS[key]);
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
    .registerComponent(CometReleased)
    .registerComponent(CometCaught);

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
    .registerSystem(PebbleCometPresentationSystem, { priority: 20 })
    // Reacts to CometSnapped/CometReleased (added by CometPhysicsSystem,
    // priority 10) and CometCaught (added by CometHandoffSystem, priority
    // 9) — must run after both, same visual-sync band as
    // PebbleCometPresentationSystem.
    .registerSystem(CometAudioSystem, { priority: 21 });

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

  // Distant background starfield — always-on, visible from the start menu
  // through every phase, never GameDirector-managed (see its own comments).
  // No dependencies on any other system, so registration order doesn't
  // matter; priority just needs to land in the visual-sync band.
  world.registerSystem(StarfieldSystem, { priority: 21 });

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

  // PlanetSeedingVfxSystem is registered but, like StardustVfxSystem, never
  // passed to definePhase() — the planet (and its orbiting moons) persist
  // as permanent scenery from Seeding onward (matching
  // PebbleCometPresentationSystem's own become-visible-from-Seeding-onward
  // treatment), so it self-gates via gamePhase instead of being director
  // play()/stop()-managed. Must be registered before ConstellationsSystem/
  // FateEventSystem below — both look it up via getSystem() in their own
  // init() (it's what grows the Seeding planet into the big Fate-Events
  // planet, now kicked off as Constellations begins rather than at Fate
  // Events itself).
  world
    .registerSystem(PlanetSeedingSystem, { priority: 30 })
    .registerSystem(PlanetSeedingVfxSystem, { priority: 32 });
  director.definePhase(Phase.Seeding, {
    systems: [world.getSystem(PlanetSeedingSystem)!],
    timeoutSeconds: 90,
  });

  // ConstellationsVfxSystem is registered but, like StardustVfxSystem/
  // PlanetSeedingVfxSystem, never passed to definePhase() — a completed
  // constellation's stars persist as permanent sky scenery, so it self-gates
  // visibility via gamePhase instead of being director play()/stop()-managed.
  world
    .registerSystem(ConstellationsSystem, { priority: 30 })
    .registerSystem(ConstellationsVfxSystem, { priority: 32 });
  director.definePhase(Phase.Constellations, {
    systems: [world.getSystem(ConstellationsSystem)!],
    timeoutSeconds: 120,
  });

  // The hero star that reveals once a constellation is won — never passed to
  // definePhase(), same self-gated idiom as StardustVfxSystem/
  // PlanetSeedingVfxSystem/StarfieldSystem. Must be registered after
  // ConstellationsSystem above, which it looks up via getSystem() in its own
  // init() (the hero star joins the winning constellation's own star
  // cluster).
  world.registerSystem(SkyBackdropSystem, { priority: 5 });

  // FateEventVfxSystem is registered but, unlike before, no longer passed to
  // definePhase() — its people now start appearing progressively during
  // Constellations (see its own gamePhase subscription), so it self-gates
  // via gamePhase like ConstellationsVfxSystem/PlanetSeedingVfxSystem
  // instead of being director play()/stop()-managed. FateEventSystem itself
  // stays director-managed — its proximity/dialogue simulation still only
  // runs during Phase.FateEvents.
  world
    .registerSystem(FateEventSystem, { priority: 30 })
    .registerSystem(FateEventVfxSystem, { priority: 32 });
  director.definePhase(Phase.FateEvents, {
    systems: [world.getSystem(FateEventSystem)!],
    // Paired with FateEventSystem's own MIN_PHASE_SECONDS (55) — together
    // they keep this phase at roughly a minute either way, whether the
    // player lingers with the crowd or rushes through it.
    timeoutSeconds: 65,
  });

  // Per-constellation "situation on Earth" — ambient decorations, the
  // ghost-rise-and-attach payoff, and the paired-dialogue mechanic (see its
  // own comments). Always-on/self-gated like FateEventVfxSystem, never
  // definePhase()-managed — the ghost attachment persists straight through
  // Launch/Finale. Registered after PlanetSeedingVfxSystem/
  // ConstellationsSystem/FateEventSystem, all three of which it looks up
  // via getSystem() in its own init().
  world.registerSystem(EarthSituationsVfxSystem, { priority: 33 });

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

  world
    .registerSystem(FinaleSystem, { priority: 30 })
    .registerSystem(EndRunMenuSystem, { priority: 30 });
  director.definePhase(Phase.Finale, {
    systems: [world.getSystem(FinaleSystem)!, world.getSystem(EndRunMenuSystem)!],
    // No timeoutSeconds: this phase no longer auto-advances. Finale plays
    // out (CometAutopilotSystem keeps driving the comet's orbit/launch
    // right through it, always-on and not phase-gated) until
    // EndRunMenuSystem's own delay elapses and shows the end-of-run choice
    // — the player picks "Make a New Comet" (jumpToPhase) or "Main Menu"
    // (returnToMenu) rather than the loop cutting back to Stardust on its
    // own.
  });

  // director.start() is deliberately NOT called here — StartMenuSystem
  // calls it once the Start button is dwell-selected, gating the whole
  // game behind the start menu.
});
