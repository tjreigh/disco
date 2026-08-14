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

// The inverse direction of the same input-routing decision: after a
// gameplay action (a drop, a ready-toggle, a menu action) hands focus back
// to whatever tabbable element happened to receive it, blur it immediately
// so document-level keydown reaches the game again on the very next key.
export function releaseGameplayFocus(): void {
  if (document.activeElement instanceof HTMLElement && document.activeElement.tabIndex >= 0) {
    document.activeElement.blur();
  }
}

// UI classes clone their static markup out of a <template id="tpl-..."> that
// the build stitches into index.html from src/ui/**/*.template.html (see
// scripts/build-templates.mjs). A missing id means the template file and the
// class that expects it have drifted apart — a build-time bug, not a runtime
// condition callers should have to handle.
export function cloneTemplate(id: string): DocumentFragment {
  const template = document.getElementById(id);
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error(`cloneTemplate: no <template id="${id}"> found`);
  }
  return template.content.cloneNode(true) as DocumentFragment;
}

// Throws instead of returning `T | null` so call sites extracting refs out of
// a cloned template fragment don't need a `!` assertion for every field.
export function mustQuery<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`mustQuery: no element matching "${selector}"`);
  return element;
}

// Compile-time exhaustiveness check for switches over a closed union: adding
// a member to the union without adding a matching case becomes a type error
// here (assigning it to `never`) instead of a silently unhandled case at
// runtime — see e.g. multiplayer-hud-format.ts's statusText.
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled case ${JSON.stringify(value)}`);
}
