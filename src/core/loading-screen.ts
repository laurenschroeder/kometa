// Drives the browser-window loading overlay (#loading-screen in index.html) —
// black cover + progress bar shown until the world and every system have
// finished building, so the 2D page isn't a blank white window meanwhile.
//
// World.create() doesn't expose asset-load progress (its LoadingManager only
// exists once creation is already underway), so the bar is an eased estimate:
// it climbs quickly then asymptotically approaches ~90%, and snaps to 100%
// when finishLoadingScreen() is called.
const EASE_RATE = 0.35; // 1/s
const MAX_BEFORE_DONE = 0.9;
const FADE_MS = 500;

let rafId = 0;

export function startLoadingScreen(): void {
  const fill = document.getElementById('loading-fill');
  if (!fill) return;
  const start = performance.now();
  const tick = (now: number) => {
    const t = (now - start) / 1000;
    const progress = MAX_BEFORE_DONE * (1 - Math.exp(-EASE_RATE * t));
    fill.style.transform = `scaleX(${progress})`;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function finishLoadingScreen(): void {
  cancelAnimationFrame(rafId);
  const screen = document.getElementById('loading-screen');
  const fill = document.getElementById('loading-fill');
  if (fill) fill.style.transform = 'scaleX(1)';
  if (!screen) return;
  screen.style.opacity = '0';
  window.setTimeout(() => screen.remove(), FADE_MS);
}
