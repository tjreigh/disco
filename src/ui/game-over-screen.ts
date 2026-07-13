import type { GameStats } from '../game/stats.js';
import type { GameOverReason } from '../game/engine.js';
import { blurOnClick } from './dom-utils.js';

export interface GameOverSummary {
  score: number;
  stats: GameStats;
  isStackMode: boolean;
  bestRunRecord: number;
  previousHighScore: number;
  previousBestRecord: number;
  reason?: GameOverReason;
}

/** Accessible end-of-game actions layered above the canvas presentation. */
export class GameOverScreen {
  private readonly overlay: HTMLElement;
  private readonly score: HTMLElement;
  private readonly highlights: HTMLElement;
  private readonly scoreContext: HTMLElement;
  private readonly reason: HTMLElement;
  private readonly runRecord: HTMLElement;
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

    this.highlights = document.createElement('div');
    this.highlights.className = 'game-over-highlights';
    this.highlights.hidden = true;

    this.score = document.createElement('p');
    this.score.className = 'game-over-score';

    this.scoreContext = document.createElement('p');
    this.scoreContext.className = 'game-over-score-context';
    this.scoreContext.hidden = true;

    const runSummary = document.createElement('div');
    runSummary.className = 'game-over-run-summary';

    this.reason = document.createElement('p');
    this.reason.className = 'game-over-reason';

    this.runRecord = document.createElement('p');
    this.runRecord.className = 'game-over-run-record';
    runSummary.append(this.reason, this.runRecord);

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

    panel.append(
      title,
      this.highlights,
      this.score,
      this.scoreContext,
      runSummary,
      this.records,
      this.average,
      actions,
    );
    this.overlay.append(panel);
    this.overlay.addEventListener('keydown', event => this.keepFocusInside(event));
    document.body.append(this.overlay);
  }

  open({
    score,
    stats,
    isStackMode,
    bestRunRecord,
    previousHighScore,
    previousBestRecord,
    reason,
  }: GameOverSummary): void {
    const recordLabel = isStackMode ? 'Best stack' : 'Longest chain';
    const newHighScore = score > previousHighScore;
    const newBestRecord = bestRunRecord > previousBestRecord;

    this.highlights.replaceChildren();
    if (newHighScore) this.highlights.append(this.makeHighlight('NEW HIGH SCORE'));
    if (newBestRecord) {
      this.highlights.append(this.makeHighlight(isStackMode ? 'NEW BEST STACK' : 'NEW BEST CHAIN'));
    }
    this.highlights.hidden = !newHighScore && !newBestRecord;

    this.score.textContent = `Score ${score.toLocaleString('en-US')}`;
    this.scoreContext.textContent = newHighScore
      ? previousHighScore > 0
        ? `${(score - previousHighScore).toLocaleString('en-US')} above your previous best`
        : 'Your first recorded high score'
      : '';
    this.scoreContext.hidden = !newHighScore;

    this.reason.textContent = reason === 'push-overflow'
      ? 'The level push overflowed the board.'
      : reason === 'board-full'
        ? 'The board filled with no legal moves left.'
        : 'The run has ended.';
    this.runRecord.textContent = bestRunRecord > 0
      ? `Best ${isStackMode ? 'stack' : 'chain'} this game: ${bestRunRecord.toLocaleString('en-US')}`
      : '';
    this.runRecord.hidden = bestRunRecord <= 0;
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

  private makeHighlight(label: string): HTMLElement {
    const highlight = document.createElement('span');
    highlight.className = 'game-over-highlight';
    highlight.textContent = label;
    return highlight;
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
