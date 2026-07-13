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
    this.root = document.createElement('div');
    this.root.className = 'app-root';

    const shell = document.createElement('main');
    shell.className = 'app-shell';

    const topRegion = document.createElement('div');
    topRegion.className = 'shell-region shell-region--top';

    const stage = document.createElement('div');
    stage.className = 'game-stage';

    this.canvas = document.createElement('canvas');
    stage.append(this.canvas);

    const controls = document.createElement('div');
    controls.className = 'shell-region shell-region--bottom';
    shell.append(topRegion, stage, controls);

    const overlays = document.createElement('div');
    overlays.className = 'ui-overlay-layer';
    overlays.dataset.uiLayer = 'overlays';

    const utilities = document.createElement('div');
    utilities.className = 'ui-utility-layer';
    utilities.dataset.uiLayer = 'utilities';

    this.root.append(shell, overlays, utilities);
    container.append(this.root);

    this.mounts = {
      stage,
      controls,
      overlays,
      utilities,
      modalBackground: [shell, utilities],
    };
  }
}
