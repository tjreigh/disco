import { MIN_ZOOM, MAX_ZOOM } from '../platform/user-settings-store.js';
import { blurOnClick } from './dom-utils.js';

export interface MenuControlsElements {
  readonly soundButton: HTMLButtonElement;
  readonly advancedHudButton: HTMLButtonElement;
  readonly zoomOutButton: HTMLButtonElement;
  readonly zoomResetButton: HTMLButtonElement;
  readonly zoomInButton: HTMLButtonElement;
}

export interface MenuControlsCallbacks {
  readonly onRequestToggleSound: () => void;
  readonly onRequestToggleAdvancedHud: () => void;
  readonly onRequestZoomOut: () => void;
  readonly onRequestZoomReset: () => void;
  readonly onRequestZoomIn: () => void;
}

/**
 * The sound/advanced-HUD/zoom controls shared byte-for-byte between
 * HomeScreen's game menu and MultiplayerPauseMenu — everything else in
 * those menus (restart, save & exit, debug, forfeit) is solo- or
 * multiplayer-specific and deliberately stays out of this helper.
 */
export class MenuControls {
  private readonly elements: MenuControlsElements;

  constructor(elements: MenuControlsElements, callbacks: MenuControlsCallbacks) {
    this.elements = elements;
    elements.soundButton.addEventListener('click', () => callbacks.onRequestToggleSound());
    blurOnClick(elements.soundButton);
    elements.advancedHudButton.addEventListener('click', () => callbacks.onRequestToggleAdvancedHud());
    blurOnClick(elements.advancedHudButton);
    elements.zoomOutButton.addEventListener('click', () => callbacks.onRequestZoomOut());
    blurOnClick(elements.zoomOutButton);
    elements.zoomResetButton.addEventListener('click', () => callbacks.onRequestZoomReset());
    blurOnClick(elements.zoomResetButton);
    elements.zoomInButton.addEventListener('click', () => callbacks.onRequestZoomIn());
    blurOnClick(elements.zoomInButton);
  }

  setSoundEnabled(enabled: boolean): void {
    this.elements.soundButton.textContent = enabled ? 'SOUND ON' : 'SOUND OFF';
  }

  setAdvancedHudEnabled(enabled: boolean): void {
    this.elements.advancedHudButton.textContent = enabled ? 'ADVANCED HUD ON' : 'ADVANCED HUD OFF';
    this.elements.advancedHudButton.setAttribute('aria-pressed', String(enabled));
  }

  updateZoomState(scale: number): void {
    this.elements.zoomInButton.disabled = scale >= MAX_ZOOM;
    this.elements.zoomOutButton.disabled = scale <= MIN_ZOOM;
    this.elements.zoomResetButton.disabled = scale <= MIN_ZOOM;
  }
}
