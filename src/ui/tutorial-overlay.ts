import type { TutorialDefinition, TutorialStep } from '../app/tutorial.js';
import { blurOnClick } from './dom-utils.js';

export class TutorialOverlay {
  private readonly root: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly title: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly exitButton: HTMLButtonElement;
  private complete = false;
  private completeTimer: number | null = null;
  // The current step's own prompt — what setAimingPrompt(null) restores.
  private basePrompt = '';

  onRetry?: () => void;
  onExit?: () => void;
  onContinue?: () => void;

  constructor(mount: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'tutorial-overlay';
    this.root.setAttribute('aria-live', 'polite');

    this.eyebrow = document.createElement('div');
    this.eyebrow.className = 'tutorial-eyebrow';

    this.title = document.createElement('div');
    this.title.className = 'tutorial-title';

    this.prompt = document.createElement('div');
    this.prompt.className = 'tutorial-prompt';

    const actions = document.createElement('div');
    actions.className = 'tutorial-actions';

    this.retryButton = this.createButton('RETRY', () => {
      if (this.complete) {
        this.onContinue?.();
      } else {
        this.onRetry?.();
      }
    });
    this.exitButton = this.createButton('EXIT', () => this.onExit?.());
    actions.append(this.retryButton, this.exitButton);

    this.root.append(this.eyebrow, this.title, this.prompt, actions);
    mount.append(this.root);
  }

  show(definition: TutorialDefinition, index: number): void {
    this.clearCompleteTimer();
    const step = definition.steps[index];
    if (!step) return;
    this.render(definition, step, index);
    this.setAimingPrompt(null);
    this.complete = false;
    this.retryButton.hidden = false;
    this.retryButton.textContent = 'RETRY';
    this.exitButton.textContent = 'EXIT';
    this.root.classList.add('tutorial-overlay--visible');
  }

  showComplete(definition: TutorialDefinition, modeName: string): void {
    this.clearCompleteTimer();
    this.complete = true;
    this.eyebrow.textContent = definition.title;
    this.title.textContent = 'Tutorial Complete';
    // basePrompt moves to the completion copy so a later setAimingPrompt(null)
    // can't restore a stale tutorial-step prompt over this screen.
    this.basePrompt = `You can keep playing from here in ${modeName} mode.`;
    this.setAimingPrompt(null);
    this.retryButton.hidden = false;
    this.retryButton.textContent = 'KEEP PLAYING';
    this.exitButton.textContent = 'EXIT';
    this.root.classList.add('tutorial-overlay--visible');
    this.completeTimer = window.setTimeout(() => {
      this.onContinue?.();
      this.completeTimer = null;
    }, 4_000);
  }

  hide(): void {
    this.clearCompleteTimer();
    this.root.classList.remove('tutorial-overlay--visible');
  }

  private render(definition: TutorialDefinition, step: TutorialStep, index: number): void {
    this.eyebrow.textContent = `${definition.title} ${index + 1}/${definition.steps.length}`;
    this.title.textContent = step.title;
    this.basePrompt = step.prompt;
    this.prompt.textContent = step.prompt;
  }

  /**
   * Swaps the prompt to a gravity step's Aiming copy ("now you must tilt");
   * null restores the current step's own prompt. Safe to call unconditionally
   * — a no-op restore when nothing was overridden.
   */
  setAimingPrompt(text: string | null): void {
    this.prompt.textContent = text ?? this.basePrompt;
    this.root.classList.toggle('tutorial-overlay--aiming', text !== null);
  }

  private createButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tutorial-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    blurOnClick(button);
    return button;
  }

  private clearCompleteTimer(): void {
    if (this.completeTimer === null) return;
    window.clearTimeout(this.completeTimer);
    this.completeTimer = null;
  }
}
