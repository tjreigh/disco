import type { GameStats } from '../game/stats.js';
import type { GameOverReason } from '../game/engine.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

export interface GameOverSummary {
  score: number;
  stats: GameStats;
  isStackMode: boolean;
  bestRunRecord: number;
  previousHighScore: number;
  previousBestRecord: number;
  reason?: GameOverReason;
  canRewind?: boolean;
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
  private readonly rewindButton: HTMLButtonElement;
  private readonly actions: HTMLElement;
  private readonly homeButton: HTMLButtonElement;
  private readonly modal: ModalController;

  onRequestNewGame?: () => void;
  onRequestHome?: () => void;
  onRequestRewind?: () => void;

  constructor(
    mount: HTMLElement = document.body,
    modalBackground: readonly HTMLElement[] = [],
  ) {
    const fragment = cloneTemplate('tpl-game-over-screen');
    this.overlay = mustQuery(fragment, '.game-over-screen');
    this.highlights = mustQuery(fragment, '.game-over-highlights');
    this.score = mustQuery(fragment, '.game-over-score');
    this.scoreContext = mustQuery(fragment, '.game-over-score-context');
    this.reason = mustQuery(fragment, '.game-over-reason');
    this.runRecord = mustQuery(fragment, '.game-over-run-record');
    this.records = mustQuery(fragment, '.game-over-records');
    this.average = mustQuery(fragment, '.game-over-average');
    this.actions = mustQuery(fragment, '.game-over-actions');
    this.rewindButton = mustQuery(fragment, '.game-over-button--rewind');
    this.newGameButton = mustQuery(fragment, '.game-over-button--primary');
    this.homeButton = mustQuery(fragment, '[data-ui-ref="home"]');

    this.rewindButton.addEventListener('click', () => this.onRequestRewind?.());
    blurOnClick(this.rewindButton);
    this.newGameButton.addEventListener('click', () => this.onRequestNewGame?.());
    blurOnClick(this.newGameButton);
    this.homeButton.addEventListener('click', () => this.onRequestHome?.());
    blurOnClick(this.homeButton);

    mount.append(fragment);
    this.modal = new ModalController(this.overlay, {
      openClass: 'game-over-screen--open',
      initialFocus: () => this.rewindButton.hidden ? this.newGameButton : this.rewindButton,
      inertTargets: modalBackground,
    });
  }

  open({
    score,
    stats,
    isStackMode,
    bestRunRecord,
    previousHighScore,
    previousBestRecord,
    reason,
    canRewind = false,
  }: GameOverSummary): void {
    const recordLabel = isStackMode ? 'Best turn' : 'Best chain';
    const newHighScore = score > previousHighScore;
    const newBestRecord = bestRunRecord > previousBestRecord;

    this.highlights.replaceChildren();
    if (newHighScore) this.highlights.append(this.makeHighlight('NEW HIGH SCORE'));
    if (newBestRecord) {
      this.highlights.append(this.makeHighlight(isStackMode ? 'NEW BEST TURN' : 'NEW BEST CHAIN'));
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
      ? isStackMode
        ? `Most cleared in one turn: ${bestRunRecord.toLocaleString('en-US')}`
        : `Best chain this game: ${bestRunRecord.toLocaleString('en-US')} wave${bestRunRecord === 1 ? '' : 's'}`
      : '';
    this.runRecord.hidden = bestRunRecord <= 0;
    const recordUnit = isStackMode ? 'cleared' : `wave${stats.longestStreak === 1 ? '' : 's'}`;
    this.records.textContent = `High ${stats.highScore.toLocaleString('en-US')} · ${recordLabel} ${stats.longestStreak.toLocaleString('en-US')} ${recordUnit}`;
    this.average.textContent = `Average ${stats.averageScore.toLocaleString('en-US')} over ${stats.gamesPlayed.toLocaleString('en-US')} game${stats.gamesPlayed === 1 ? '' : 's'}`;
    this.rewindButton.hidden = !canRewind;
    this.actions.classList.toggle('game-over-actions--rewind', canRewind);
    this.newGameButton.classList.toggle('game-over-button--primary', !canRewind);
    this.modal.open();
  }

  close(): void {
    this.modal.close();
  }

  private makeHighlight(label: string): HTMLElement {
    const highlight = document.createElement('span');
    highlight.className = 'game-over-highlight';
    highlight.textContent = label;
    return highlight;
  }

}
