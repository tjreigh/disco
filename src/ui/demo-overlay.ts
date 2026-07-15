/** A full-surface link that keeps the embed passive while making any click open Disco. */
export class DemoOverlay {
  readonly element: HTMLAnchorElement;

  constructor(mount: HTMLElement = document.body) {
    const fullGameUrl = new URL(window.location.href);
    fullGameUrl.searchParams.delete('demo');

    this.element = document.createElement('a');
    this.element.className = 'demo-overlay';
    this.element.href = fullGameUrl.toString();
    this.element.target = '_blank';
    this.element.rel = 'noopener noreferrer';
    this.element.setAttribute('aria-label', 'Play Disco (opens in a new tab)');

    const label = document.createElement('span');
    label.className = 'demo-overlay__label';
    label.textContent = 'play disco ↗';
    this.element.append(label);
    mount.append(this.element);
  }

  destroy(): void {
    this.element.remove();
  }
}
