import { AssetType, launchXR, SessionMode, VisibilityState, World } from '@iwsdk/core';
import { ART_TEST_ENABLED, ArtTestSystem } from './phases/art-test/art-test-system.js';
import { ArtTestVfxSystem } from './phases/art-test/art-test-vfx-system.js';
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
import { BackgroundMusicSystem } from './core/background-music-system.js';
import { bootstrapGlobals } from './core/globals.js';
import { DevJumpSystem } from './core/dev-jump-system.js';
import { DevPerfLoggerSystem } from './core/dev-perf-logger.js';
import { GameDirectorSystem } from './core/game-director-system.js';
import { HapticsSystem } from './core/haptics-system.js';
import { ContinueButtonSystem } from './core/continue-button-system.js';
import { HandProgressHudSystem } from './core/hand-progress-hud-system.js';
import { HudText, NotificationHudSystem } from './core/notification-hud-system.js';
import { finishLoadingScreen, startLoadingScreen } from './core/loading-screen.js';
import { GameButton, GameSpan } from './core/ui-font-kit.js';
import { Phase } from './core/phase.js';
import { PhaseMenuSystem } from './core/phase-menu-system.js';
import { StarfieldSystem } from './core/starfield-system.js';
import { SkyBackdropSystem } from './core/sky-backdrop-system.js';
import { StartMenuSystem } from './core/start-menu-system.js';
import { VirtualSkySystem } from './core/virtual-sky-system.js';
import { ConstellationsSystem } from './phases/constellations/constellations-system.js';
import { ConstellationsVfxSystem } from './phases/constellations/constellations-vfx-system.js';
import { EarthSituationsVfxSystem } from './phases/fate-events/earth-situations-vfx-system.js';
import { FateEventSystem } from './phases/fate-events/fate-event-system.js';
import { FateEventVfxSystem } from './phases/fate-events/fate-event-vfx-system.js';
import { EndRunMenuSystem } from './phases/finale/end-run-menu-system.js';
import { FinaleSystem } from './phases/finale/finale-system.js';
import { LAUNCH_TIMEOUT_SECONDS, OrbitalLaunchSystem } from './phases/orbital-launch/orbital-launch-system.js';
import { OrbitalLaunchVfxSystem } from './phases/orbital-launch/orbital-launch-vfx-system.js';
import { PebbleCometPresentationSystem } from './phases/pebbles/pebble-comet-presentation-system.js';
import { PebbleFieldVfxSystem } from './phases/pebbles/pebble-field-vfx-system.js';
import { PebbleWeavingSystem } from './phases/pebbles/pebble-weaving-system.js';
import { PlanetSeedingSystem } from './phases/planet-seeding/planet-seeding-system.js';
import { PlanetSeedingVfxSystem } from './phases/planet-seeding/planet-seeding-vfx-system.js';
import { StardustSystem } from './phases/stardust/stardust-system.js';
import { StardustVfxSystem } from './phases/stardust/stardust-vfx-system.js';

startLoadingScreen();

World.create(document.getElementById('scene-container') as HTMLDivElement, {
  assets: {
    // Comet head decal, keyed by dominant pebble type (see PEBBLE_TYPES).
    faceSoul: { url: '/textures/faceSoul.png', type: AssetType.Texture },
    faceOrganic: { url: '/textures/faceOrganic.png', type: AssetType.Texture },
    faceGas: { url: '/textures/faceGas.png', type: AssetType.Texture },
    // Art Test only (see ArtTestVfxSystem) — skipped entirely while
    // ART_TEST_ENABLED is off.
    ...(ART_TEST_ENABLED
      ? { starIllustration: { url: '/textures/starillustration.png', type: AssetType.Texture } }
      : {}),
    backgroundMusic: { url: '/audio/insectsAndSalamander.wav', type: AssetType.Audio },
    // Quill-authored, baked vertex-cache animation exported as glTF morph
    // targets (no rig) — see EarthSituationsVfxSystem's own bee comment for
    // why only a couple instances are used.
    beeFlying: { url: '/gltf/beeFlying.glb', type: AssetType.GLTF },
  },
  xr: {
    // AR (not VR) is the boot-time session mode so camera passthrough is
    // actually possible at all — WebXR fixes environmentBlendMode (and this
    // app's own WebGL context alpha-compositing) once, at session-request
    // time, from whatever sessionMode is requested here; there's no runtime
    // API to flip it later. Settings' "Passthrough" toggle is therefore a
    // purely visual switch within this one persistent AR session (see
    // VirtualSkySystem) rather than a session restart.
    sessionMode: SessionMode.ImmersiveAR,
    offer: 'always',
    features: { handTracking: true },
  },
  features: {
    locomotion: false,
    grabbing: false,
    physics: false,
    sceneUnderstanding: false,
    // hudtext: notification-hud.uikitml's custom tag (see HudText's own
    // comment for why it needs to be a kit at all). span/button: applies
    // the same "hud" font-family registration to every other .uikitml
    // file's plain <span>/<button> text, project-wide, without touching
    // each file's markup — see ui-font-kit.ts.
    spatialUI: { kits: { hudtext: HudText, span: GameSpan, button: GameButton } },
  },
}).then((world) => {
  bootstrapGlobals(world);

  // Explicit, always-visible fallback for entering XR (see index.html) —
  // the `offer: 'always'` config above already asks the browser to show its
  // own native "enter" affordance via navigator.xr.offerSession, but that's
  // a Quest-Browser-specific extension to the WebXR spec; browsers without
  // it show nothing at all with no other way in. launchXR/offerSession work
  // identically for 'immersive-ar' as they did for 'immersive-vr' — nothing
  // about this fallback needed to change when the boot session mode did (see
  // xr.sessionMode above). Shown only while NonImmersive (browser/2D mode)
  // and hidden the instant a session starts; VisibilityState returns to
  // NonImmersive on its own if the session ends, which re-shows it — no
  // separate session-end handling needed here.
  const enterVrButton = document.getElementById('enter-vr-button') as HTMLButtonElement | null;
  // Title panel shown above it in the browser window (see index.html).
  const kometaPanel = document.getElementById('kometa-panel') as HTMLDivElement | null;
  if (enterVrButton) {
    enterVrButton.addEventListener('click', () => launchXR(world));
    world.visibilityState.subscribe((state) => {
      const nonImmersive = state === VisibilityState.NonImmersive;
      enterVrButton.style.display = nonImmersive ? 'block' : 'none';
      if (kometaPanel) kometaPanel.style.display = nonImmersive ? 'flex' : 'none';
    });
  }

  // Clear color/alpha and the virtual sky backdrop (replacing DomeGradient,
  // which EnvironmentSystem permanently hides once in an AR session — see
  // that system's own class comment) are now owned entirely by
  // VirtualSkySystem, driven live off globals.passthroughEnabled, since this
  // one persistent AR session needs to flip between "opaque virtual sky" and
  // "camera passthrough" without ever restarting.

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
    .registerSystem(CometAudioSystem, { priority: 21 })
    // Same comet-tag subscriptions as CometAudioSystem just above (see its
    // own comment) plus every other phase's direct pulse()/pulseBoth() calls
    // — grouped right after it since both are "one system per feedback
    // modality." No new components to register (reuses CometSnapped/
    // CometReleased/CometCaught).
    .registerSystem(HapticsSystem, { priority: 22 });

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

  // MCP/agent-testing hook — see dev-jump-system.ts's own comment. Registered
  // right after GameDirectorSystem (which it looks up via getSystem in init())
  // and before director.start(), same as PhaseMenuSystem below.
  world.registerSystem(DevJumpSystem, { priority: 0 });
  world.registerSystem(DevPerfLoggerSystem, { priority: 0 });

  // Left-hand-pinch dev menu — jumps directly to any phase. Registered after
  // GameDirectorSystem (which it looks up via getSystem in its own init()).
  world.registerSystem(PhaseMenuSystem, { priority: 5 });

  // Gates director.start() behind the Start cube's poke-hold-select — see
  // its own comments. director.start() is called from inside
  // StartMenuSystem itself, not from this file.
  world.registerSystem(StartMenuSystem, { priority: 5 });

  // Opaque virtual-sky backdrop (replaces DomeGradient, see its own class
  // comment) plus the renderer's clear-alpha ownership — always-on, reacts
  // to globals.passthroughEnabled directly, never GameDirector-managed, same
  // idiom as StarfieldSystem/SkyBackdropSystem below.
  world.registerSystem(VirtualSkySystem, { priority: 4 });

  // View-locked HUD flashing each phase's instructional blurb — always-on,
  // reacts to globals.gamePhase directly (see its own gamePhase.subscribe),
  // never GameDirector-managed.
  world.registerSystem(NotificationHudSystem, { priority: 35 });

  // Always-on, gamePhase-driven achievement unlocking (see its own
  // comments) — order relative to NotificationHudSystem doesn't matter,
  // it looks NotificationHudSystem up lazily via getSystem() on unlock.
  world.registerSystem(AchievementSystem, { priority: 36 });

  // Ambient background music for the whole run — always-on, never
  // GameDirector-managed (see its own comments); starts itself once
  // globals.gameStarted flips true.
  world.registerSystem(BackgroundMusicSystem, { priority: 36 });

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
  const stardust = world.getSystem(StardustSystem)!;
  director.definePhase(Phase.Stardust, {
    systems: [stardust],
    reset: () => stardust.resetRun(),
    // Timing out plays the stardust win sequence before moving on.
    onTimeout: () => stardust.onTimeout(),
    // Bumped from 90 — StardustSystem's own two-stage swirl finale (Stage A
    // up to 60s, Stage B up to +30s more) plus the win-sequence notification
    // playback (~13s) can now total more than the old timeout on a slow/idle
    // player; this stays purely a safety net for someone who never engages
    // at all. Bumped again from 150 — a struggling player (steep effective
    // bar once both swirl stages are counted) was cutting it too close to
    // this safety net.
    timeoutSeconds: 240,
    continue: {
      getReadiness01: () => stardust.getContinueReadiness01(),
      onContinue: () => stardust.continueNow(),
    },
  });

  world
    .registerSystem(PebbleWeavingSystem, { priority: 30 })
    .registerSystem(PebbleFieldVfxSystem, { priority: 32 });
  const pebbles = world.getSystem(PebbleWeavingSystem)!;
  director.definePhase(Phase.Pebbles, {
    systems: [
      world.getSystem(PebbleWeavingSystem)!,
      world.getSystem(PebbleFieldVfxSystem)!,
    ],
    timeoutSeconds: 240,
    continue: {
      getReadiness01: () => pebbles.getProgress01(),
      getColorHex: () => pebbles.getDominantColorHex(),
      onContinue: () => pebbles.triggerCompletion(),
    },
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
  const seeding = world.getSystem(PlanetSeedingSystem)!;
  director.definePhase(Phase.Seeding, {
    systems: [seeding],
    continue: {
      getReadiness01: () => seeding.getContinueReadiness01(),
      onContinue: () => seeding.continueNow(),
    },
    // Bumped from 150 — PlanetSeedingSystem's own COVERAGE_WIN_FRACTION now
    // requires the ENTIRE grid colored (was 0.7), not just most of it (see
    // its own comment); this safety net needed matching headroom. 180 -> 240
    // when the grid doubled to 80 cells (see planet-stain-material.ts's
    // MAX_SPLATS).
    timeoutSeconds: 300,
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
    // Bumped from 120 — trace time is entirely player-paced, and the ~30s
    // crown-rise cinematic that must still play out after tracing (see
    // notification-copy.ts's celestialSymbolMessage) eats into this same
    // budget, leaving too little room for a slower player.
    timeoutSeconds: 150,
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
  const fateEvents = world.getSystem(FateEventSystem)!;
  director.definePhase(Phase.FateEvents, {
    systems: [fateEvents],
    // Timing out mid-collection still plays the payoff before moving on.
    onTimeout: () => fateEvents.onTimeout(),
    continue: {
      getReadiness01: () => fateEvents.getContinueReadiness01(),
      onContinue: () => fateEvents.continueNow(),
    },
    // Bumped from 65 — the phase is now a fixed 5-beat sequence (Zoom 6s +
    // Ambient 10s + Explain ~5.3s + Collect, gameplay-paced + Payoff's own
    // ~7s hold before phaseComplete — see fate-event-system.ts's FateBeat)
    // rather than a single unscripted "visit everyone" loop; worst-case
    // Collect time alone could exceed the old timeout. Still purely a safety
    // net — a player who moves through the beats quickly advances well
    // before this fires.
    timeoutSeconds: 300,
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
  const launch = world.getSystem(OrbitalLaunchSystem)!;
  director.definePhase(Phase.Launch, {
    systems: [world.getSystem(OrbitalLaunchSystem)!, world.getSystem(OrbitalLaunchVfxSystem)!],
    // Bumped from 30 — too tight against OrbitalLaunchSystem's own notify-
    // gated flow: the choice zones don't even reveal until ~8s in (the
    // phase-entry blurb finishing), then CHARGE_SECONDS to commit, then a
    // fixed ~18s more for the commit message + LAUNCH_BUILDUP_SEQUENCE to
    // play out before a real detach fires — a floor of ~29s even for a
    // player who commits instantly. At 30 the phase's own GameDirector
    // timeout (this value) could fire first and force an immediate detach
    // via OrbitalLaunchSystem.stop()'s fallback, cutting the buildup
    // sequence off mid-playback. 55 leaves real room to notice/aim/hold.
    // No Continue button here: choose a destiny or time out (see
    // OrbitalLaunchSystem.stop()'s 'indecisive' achievement).
    timeoutSeconds: LAUNCH_TIMEOUT_SECONDS,
    // A committed player's launch buildup finishes before the phase ends.
    onTimeout: () => launch.onTimeout(),
  });

  // Wrist-worn Continue button (replaces the progress bar below, which is
  // now disabled — see CONTINUE_BUTTON_ENABLED / HAND_PROGRESS_HUD_ENABLED).
  // Looks up GameDirectorSystem for each phase's PhaseConfig.continue hooks.
  world.registerSystem(ContinueButtonSystem, { priority: 34 });

  // Wrist-worn progress bar, on whichever hand isn't holding the comet —
  // always-on/self-gated (see its own class comment), not GameDirector-
  // managed. Registered after Stardust/Pebbles/Seeding/FateEvents/Launch's
  // own gameplay systems (all above), which it looks up via getSystem() in
  // its own init(). See HAND_PROGRESS_HUD_ENABLED to disable this feature
  // entirely without removing it.
  world.registerSystem(HandProgressHudSystem, { priority: 34 });

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

  // Dev-only art-comparison sandbox (see Phase.ArtTest's own comment) —
  // reachable only via PhaseMenuSystem's dev menu (btn-art-test), never
  // through normal play/looping since Phase.ArtTest isn't in PHASE_ORDER.
  // See ART_TEST_ENABLED's own comment — currently off, skipped entirely
  // (not registered/defined at all) rather than just disabled, since this
  // is the single largest sandbox in the codebase.
  if (ART_TEST_ENABLED) {
    world
      .registerSystem(ArtTestSystem, { priority: 30 })
      .registerSystem(ArtTestVfxSystem, { priority: 32 });
    director.definePhase(Phase.ArtTest, {
      systems: [world.getSystem(ArtTestSystem)!, world.getSystem(ArtTestVfxSystem)!],
      // No timeoutSeconds — a dev tool should never auto-advance out from
      // under whoever's using it; leaving is always a manual dev-menu jump.
    });
  }

  // director.start() is deliberately NOT called here — StartMenuSystem
  // calls it once the Start button is dwell-selected, gating the whole
  // game behind the start menu.

  finishLoadingScreen();
});
