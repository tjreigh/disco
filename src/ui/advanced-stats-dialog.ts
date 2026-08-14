import type { SoloModeDefinition } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { formatDuration, formatRate } from './format.js';
import { ModalController } from './modal-controller.js';

export interface AdvancedStatsMode {
  mode: SoloModeDefinition;
  stats: GameStats;
}

export interface AdvancedStatsDialogOptions {
  modes: readonly AdvancedStatsMode[];
  modeId?: string;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export class AdvancedStatsDialog {
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly modal: ModalController;

  constructor(
    mount: HTMLElement = document.body,
    modalBackground: readonly HTMLElement[] = [],
  ) {
    const fragment = cloneTemplate('tpl-advanced-stats-dialog');
    this.root = mustQuery(fragment, '.advanced-stats-dialog');
    this.content = mustQuery(fragment, '.advanced-stats-dialog__content');
    this.closeButton = mustQuery(fragment, '.advanced-stats-dialog__close');
    this.closeButton.addEventListener('click', () => this.close());
    blurOnClick(this.closeButton);
    mount.append(fragment);

    this.modal = new ModalController(this.root, {
      openClass: 'advanced-stats-dialog--open',
      initialFocus: () => this.closeButton,
      inertTargets: modalBackground,
      onEscape: () => this.close(),
    });
  }

  open(options: AdvancedStatsDialogOptions): void {
    this.render(options.modes);
    this.modal.open();
    if (!options.modeId) {
      this.root.scrollTop = 0;
      return;
    }
    const section = Array.from(this.content.querySelectorAll<HTMLElement>('[data-advanced-stats-mode]'))
      .find(candidate => candidate.dataset.advancedStatsMode === options.modeId);
    if (!section) return;
    section.scrollIntoView({ block: 'start' });
    section.classList.add('advanced-stats-dialog__section--jump-target');
    section.focus({ preventScroll: true });
  }

  close(): void {
    this.modal.close();
  }

  isOpen(): boolean {
    return this.modal.isOpen();
  }

  private render(modes: readonly AdvancedStatsMode[]): void {
    const totals = modes.reduce<GameStats>((sum, entry) => ({
      highScore: Math.max(sum.highScore, entry.stats.highScore),
      longestStreak: Math.max(sum.longestStreak, entry.stats.longestStreak),
      averageScore: 0,
      gamesPlayed: sum.gamesPlayed + entry.stats.gamesPlayed,
      totalScore: sum.totalScore + entry.stats.totalScore,
      totalPlayTimeMs: sum.totalPlayTimeMs + entry.stats.totalPlayTimeMs,
      totalDiscsDropped: sum.totalDiscsDropped + entry.stats.totalDiscsDropped,
      totalDiscsBroken: sum.totalDiscsBroken + entry.stats.totalDiscsBroken,
    }), {
      highScore: 0,
      longestStreak: 0,
      averageScore: 0,
      gamesPlayed: 0,
      totalScore: 0,
      totalPlayTimeMs: 0,
      totalDiscsDropped: 0,
      totalDiscsBroken: 0,
    });

    const fragment = document.createDocumentFragment();
    fragment.append(this.createSection('ALL MODES', totals, true));
    for (const { mode, stats } of modes) {
      const section = this.createSection(mode.name.toUpperCase(), stats, false);
      section.id = `advanced-stats-mode-${mode.id}`;
      section.dataset.advancedStatsMode = mode.id;
      section.tabIndex = -1;
      fragment.append(section);
    }
    this.content.replaceChildren(fragment);
  }

  private createSection(titleText: string, stats: GameStats, totals: boolean): HTMLElement {
    const section = document.createElement('section');
    section.className = `advanced-stats-dialog__section${totals ? ' advanced-stats-dialog__section--totals' : ''}`;
    const title = document.createElement('h3');
    title.textContent = titleText;
    const list = document.createElement('dl');
    list.className = 'advanced-stats-dialog__stats';
    this.appendStat(list, 'Games played', formatNumber(stats.gamesPlayed));
    this.appendStat(list, 'Time played', formatDuration(stats.totalPlayTimeMs));
    this.appendStat(list, 'Score', formatNumber(stats.totalScore));
    this.appendStat(list, 'Discs dropped', formatNumber(stats.totalDiscsDropped));
    this.appendStat(list, 'Discs broken', formatNumber(stats.totalDiscsBroken));
    this.appendStat(list, 'Score / min', formatRate(stats.totalScore, stats.totalPlayTimeMs));
    this.appendStat(list, 'Dropped / min', formatRate(stats.totalDiscsDropped, stats.totalPlayTimeMs));
    this.appendStat(list, 'Broken / min', formatRate(stats.totalDiscsBroken, stats.totalPlayTimeMs));
    section.append(title, list);
    return section;
  }

  private appendStat(list: HTMLDListElement, label: string, value: string): void {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    row.append(term, description);
    list.append(row);
  }
}
