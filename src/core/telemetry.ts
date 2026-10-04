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
      analytics = analyticsModule.getAnalytics(initializeApp(firebaseConfig));
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
  if (analytics) safeCall(fn);
  else if (pending.length < MAX_PENDING) pending.push(fn);
}

export function track(name: string, params: Params = {}): void {
  if (disabled) return;
  try {
    if (DEBUG) console.info('[telemetry]', name, params);
    const sent = DEBUG ? { ...params, debug_mode: true } : params;
    whenReady(() => logEventFn!(analytics!, name, sent));
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
