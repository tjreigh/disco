/**
 * Makes a root's siblings and extra targets inert, returning a function that
 * restores their previous state.
 */
export function applyInert(
  root: HTMLElement,
  extraTargets: readonly HTMLElement[] = [],
  skip: (element: HTMLElement) => boolean = () => false,
): () => void {
  const prior = new Map<HTMLElement, boolean>();
  const siblings = root.parentElement
    ? Array.from(root.parentElement.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement
        && element !== root
        && !skip(element),
    )
    : [];
  for (const target of new Set([...extraTargets, ...siblings])) {
    prior.set(target, target.inert);
    target.inert = true;
  }
  return () => {
    for (const [target, wasInert] of prior) target.inert = wasInert;
    prior.clear();
  };
}
