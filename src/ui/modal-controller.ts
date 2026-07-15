export interface ModalControllerOptions {
  openClass: string;
  initialFocus: () => HTMLElement | null;
  inertTargets?: readonly HTMLElement[];
  onEscape?: () => void;
  restoreFocus?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Shared modal visibility, background inertness, and focus lifecycle. */
export class ModalController {
  private previousFocus: HTMLElement | null = null;
  private priorRootInert: boolean | null = null;
  private readonly priorInert = new Map<HTMLElement, boolean>();

  constructor(
    private readonly root: HTMLElement,
    private readonly options: ModalControllerOptions,
  ) {
    this.root.setAttribute('aria-hidden', 'true');
    this.root.addEventListener('keydown', event => this.handleKeydown(event));
  }

  open(): void {
    if (this.isOpen()) return;
    this.priorRootInert = this.root.inert;
    this.root.inert = false;
    this.previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const siblings = this.root.parentElement
      ? Array.from(this.root.parentElement.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== this.root)
      : [];
    const inertTargets = new Set([...(this.options.inertTargets ?? []), ...siblings]);
    for (const target of inertTargets) {
      this.priorInert.set(target, target.inert);
      target.inert = true;
    }
    this.root.classList.add(this.options.openClass);
    this.root.setAttribute('aria-hidden', 'false');
    this.options.initialFocus()?.focus();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.root.classList.remove(this.options.openClass);
    this.root.setAttribute('aria-hidden', 'true');
    for (const [target, wasInert] of this.priorInert) target.inert = wasInert;
    this.priorInert.clear();

    const shouldRestore = this.root.contains(document.activeElement);
    if (shouldRestore && this.options.restoreFocus !== false && this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    } else if (shouldRestore && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    this.root.inert = this.priorRootInert ?? false;
    this.priorRootInert = null;
    this.previousFocus = null;
  }

  isOpen(): boolean {
    return this.root.classList.contains(this.options.openClass);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.options.onEscape) {
      event.preventDefault();
      this.options.onEscape();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(this.root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
