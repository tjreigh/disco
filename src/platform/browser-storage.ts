/**
 * Safe access to window.localStorage. Returns null instead of throwing in
 * non-browser contexts (tests, SSR) and whenever access itself throws —
 * private-browsing storage lockouts, hardened browser contexts, or a
 * disabled storage policy all raise on the *property lookup*, not just on
 * getItem/setItem. Every localStorage-backed store in this app treats
 * storage as best-effort and falls back to an in-memory/no-op path when
 * this returns null.
 */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
