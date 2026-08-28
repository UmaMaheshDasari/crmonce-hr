import { useEffect, useRef } from 'react';

/**
 * Reload an already-open tab when a newer frontend build is deployed.
 *
 * Without this, a tab keeps running the JavaScript it downloaded on first
 * load. Deploying cannot change code a browser already has, so a user who
 * left the HR System open kept seeing the previous build until they pressed
 * Ctrl+R. That is how the removed Recent Activity card stayed visible after
 * it had been taken out of production.
 *
 * ── HOW A NEW VERSION IS DETECTED ────────────────────────────────────
 * Vite writes a content hash into the bundle filename, so index.html already
 * is the version marker — no version endpoint, no build-config change, no
 * service worker.
 *
 *   this tab is running   <script type="module" src="/assets/index-ABC.js">
 *   what is deployed      fetch('/index.html') -> src="/assets/index-XYZ.js"
 *   different             -> a new build exists
 *
 * This is only reliable because nginx serves index.html with
 * `Cache-Control: no-cache, must-revalidate` while hashed assets stay
 * immutable. If that header is ever removed the fetch could be answered from
 * cache and this check would silently stop noticing new builds.
 *
 * ── WHEN IT RELOADS ──────────────────────────────────────────────────
 * Never while the user is working. A reload discards unsaved form input, and
 * half-finished employee records and leave applications are exactly what this
 * app is full of. So a detected version is held as pending and acted on only
 * at a moment when nobody is mid-keystroke:
 *
 *   tab becomes hidden        they navigated away        -> reload
 *   tab becomes visible       they just came back        -> reload
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────
 * Its only side effect is location.reload(). It does not touch
 * localStorage, sessionStorage (beyond one loop-guard key of its own),
 * or cookies. accessToken, refreshToken and sidebarCollapsed survive
 * verbatim, so the reload lands on AuthContext's normal bootstrap and the
 * user stays signed in. It never calls logout() or localStorage.clear() —
 * those are the logout paths in client.js and AuthContext.
 */

const CHECK_INTERVAL_MS = 120_000;

/** Own namespace; the only other sessionStorage key in the app is postLoginRedirect. */
const RELOAD_GUARD_KEY = 'hrAppReloadFor';

/** Path of the module bundle this tab is currently executing. */
function currentBundlePath() {
  const el = document.querySelector('script[type="module"][src]');
  if (!el) return null;
  try {
    return new URL(el.getAttribute('src'), window.location.origin).pathname;
  } catch {
    return null;
  }
}

/**
 * Path of the module bundle the server is serving right now.
 * Returns null on any failure — a flaky network must never cause a reload.
 */
async function deployedBundlePath() {
  try {
    const res = await fetch('/index.html', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i);
    if (!m) return null;
    return new URL(m[1], window.location.origin).pathname;
  } catch {
    return null;
  }
}

export default function useVersionCheck() {
  const pendingRef = useRef(null);   // bundle path we intend to reload for
  const reloadingRef = useRef(false); // stops two triggers stacking reloads
  const disabledRef = useRef(false);  // set when the loop guard trips

  useEffect(() => {
    // Nothing to update on the sign-in screen, and a reload there would look
    // like a glitch to someone typing credentials.
    if (window.location.pathname === '/login') return undefined;

    const mine = currentBundlePath();
    if (!mine) return undefined;      // can't identify ourselves — do nothing

    let cancelled = false;

    const check = async () => {
      if (cancelled || disabledRef.current || reloadingRef.current) return;
      const deployed = await deployedBundlePath();
      if (!deployed || deployed === mine) return;   // null = network blip, ignore
      pendingRef.current = deployed;
      // Detected while the user is away: act now, they will not see it happen.
      if (document.hidden) reloadNow();
    };

    const reloadNow = () => {
      if (reloadingRef.current || disabledRef.current) return;
      const target = pendingRef.current;
      if (!target) return;

      // Loop guard. If we already reloaded for this exact bundle and are still
      // not running it, something upstream is serving stale HTML — stop rather
      // than reload forever.
      try {
        if (window.sessionStorage.getItem(RELOAD_GUARD_KEY) === target) {
          disabledRef.current = true;
          return;
        }
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, target);
      } catch {
        // sessionStorage unavailable (private mode, blocked): without the guard
        // a loop cannot be ruled out, so decline to reload.
        disabledRef.current = true;
        return;
      }

      reloadingRef.current = true;
      window.location.reload();       // preserves localStorage — session intact
    };

    const onVisibility = () => {
      if (document.hidden) {
        // They left the tab — safe to reload whether we knew already or not.
        if (pendingRef.current) reloadNow();
        return;
      }
      // They came back. Reload if we already know, otherwise check now so the
      // next return acts on it.
      if (pendingRef.current) reloadNow();
      else check();
    };

    check();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
