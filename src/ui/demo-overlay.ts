import { cloneTemplate, mustQuery } from './dom-utils.js';

/** A full-surface link that keeps the embed passive while making any click open Disco. */
export class DemoOverlay {
  readonly element: HTMLAnchorElement;

  constructor(mount: HTMLElement = document.body) {
    const fullGameUrl = new URL(window.location.href);
    fullGameUrl.searchParams.delete('demo');

    const fragment = cloneTemplate('tpl-demo-overlay');
    this.element = mustQuery(fragment, '.demo-overlay');
    this.element.href = fullGameUrl.toString();

    mount.append(fragment);
  }

  destroy(): void {
    this.element.remove();
  }
}
