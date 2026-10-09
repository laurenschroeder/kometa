import type { Analytics } from 'firebase/analytics';
import { firebaseConfig } from './firebase-config.js';

// Gameplay analytics via Google Analytics for Firebase — host-independent,
// so it behaves the same on VIVERSE or anywhere else. track() is callable
// from anywhere (including before Firebase has loaded — calls queue until
// it has) and is a silent no-op when telemetry is disabled.
//
// Off in the dev server so local testing never pollutes real data, unless
// the page is opened with ?kometa_debug — which also marks every event as
// debug_mode so it shows up in the Firebase console's DebugView instead of
// the normal reports.
//
// Held during immersive play (see setTelemetryHold): on Quest each event's
// gtag processing measured ~8-10ms on the main thread — enough to drop a
// frame at 72Hz whenever one is sent mid-VR (every phase change sent two).
// Events are queued while held and sent the moment the session isn't fully
// visible (system menu, headset off, VR exited) or the page is hidden/closed.
// Params are captured when track() is called, so only delivery is delayed.
//
// Must never throw or block: track() is called from inside signal
// subscribers and gameplay code (e.g. a phase change mid-frame), where an
// exception would propagate into the system that set the signal. Every
// Firebase call is wrapped, and any failure — blocked network, ad blocker,
// unsupported browser, SDK error — just turns telemetry off for the session.

type Params = Record<string, string | number | boolean>;

const DEBUG = new URLSearchParams(location.search).has('kometa_debug');
const CONFIGURED = !!(firebaseConfig.apiKey && firebaseConfig.appId && firebaseConfig.measurementId);
const ENABLED = CONFIGURED && (!import.meta.env.DEV || DEBUG);

let analytics: Analytics | null = null;
let logEventFn: typeof import('firebase/analytics').logEvent | null = null;
let setUserPropertiesFn: typeof import('firebase/analytics').setUserProperties | null = null;
// Bounded so a Firebase load that hangs forever can't grow memory without
// limit over a long session — events past the cap are simply dropped.
const MAX_PENDING = 200;
const pending: Array<() => void> = [];
let disabled = !ENABLED;
let holding = false;
const held: Array<() => void> = [];

function disable(reason: string, err?: unknown): void {
  disabled = true;
  pending.length = 0;
  if (DEBUG || err) console.warn(`[telemetry] disabled: ${reason}`, err ?? '');
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    disable('Firebase call threw', err);
  }
}

// Lazy-loads Firebase off the boot path so it never competes with the
// world's own asset loading on Quest.
export function initTelemetry(): void {
  if (disabled) return;
  void (async () => {
    try {
      const [{ initializeApp }, analyticsModule] = await Promise.all([
        import('firebase/app'),
        import('firebase/analytics'),
      ]);
      if (!(await analyticsModule.isSupported())) {
        disable('analytics not supported in this browser');
        return;
      }
      // Debug mode has to be set on gtag's config, not per event: passed as
      // an event param it's sent as a plain custom value (ep.debug_mode) and
      // DebugView never sees the session — only the config-level flag makes
      // gtag mark every hit with its real debug marker (_dbg=1).
      analytics = analyticsModule.initializeAnalytics(
        initializeApp(firebaseConfig),
        DEBUG ? { config: { debug_mode: true } } : {},
      );
      logEventFn = analyticsModule.logEvent;
      setUserPropertiesFn = analyticsModule.setUserProperties;
      const queued = pending.splice(0);
      for (const fn of queued) safeCall(fn);
    } catch (err) {
      disable('failed to initialize', err);
    }
  })();
}

function whenReady(fn: () => void): void {
  if (disabled) return;
  if (holding) {
    if (held.length < MAX_PENDING) held.push(fn);
    return;
  }
  if (analytics) safeCall(fn);
  else if (pending.length < MAX_PENDING) pending.push(fn);
}

function flushHeld(): void {
  if (disabled) return;
  const wasHolding = holding;
  holding = false;
  for (const fn of held.splice(0)) whenReady(fn);
  holding = wasHolding;
}

// Driven by TelemetrySystem from the XR visibility state: true while the
// immersive session is fully visible, false (which flushes) otherwise.
export function setTelemetryHold(hold: boolean): void {
  holding = hold;
  if (!hold) flushHeld();
}

// Backstop for a page closed or backgrounded mid-session. Doesn't release the
// hold itself — TelemetrySystem does that once the session leaves Visible.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushHeld();
  });
  window.addEventListener('pagehide', flushHeld);
}

export function track(name: string, params: Params = {}): void {
  if (disabled) return;
  try {
    if (DEBUG) console.info('[telemetry]', name, params);
    whenReady(() => logEventFn!(analytics!, name, params));
  } catch (err) {
    disable('track threw', err);
  }
}

// Sticky per-user dimensions (platform, signed-in state) for slicing every
// event in reports — never anything identifying.
export function setTelemetryUserProps(props: Params): void {
  if (disabled) return;
  whenReady(() => setUserPropertiesFn!(analytics!, props));
}
