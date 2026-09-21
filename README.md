# IWSDK Starter Template

This folder is a source template used by `scripts/generate-starters.cjs` to produce 8 runnable variants:

- `starter-<vr|ar>-<manual|metaspatial>-<ts|js>`

Do not run this template directly. The generator will:

- Copy a variant-specific `src/index.ts` (see `src/index-*.ts`).
- Install the matching Vite config from `configs/`.
- Keep only the required metaspatial folder (renamed to `metaspatial`).
- Prune unused assets and dev dependencies.

UI is defined in `ui/welcome.uikitml`; the Vite UIKitML plugin compiles it to `public/ui/welcome.json` during build in generated variants.

## Notification position

The notification HUD follows the player's head. Its placement is the `offsetPosition` in `src/core/notification-hud-system.ts` (in `init()`, on the `Follower` component), as `[x, y, z]` in metres relative to the head:

- `y` — vertical. `0` is eye level; more negative is lower. Currently `-0.12` (`NOTIFICATION_HUD_OFFSET` in `notification-hud-system.ts`; the Continue button follows it); raise it toward `0` to move notifications up, lower it (e.g. `-0.22`) to move them down.
- `z` — distance in front of the viewer (`-0.4`). Keep it fairly close so world geometry rarely passes between you and the panel.

## Continue button

Stardust, Pebbles, Seeding and Fate Events each have a **Continue** diamond pinned in view just below the notification box (`BUTTON_BELOW_NOTIFICATION` in `src/core/continue-button-system.ts` moves it up/down; `BUTTON_SCALE` sizes it). It only appears once the phase's threshold is reached, with a chime and a haptic pulse. Poke and hold it to move on. The phase's own timeout is still the fallback for anyone who never presses it. Constellations, Launch and Finale have no button (Constellations advances once the crown lands, as before). Launch: choose a destiny or time out (timing out unlocks the **Indecisive** achievement).

- **Per-phase threshold** — each phase decides when the button unlocks in its own `getContinueReadiness01()` (Stardust has no threshold — it's ready as soon as it appears, when the `CONTINUE_INTRO_TEXT` notification shows; Seeding: `CONTINUE_COVERAGE_FRACTION`, Fate Events: `CONTINUE_COLLECT_FRACTION` (half; timing out mid-collection still plays the payoff), Pebbles: `MIN_BUBBLE_PEBBLES`). `onContinue` is wired in `src/index.ts` via each `definePhase()`'s `continue:` block; leave it out to give a phase no button.
- **`CONTINUE_BUTTON_ENABLED`** (`src/core/continue-button-system.ts`) — turns the button off entirely.
- **`CONTINUE_NOTIFICATIONS_ENABLED`** (`src/core/notification-copy.ts`) — also show a "Continue whenever you are ready." HUD line when the button unlocks (text: `CONTINUE_READY_TEXT`). Off by default.
- **Switching back to the old progress bar** — set `CONTINUE_BUTTON_ENABLED = false` and `HAND_PROGRESS_HUD_ENABLED = true` (`src/core/hand-progress-hud-system.ts`).
