import type { TutorialDefinition, TutorialStep } from '../app/tutorial.js';

export class TutorialOverlay {
  private readonly root: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly title: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly exitButton: HTMLButtonElement;
  private complete = false;
  private completeTimer: number | null = null;

  onRetry?: () => void;
  onExit?: () => void;
  onContinue?: () => void;

  constructor() {
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
    document.body.append(this.root);
  }

  show(definition: TutorialDefinition, index: number): void {
    this.clearCompleteTimer();
    const step = definition.steps[index];
    if (!step) return;
    this.render(definition, step, index);
    this.complete = false;
    this.retryButton.hidden = false;
    this.retryButton.textContent = 'RETRY';
    this.exitButton.textContent = 'EXIT';
    this.root.classList.add('tutorial-overlay--visible');
  }

  showComplete(definition: TutorialDefinition): void {
    this.clearCompleteTimer();
    this.complete = true;
    this.eyebrow.textContent = definition.title;
    this.title.textContent = 'Tutorial Complete';
    this.prompt.textContent = 'You can keep playing from here in Classic mode.';
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
    this.prompt.textContent = step.prompt;
  }

  private createButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tutorial-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  private clearCompleteTimer(): void {
    if (this.completeTimer === null) return;
    window.clearTimeout(this.completeTimer);
    this.completeTimer = null;
  }
}
