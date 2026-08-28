import type { GameStats } from '../game/stats.js';
import type { GameOverReason } from '../game/engine.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { formatDuration, formatRate } from './format.js';
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
  private readonly recordHigh: HTMLElement;
  private readonly recordBestLabel: HTMLElement;
  private readonly recordBest: HTMLElement;
  private readonly recordAverage: HTMLElement;
  private readonly recordAverageDelta: HTMLElement;
  private readonly recordGames: HTMLElement;
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
    this.recordHigh = mustQuery(fragment, '[data-record="high"]');
    this.recordBestLabel = mustQuery(fragment, '[data-record="best-label"]');
    this.recordBest = mustQuery(fragment, '[data-record="best"]');
    this.recordAverage = mustQuery(fragment, '[data-record="average"]');
    this.recordAverageDelta = mustQuery(fragment, '[data-record="average-delta"]');
    this.recordGames = mustQuery(fragment, '[data-record="games"]');
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
    this.runTime.textContent = formatDuration(playTimeMs);
    this.runDropped.textContent = discsDropped.toLocaleString('en-US');
    this.runBroken.textContent = discsBroken.toLocaleString('en-US');
    this.runScoreRate.textContent = formatRate(score, playTimeMs);
    this.runDropRate.textContent = formatRate(discsDropped, playTimeMs);
    this.runBrokenRate.textContent = formatRate(discsBroken, playTimeMs);
    this.recordHigh.textContent = stats.highScore.toLocaleString('en-US');
    this.recordBestLabel.textContent = isStackMode ? 'BEST TURN' : 'BEST CHAIN';
    this.recordBest.textContent = isStackMode
      ? `${stats.longestStreak.toLocaleString('en-US')} cleared`
      : `${stats.longestStreak.toLocaleString('en-US')} wave${stats.longestStreak === 1 ? '' : 's'}`;
    this.recordAverage.textContent = stats.averageScore.toLocaleString('en-US');
    this.applyAverageDelta(stats, score);
    this.rewindButton.hidden = !canRewind;
    this.actions.classList.toggle('game-over-actions--rewind', canRewind);
    this.newGameButton.classList.toggle('game-over-button--primary', !canRewind);
    this.modal.open();
  }

  close(): void {
    this.modal.close();
  }

  /**
   * Show how the just-finished game moved the running average. `stats` already
   * counts this game (its score is folded into `totalScore` and `gamesPlayed`),
   * so the pre-game average is recovered by backing that game out again.
   */
  private applyAverageDelta(stats: GameStats, score: number): void {
    const priorGames = stats.gamesPlayed - 1;
    this.recordAverageDelta.className = 'game-over-record__delta';
    if (priorGames <= 0) {
      this.recordAverageDelta.hidden = true;
      this.recordAverageDelta.removeAttribute('aria-label');
      this.recordGames.textContent = 'Your first recorded game';
      return;
    }
    const priorAverage = Math.round((stats.totalScore - score) / priorGames);
    const delta = stats.averageScore - priorAverage;
    const magnitude = Math.abs(delta).toLocaleString('en-US');
    const priorText = priorAverage.toLocaleString('en-US');
    this.recordGames.textContent = `over ${stats.gamesPlayed.toLocaleString('en-US')} games`;
    this.recordAverageDelta.hidden = false;
    if (delta > 0) {
      this.recordAverageDelta.classList.add('game-over-record__delta--up');
      this.recordAverageDelta.textContent = `▲ ${magnitude}`;
      this.recordAverageDelta.setAttribute('aria-label', `Average rose ${magnitude} from ${priorText}`);
    } else if (delta < 0) {
      this.recordAverageDelta.classList.add('game-over-record__delta--down');
      this.recordAverageDelta.textContent = `▼ ${magnitude}`;
      this.recordAverageDelta.setAttribute('aria-label', `Average fell ${magnitude} from ${priorText}`);
    } else {
      this.recordAverageDelta.classList.add('game-over-record__delta--flat');
      this.recordAverageDelta.textContent = 'no change';
      this.recordAverageDelta.setAttribute('aria-label', `Average held at ${priorText}`);
    }
  }

  private makeHighlight(label: string): HTMLElement {
    const highlight = document.createElement('span');
    highlight.className = 'game-over-highlight';
    highlight.textContent = label;
    return highlight;
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
