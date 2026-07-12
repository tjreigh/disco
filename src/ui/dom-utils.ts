export const isTouchDevice = (): boolean =>
  ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// Lazy on purpose: no matchMedia() call at module init (happy-dom doesn't
// always provide it, and import-time caching makes tests hard to control).
// The MediaQueryList's .matches stays current, so caching the list itself
// needs no change listener — and callers can safely ask every frame.
let reducedMotionQuery: MediaQueryList | null = null;
export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  reducedMotionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery.matches;
}

// Focus is an input-routing decision in this app: the canvas game reads
// document-level keydown, and InputHandler deliberately ignores keys while
// focus sits on any tabbable element (so the debug panel's controls work).
// A clicked overlay button must therefore hand focus back, or game keys stay
// dead and Enter/Space keep re-activating the (possibly invisible) button.
export function blurOnClick<E extends HTMLElement>(element: E): E {
  element.addEventListener('click', () => element.blur());
  return element;
}
