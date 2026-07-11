// Focus is an input-routing decision in this app: the canvas game reads
// document-level keydown, and InputHandler deliberately ignores keys while
// focus sits on any tabbable element (so the debug panel's controls work).
// A clicked overlay button must therefore hand focus back, or game keys stay
// dead and Enter/Space keep re-activating the (possibly invisible) button.
export function blurOnClick<E extends HTMLElement>(element: E): E {
  element.addEventListener('click', () => element.blur());
  return element;
}
