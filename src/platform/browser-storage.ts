/**
 * Returns localStorage when its property lookup is available; callers treat
 * null as an in-memory or no-op fallback.
 */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
