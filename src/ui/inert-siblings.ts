export interface InertGuard {
  /** Restores every element this guard touched to its prior `inert` state. */
  release(): void;
}

/**
 * Marks `extraTargets` and every sibling of `root` (except `root` itself and
 * any sibling `skip` rejects) as inert, remembering each element's prior
 * `inert` value so `release()` can restore it exactly. Shared by
 * ModalController (whose "siblings" are always `root.parentElement`'s
 * children) and HomeScreen (whose top-level show/hide isn't itself a
 * ModalController instance, but needs the identical sibling-inert
 * bookkeeping).
 */
export function applyInert(
  root: HTMLElement,
  extraTargets: readonly HTMLElement[] = [],
  skip: (element: HTMLElement) => boolean = () => false,
): InertGuard {
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
  return {
    release(): void {
      for (const [target, wasInert] of prior) target.inert = wasInert;
      prior.clear();
    },
  };
}
