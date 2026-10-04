import { signal, Signal } from '@preact/signals-core';
import { firebaseConfig } from './firebase-config.js';
import { withTimeout } from './with-timeout.js';

// The shared "comets released" counter every player feeds — guests
// included, on any host — split by each comet's fate. Stored in one
// Firestore document, read and incremented through Firestore's REST API with
// plain fetch rather than the Firestore SDK (which would add ~100KB to the
// bundle for two requests). See firestore.rules for what writes are allowed.
//
// Purely decorative: every failure (offline, blocked, missing database,
// rules rejection, malformed response) is swallowed, and the signals below
// just stay null — every UI line built on them is hidden while null, so a
// failure means the section simply doesn't appear.

export type ReleaseKind = 'orbit' | 'launch' | 'drifted';

export interface CometStats {
  total: number;
  orbit: number;
  launch: number;
  // Timed out without choosing — OrbitalLaunchSystem falls back to orbiting,
  // so displays fold this into "orbit", but it's kept separate in the data.
  drifted: number;
}

// Null until a fetch succeeds.
export const cometStats: Signal<CometStats | null> = signal(null);
// This session's own most recent release: which number comet it was. Null
// until a release has been recorded successfully.
export const lastRelease: Signal<{ number: number; kind: ReleaseKind } | null> = signal(null);

const REQUEST_TIMEOUT_MS = 10000;
const DEBUG = new URLSearchParams(location.search).has('kometa_debug');
// Local dev and ?kometa_debug sessions count into a separate document, so
// testing never inflates the real number players see.
const DOC_ID = import.meta.env.DEV || DEBUG ? 'comets-debug' : 'comets';
const DOCS_ROOT = `projects/${firebaseConfig.projectId}/databases/(default)/documents`;
const API_ROOT = `https://firestore.googleapis.com/v1/${DOCS_ROOT}`;
const ENABLED = !!(firebaseConfig.projectId && firebaseConfig.apiKey);

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const res = await withTimeout(() => fetch(url, init), REQUEST_TIMEOUT_MS, 'comet stats request');
  if (!res.ok) throw new Error(`comet stats HTTP ${res.status}`);
  return res.json();
}

// Firestore REST encodes integers as { integerValue: "123" } strings.
function readInt(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { integerValue?: unknown; doubleValue?: unknown };
  const n = Number(v.integerValue ?? v.doubleValue);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function parseStats(raw: unknown): CometStats | null {
  const fields = (raw as { fields?: Record<string, unknown> } | null)?.fields;
  if (!fields) return null;
  const total = readInt(fields.total);
  if (total === null || total <= 0) return null;
  return {
    total,
    orbit: readInt(fields.orbit) ?? 0,
    launch: readInt(fields.launch) ?? 0,
    drifted: readInt(fields.drifted) ?? 0,
  };
}

// Refreshes cometStats. Never rejects; on failure the last good value (if
// any) is kept, so a flaky refresh doesn't make a visible line disappear.
export async function fetchCometStats(): Promise<void> {
  if (!ENABLED) return;
  try {
    const stats = parseStats(await request(`${API_ROOT}/stats/${DOC_ID}?key=${firebaseConfig.apiKey}`));
    if (stats) cometStats.value = stats;
  } catch (err) {
    if (DEBUG) console.warn('[community-stats] fetch failed', err);
  }
}

// Adds this run's comet to the shared count. Fire-and-forget, never rejects.
// Firestore's increment transforms are atomic server-side, and the commit
// response returns the post-increment values — that's how the finale knows
// exactly which number comet this one was.
export async function recordCometReleased(kind: ReleaseKind): Promise<void> {
  // Cleared first, so a failed write for this run never leaves an earlier
  // run's number on screen as if it were this one's.
  lastRelease.value = null;
  if (!ENABLED) return;
  try {
    const raw = await request(`${API_ROOT}:commit?key=${firebaseConfig.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [
          {
            transform: {
              document: `${DOCS_ROOT}/stats/${DOC_ID}`,
              fieldTransforms: [
                { fieldPath: 'total', increment: { integerValue: '1' } },
                { fieldPath: kind, increment: { integerValue: '1' } },
              ],
            },
          },
        ],
      }),
    });
    const results = (raw as { writeResults?: { transformResults?: unknown[] }[] } | null)?.writeResults?.[0]
      ?.transformResults;
    const total = readInt(results?.[0]);
    if (total === null) throw new Error('unrecognized commit response');
    lastRelease.value = { number: total, kind };
    if (DEBUG) console.info('[community-stats] released comet #', total, kind);
  } catch (err) {
    if (DEBUG) console.warn('[community-stats] record failed', err);
    return;
  }
  // The commit only returns the two fields it touched — refresh the rest so
  // the finale's orbit/launch split is current too.
  await fetchCometStats();
}
