import type { GameStats } from '../game/stats.js';
import { blurOnClick } from './dom-utils.js';

export interface GameOverSummary {
  score: number;
  stats: GameStats;
  isStackMode: boolean;
}

/** Accessible end-of-game actions layered above the canvas presentation. */
export class GameOverScreen {
  private readonly overlay: HTMLElement;
  private readonly score: HTMLElement;
  private readonly records: HTMLElement;
  private readonly average: HTMLElement;
  private readonly newGameButton: HTMLButtonElement;
  private readonly homeButton: HTMLButtonElement;

  onRequestNewGame?: () => void;
  onRequestHome?: () => void;

  constructor() {
    this.overlay = document.createElement('section');
    this.overlay.className = 'game-over-screen';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'game-over-title');
    this.overlay.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('div');
    panel.className = 'game-over-panel';

    const title = document.createElement('h2');
    title.id = 'game-over-title';
    title.textContent = 'GAME OVER';

    this.score = document.createElement('p');
    this.score.className = 'game-over-score';

    this.records = document.createElement('p');
    this.records.className = 'game-over-records';

    this.average = document.createElement('p');
    this.average.className = 'game-over-average';

    const actions = document.createElement('div');
    actions.className = 'game-over-actions';

    this.newGameButton = this.createButton('NEW GAME', 'game-over-button--primary', () => {
      this.onRequestNewGame?.();
    });
    this.homeButton = this.createButton('HOME', '', () => {
      this.onRequestHome?.();
    });
    actions.append(this.newGameButton, this.homeButton);

    panel.append(title, this.score, this.records, this.average, actions);
    this.overlay.append(panel);
    this.overlay.addEventListener('keydown', event => this.keepFocusInside(event));
    document.body.append(this.overlay);
  }

  open({ score, stats, isStackMode }: GameOverSummary): void {
    const recordLabel = isStackMode ? 'Best stack' : 'Longest chain';
    this.score.textContent = `Score ${score.toLocaleString('en-US')}`;
    this.records.textContent = `High ${stats.highScore.toLocaleString('en-US')} · ${recordLabel} ${stats.longestStreak.toLocaleString('en-US')}`;
    this.average.textContent = `Average ${stats.averageScore.toLocaleString('en-US')} over ${stats.gamesPlayed.toLocaleString('en-US')} game${stats.gamesPlayed === 1 ? '' : 's'}`;
    this.overlay.classList.add('game-over-screen--open');
    this.overlay.setAttribute('aria-hidden', 'false');
    this.newGameButton.focus();
  }

  close(): void {
    this.overlay.classList.remove('game-over-screen--open');
    this.overlay.setAttribute('aria-hidden', 'true');
    if (this.overlay.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }

  private createButton(label: string, modifier: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `game-over-button${modifier ? ` ${modifier}` : ''}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return blurOnClick(button);
  }

  private keepFocusInside(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const first = this.newGameButton;
    const last = this.homeButton;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
