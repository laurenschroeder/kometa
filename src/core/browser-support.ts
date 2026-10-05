import { withTimeout } from './with-timeout.js';

// Decides whether this browser can actually run Kometa (an immersive WebXR
// session), and what to offer instead when it can't — most commonly a link
// opened inside Messenger/Facebook/Instagram's in-app browser, which has no
// WebXR at all (plus phones and desktop browsers without a headset). The 2D
// page then swaps "Enter VR" for a "Send to my headset" path instead of a
// button that silently does nothing (see index.ts / index.html).

// The page people should end up on — on VIVERSE that's the public world
// page, NOT this document's own URL (the game runs inside VIVERSE's frame,
// whose URL isn't meant to be shared). VITE_GAME_URL overrides it for any
// future host; other hosts default to wherever this page was loaded from.
const VIVERSE_GAME_URL = 'https://www.viverse.com/jLPv8GK';
export const GAME_URL: string =
  (import.meta.env.VITE_GAME_URL as string | undefined) ??
  (import.meta.env.VITE_PLATFORM === 'viverse' ? VIVERSE_GAME_URL : location.href);

// Meta's own "send this link to my headset" page: after a Meta sign-in it
// opens the URL in Meta Quest Browser on the player's headset.
export const SEND_TO_HEADSET_URL = `https://www.oculus.com/open_url/?url=${encodeURIComponent(GAME_URL)}`;

// Android in-app browsers honor intent:// links, which hand the page to
// Chrome (falling back to the plain URL if Chrome isn't installed). iOS has
// no reliable equivalent, so it gets a "use the ••• menu" hint instead.
export const ANDROID_CHROME_URL =
  `intent://${GAME_URL.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;` +
  `S.browser_fallback_url=${encodeURIComponent(GAME_URL)};end`;

const IN_APP_BROWSER_UA =
  /FBAN|FBAV|FB_IAB|FBIOS|FB4A|Messenger|Instagram|MicroMessenger|Line\/|TikTok|musical_ly|Snapchat|LinkedInApp/i;

export function isInAppBrowser(): boolean {
  return IN_APP_BROWSER_UA.test(navigator.userAgent);
}

export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

// Fills in index.html's #headset-panel links for this browser. Showing or
// hiding the panel itself is index.ts's job (it swaps with Enter VR).
export function initHeadsetPanel(): void {
  const send = document.getElementById('send-to-headset') as HTMLAnchorElement | null;
  if (send) send.href = SEND_TO_HEADSET_URL;
  if (!isInAppBrowser()) return;
  if (isAndroid()) {
    const chrome = document.getElementById('open-in-chrome') as HTMLAnchorElement | null;
    if (chrome) {
      chrome.href = ANDROID_CHROME_URL;
      chrome.style.display = 'inline-block';
    }
  } else {
    const hint = document.getElementById('open-in-browser-hint');
    if (hint) hint.style.display = 'block';
  }
}

const SUPPORT_CHECK_TIMEOUT_MS = 3000;

// Resolves false ONLY when the browser definitively says no immersive
// session is possible (or has no WebXR at all). Any error or a slow answer
// resolves true — a false "unsupported" would hide Enter VR from a real
// headset, which is far worse than showing a button that might not work.
export async function canEnterXR(): Promise<boolean> {
  const xr = navigator.xr;
  if (!xr) return false;
  try {
    const [ar, vr] = await withTimeout(
      () => Promise.all([xr.isSessionSupported('immersive-ar'), xr.isSessionSupported('immersive-vr')]),
      SUPPORT_CHECK_TIMEOUT_MS,
      'WebXR support check',
    );
    return ar || vr;
  } catch {
    return true;
  }
}
