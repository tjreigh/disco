import { cloneTemplate, mustQuery } from './dom-utils.js';

export interface UiMounts {
  stage: HTMLElement;
  controls: HTMLElement;
  overlays: HTMLElement;
  utilities: HTMLElement;
  modalBackground: readonly HTMLElement[];
}

/** Owns the application shell and the explicit mount points used by DOM UI. */
export class UiRoot {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly mounts: UiMounts;

  constructor(container: HTMLElement = document.body) {
    const fragment = cloneTemplate('tpl-ui-root');
    this.root = mustQuery(fragment, '.app-root');
    this.canvas = mustQuery(fragment, 'canvas');
    const shell = mustQuery<HTMLElement>(fragment, '.app-shell');
    const stage = mustQuery<HTMLElement>(fragment, '.game-stage');
    const controls = mustQuery<HTMLElement>(fragment, '.shell-region--bottom');
    const overlays = mustQuery<HTMLElement>(fragment, '.ui-overlay-layer');
    const utilities = mustQuery<HTMLElement>(fragment, '.ui-utility-layer');

    container.append(fragment);

    this.mounts = {
      stage,
      controls,
      overlays,
      utilities,
      modalBackground: [shell, utilities],
    };
  }
}
