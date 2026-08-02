import { perMinuteRate, type GameStats } from '../game/stats.js';
import type { GameOverReason } from '../game/engine.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

export const GAME_OVER_RUN_STATS_EXPANDED_KEY = 'disco.game-over.run-stats-expanded';

export interface GameOverSummary {
  score: number;
  stats: GameStats;
  isStackMode: boolean;
  bestRunRecord: number;
  previousHighScore: number;
  previousBestRecord: number;
  playTimeMs: number;
  discsDropped: number;
  discsBroken: number;
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
  private readonly runTime: HTMLElement;
  private readonly runDropped: HTMLElement;
  private readonly runBroken: HTMLElement;
  private readonly runScoreRate: HTMLElement;
  private readonly runDropRate: HTMLElement;
  private readonly runBrokenRate: HTMLElement;
  private readonly runStatsToggle: HTMLButtonElement;
  private readonly runStatsDetails: HTMLElement;
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
    this.runTime = mustQuery(fragment, '[data-run-stat="time"]');
    this.runDropped = mustQuery(fragment, '[data-run-stat="dropped"]');
    this.runBroken = mustQuery(fragment, '[data-run-stat="broken"]');
    this.runScoreRate = mustQuery(fragment, '[data-run-stat="score-rate"]');
    this.runDropRate = mustQuery(fragment, '[data-run-stat="drop-rate"]');
    this.runBrokenRate = mustQuery(fragment, '[data-run-stat="broken-rate"]');
    this.runStatsToggle = mustQuery(fragment, '.game-over-run-stats__toggle');
    this.runStatsDetails = mustQuery(fragment, '.game-over-run-stats__details');
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
    this.runStatsToggle.addEventListener('click', () => {
      this.setRunStatsExpanded(this.runStatsToggle.getAttribute('aria-expanded') !== 'true');
    });
    this.setRunStatsExpanded(this.loadRunStatsExpanded(), false);

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
    playTimeMs,
    discsDropped,
    discsBroken,
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
    this.runTime.textContent = this.formatDuration(playTimeMs);
    this.runDropped.textContent = discsDropped.toLocaleString('en-US');
    this.runBroken.textContent = discsBroken.toLocaleString('en-US');
    this.runScoreRate.textContent = this.formatRate(score, playTimeMs);
    this.runDropRate.textContent = this.formatRate(discsDropped, playTimeMs);
    this.runBrokenRate.textContent = this.formatRate(discsBroken, playTimeMs);
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

  private formatDuration(milliseconds: number): string {
    const totalMinutes = Math.floor(milliseconds / 60_000);
    if (totalMinutes < 1) return '<1m';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  private formatRate(total: number, playTimeMs: number): string {
    const rate = perMinuteRate(total, playTimeMs);
    return rate === null
      ? '—'
      : rate.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }

  private setRunStatsExpanded(expanded: boolean, persist = true): void {
    this.runStatsToggle.setAttribute('aria-expanded', String(expanded));
    this.runStatsDetails.hidden = !expanded;
    if (!persist) return;
    try {
      window.localStorage.setItem(GAME_OVER_RUN_STATS_EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      // The disclosure still retains its state for this page when storage is unavailable.
    }
  }

  private loadRunStatsExpanded(): boolean {
    try {
      return window.localStorage.getItem(GAME_OVER_RUN_STATS_EXPANDED_KEY) === '1';
    } catch {
      return false;
    }
  }

}
