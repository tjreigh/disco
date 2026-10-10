import { MIN_ZOOM, MAX_ZOOM } from '../platform/user-settings-store.js';
import { blurOnClick } from './dom-utils.js';

interface MenuControlsElements {
  readonly soundButton: HTMLButtonElement;
  readonly advancedHudButton: HTMLButtonElement;
  /** Only the solo game menu has one, and only Ration shows it. */
  readonly laneHintsButton?: HTMLButtonElement | null;
  readonly zoomOutButton: HTMLButtonElement;
  readonly zoomResetButton: HTMLButtonElement;
  readonly zoomInButton: HTMLButtonElement;
}

interface MenuControlsCallbacks {
  readonly onRequestToggleSound: () => void;
  readonly onRequestToggleAdvancedHud: () => void;
  readonly onRequestToggleLaneHints?: () => void;
  readonly onRequestZoomOut: () => void;
  readonly onRequestZoomReset: () => void;
  readonly onRequestZoomIn: () => void;
}

/** Sound, advanced-HUD, lane-hints, and zoom controls shared by both game menus. */
export class MenuControls {
  constructor(
    private readonly elements: MenuControlsElements,
    callbacks: MenuControlsCallbacks,
  ) {
    elements.soundButton.addEventListener('click', () => callbacks.onRequestToggleSound());
    blurOnClick(elements.soundButton);
    elements.advancedHudButton.addEventListener('click', () => callbacks.onRequestToggleAdvancedHud());
    blurOnClick(elements.advancedHudButton);
    if (elements.laneHintsButton) {
      elements.laneHintsButton.addEventListener('click', () => callbacks.onRequestToggleLaneHints?.());
      blurOnClick(elements.laneHintsButton);
    }
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

  setLaneHintsEnabled(enabled: boolean): void {
    const button = this.elements.laneHintsButton;
    if (!button) return;
    button.textContent = enabled ? 'LANE HINTS ON' : 'LANE HINTS OFF';
    button.setAttribute('aria-pressed', String(enabled));
  }

  /** Lane hints only exist in Ration, so every other mode hides the control. */
  setLaneHintsAvailable(available: boolean): void {
    if (this.elements.laneHintsButton) this.elements.laneHintsButton.hidden = !available;
  }

  updateZoomState(scale: number): void {
    this.elements.zoomInButton.disabled = scale >= MAX_ZOOM;
    this.elements.zoomOutButton.disabled = scale <= MIN_ZOOM;
    this.elements.zoomResetButton.disabled = scale <= MIN_ZOOM;
  }
}
