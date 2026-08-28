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

/** Blurs the element after each click, so a focused control doesn't hold canvas keyboard input. */
export function blurOnClick<E extends HTMLElement>(element: E): E {
  element.addEventListener('click', () => element.blur());
  return element;
}

/** Returns keyboard input to gameplay after an action left a control focused. */
export function releaseGameplayFocus(): void {
  if (document.activeElement instanceof HTMLElement && document.activeElement.tabIndex >= 0) {
    document.activeElement.blur();
  }
}

/**
 * Clones the content of a `<template id="tpl-...">` that the build stitched into
 * `index.html`.
 *
 * @remarks
 * The markup comes from the per-component `.template.html` files under `src/ui`,
 * via `scripts/build-templates.mjs`. A missing id means the template and its
 * consumer class have drifted apart — a build bug — so this throws.
 */
export function cloneTemplate(id: string): DocumentFragment {
  const template = document.getElementById(id);
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error(`cloneTemplate: no <template id="${id}"> found`);
  }
  return template.content.cloneNode(true) as DocumentFragment;
}

/**
 * Like `querySelector`, but throws when nothing matches instead of returning
 * `null`.
 *
 * @remarks
 * Lets call sites pulling refs out of a cloned template fragment skip a `!`
 * assertion on every field.
 */
export function mustQuery<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`mustQuery: no element matching "${selector}"`);
  return element;
}

/** Makes a closed-union switch exhaustive at compile time; throws if actually reached. */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled case ${JSON.stringify(value)}`);
}
