import { countHorizontalRun, countVerticalRun } from '../../game/board.js';
import type { TurnResult } from '../../game/engine.js';
import type { Board, Disc } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import type { GameState } from '../../game/state.js';
import { StepKind } from '../../game/events.js';
import { buildDebugReport } from './debug-report.js';
import { blurOnClick, cloneTemplate, mustQuery } from '../dom-utils.js';

export const MAX_TURN_HISTORY = 50;
export type DebugPanelAccess = 'report' | 'full';

const DEBUG_ACCESS_STORAGE_KEY = 'disco.debug.access';

function isLocalHostname(hostname: string): boolean {
  return hostname === '' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1';
}

function readStoredDebugAccess(storage: Storage | null): string | null {
  try {
    return storage?.getItem(DEBUG_ACCESS_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredDebugAccess(storage: Storage | null, value: string): void {
  try {
    storage?.setItem(DEBUG_ACCESS_STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

function removeStoredDebugAccess(storage: Storage | null): void {
  try {
    storage?.removeItem(DEBUG_ACCESS_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function resolveDebugPanelAccess(
  location: Pick<Location, 'hostname' | 'search'> = window.location,
  storage: Storage | null = browserStorage(),
): DebugPanelAccess {
  if (isLocalHostname(location.hostname)) return 'full';

  const requestedAccess = new URLSearchParams(location.search).get('debug')?.toLowerCase() ?? null;
  if (requestedAccess === 'logic' || requestedAccess === 'full') {
    writeStoredDebugAccess(storage, 'full');
    return 'full';
  }
  if (requestedAccess === 'report' || requestedAccess === 'off') {
    removeStoredDebugAccess(storage);
    return 'report';
  }

  const storedAccess = readStoredDebugAccess(storage)?.toLowerCase() ?? null;
  return storedAccess === 'logic' || storedAccess === 'full' ? 'full' : 'report';
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function discText(disc: Disc): string {
  if (disc.kind === DiscKind.SingleCracked) return `${disc.value}╱`;
  if (disc.kind === DiscKind.DoubleCracked) return `${disc.value}╳`;
  return String(disc.value);
}

function position(row: number, col: number): string {
  return `r${row + 1}c${col + 1}`;
}

function isClearable(board: Board, row: number, col: number): boolean {
  const disc = board[row]![col];
  return disc?.kind === DiscKind.Numbered &&
    (disc.value === countHorizontalRun(board, row, col) ||
      disc.value === countVerticalRun(board, row, col));
}

interface BoardGridOptions {
  compact?: boolean;
  flagPrefix?: string;
  flags?: ReadonlyMap<string, string>;
  onToggleFlag?: (target: string, label: string) => void;
}

function makeBoardGrid(board: Board, options: BoardGridOptions = {}): HTMLElement {
  const grid = document.createElement('div');
  grid.className = options.compact ? 'debug-grid debug-grid--compact' : 'debug-grid';
  grid.style.gridTemplateColumns = `repeat(${board[0]?.length ?? 0}, 1fr)`;
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row]!.length; col++) {
      const cell = document.createElement('div');
      const disc = board[row]![col];
      cell.className = 'debug-cell';
      if (disc) {
        cell.textContent = discText(disc);
        cell.classList.add(`debug-cell--${disc.kind}`);
        if (isClearable(board, row, col)) cell.classList.add('debug-cell--clearable');
        cell.title = `#${disc.id} ${position(row, col)} ${disc.kind}; value=${disc.value}, horizontal=${countHorizontalRun(board, row, col)}, vertical=${countVerticalRun(board, row, col)}`;
      } else {
        cell.textContent = '·';
        cell.classList.add('debug-cell--empty');
      }
      if (options.flagPrefix && options.flags && options.onToggleFlag) {
        const target = `${options.flagPrefix}.cell.${row}.${col}`;
        const label = `${options.flagPrefix} ${position(row, col)}${disc ? ` #${disc.id} ${disc.kind} value=${disc.value}` : ' empty'}`;
        const toggle = (): void => options.onToggleFlag!(target, label);
        cell.classList.add('debug-cell--flaggable');
        cell.classList.toggle('debug-cell--flagged', options.flags.has(target));
        cell.setAttribute('role', 'checkbox');
        cell.setAttribute('aria-checked', String(options.flags.has(target)));
        cell.tabIndex = 0;
        cell.addEventListener('click', toggle);
        cell.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggle();
        });
      }
      grid.appendChild(cell);
    }
  }
  return grid;
}

function stepText(result: TurnResult): string[] {
  return result.steps.map((step, index) => {
    switch (step.kind) {
      case StepKind.Drop:
        return `${index + 1}. ${step.temporalEcho ? 'TEMPORAL ECHO' : 'DROP'} #${step.disc.id} value=${step.disc.value} → ${position(step.landPos.row, step.landPos.col)}`;
      case StepKind.Clear:
        return `${index + 1}. CLEAR chain=${step.chainLevel} [${step.cleared.map(p => position(p.row, p.col)).join(', ')}] +${step.pointsAwarded}`;
      case StepKind.Reveal:
        return `${index + 1}. REVEAL [${step.positions.map(p => position(p.row, p.col)).join(', ')}]`;
      case StepKind.Fall:
        return `${index + 1}. FALL ${step.moves.map(m => `${position(m.from.row, m.from.col)}→${position(m.to.row, m.to.col)}`).join(', ')}`;
      case StepKind.Push:
        return `${index + 1}. PUSH ${step.newDiscs.length} cracked tiles from ${step.edge}`;
      case StepKind.Bonus:
        return `${index + 1}. BONUS ${step.bonusKind} +${step.pointsAwarded}`;
    }
  });
}

export function snapshotTurnHistory(
  turnHistory: readonly TurnResult[],
  result: TurnResult,
): { turnHistory: TurnResult[]; truncatedTurns: number } {
  const nextHistory = [...turnHistory, snapshot(result)];
  if (nextHistory.length <= MAX_TURN_HISTORY) {
    return { turnHistory: nextHistory, truncatedTurns: 0 };
  }

  return {
    turnHistory: nextHistory.slice(nextHistory.length - MAX_TURN_HISTORY),
    truncatedTurns: nextHistory.length - MAX_TURN_HISTORY,
  };
}

export class DebugPanel {
  readonly root: HTMLElement;
  onForceGameOver?: () => void;
  canForceGameOver?: () => boolean;
  private readonly content: HTMLElement;
  private readonly access: DebugPanelAccess;
  private lastResult: TurnResult | null = null;
  private turnHistory: TurnResult[] = [];
  private truncatedTurns = 0;
  private playbackFrame = -1;
  private issueNote = '';
  private readonly flags = new Map<string, string>();

  constructor(
    private readonly state: GameState,
    access: DebugPanelAccess = resolveDebugPanelAccess(),
    mount: HTMLElement = document.body,
  ) {
    this.access = access;

    const fragment = cloneTemplate('tpl-debug-panel');
    this.root = mustQuery(fragment, '.debug-panel');
    const title = mustQuery<HTMLElement>(fragment, 'header strong');
    const close = mustQuery<HTMLButtonElement>(fragment, 'header button');
    this.content = mustQuery(fragment, '.debug-content');

    this.root.setAttribute('aria-label', this.access === 'full' ? 'Game logic debugger' : 'Issue report export');
    title.textContent = this.access === 'full' ? 'GAME LOGIC' : 'ISSUE REPORT';

    mount.append(fragment);

    close.addEventListener('click', () => this.close());
    blurOnClick(close);
    document.addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'd' || event.key === 'D') this.toggle();
    });
    this.render();
  }

  open(): void {
    this.render();
    this.root.classList.add('debug-panel--open');
    this.root.setAttribute('aria-hidden', 'false');
  }

  close(): void {
    this.root.classList.remove('debug-panel--open');
    this.root.setAttribute('aria-hidden', 'true');
  }

  toggle(): void {
    if (this.root.classList.contains('debug-panel--open')) this.close();
    else this.open();
  }

  recordTurn(result: TurnResult): void {
    this.lastResult = result;
    const history = snapshotTurnHistory(this.turnHistory, result);
    this.turnHistory = history.turnHistory;
    this.truncatedTurns += history.truncatedTurns;
    this.playbackFrame = -1;
    this.issueNote = '';
    this.flags.clear();
    this.render();
  }

  advancePlayback(): void {
    this.playbackFrame++;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  reset(): void {
    this.lastResult = null;
    this.turnHistory = [];
    this.truncatedTurns = 0;
    this.playbackFrame = -1;
    this.issueNote = '';
    this.flags.clear();
    this.render();
  }

  private heading(text: string): HTMLElement {
    const heading = document.createElement('h2');
    heading.textContent = text;
    return heading;
  }

  private toggleFlag(target: string, label: string): void {
    if (this.flags.has(target)) this.flags.delete(target);
    else this.flags.set(target, label);
    this.render();
  }

  private flagButton(target: string, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    const flagged = this.flags.has(target);
    button.type = 'button';
    button.className = `debug-flag${flagged ? ' debug-flag--active' : ''}`;
    button.textContent = flagged ? 'FLAGGED' : 'FLAG';
    button.setAttribute('aria-pressed', String(flagged));
    button.title = `${flagged ? 'Remove flag from' : 'Flag'} ${label}`;
    button.addEventListener('click', () => this.toggleFlag(target, label));
    return button;
  }

  private renderReportSection(): HTMLElement {
    const report = document.createElement('section');
    report.className = 'debug-report';
    const reportHeading = this.heading('Issue report');
    const help = document.createElement('p');
    help.className = 'debug-muted';
    help.textContent = this.access === 'full'
      ? 'Select FLAG on an event or click any board cell that looks wrong. The export includes the most recent 50 turns and says how many earlier ones were omitted.'
      : 'Describe what looked wrong, then export the report file. It includes the recent turn history needed to reproduce the issue.';
    const note = document.createElement('textarea');
    note.value = this.issueNote;
    note.rows = 3;
    note.placeholder = 'What did you expect, and what happened instead?';
    note.setAttribute('aria-label', 'Issue description');
    note.addEventListener('input', () => { this.issueNote = note.value; });
    const actions = document.createElement('div');
    actions.className = 'debug-report-actions';
    const count = document.createElement('span');
    count.textContent = `${this.turnHistory.length} turns${this.truncatedTurns ? ` (${this.truncatedTurns} earlier omitted)` : ''} · ${this.flags.size} flagged`;
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'EXPORT JSON';
    exportButton.addEventListener('click', () => this.exportReport());
    actions.append(count, exportButton);
    report.append(reportHeading, help, note, actions);
    return report;
  }

  private renderDebugActions(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'debug-actions';
    const heading = this.heading('Game controls');
    const help = document.createElement('p');
    help.className = 'debug-muted';
    help.textContent = 'Runs the normal game-over flow immediately, including completed-game stats.';
    const forceGameOver = document.createElement('button');
    forceGameOver.type = 'button';
    forceGameOver.className = 'debug-action debug-action--danger';
    forceGameOver.textContent = 'FORCE GAME OVER';
    forceGameOver.disabled = !(this.canForceGameOver?.() ?? false);
    forceGameOver.addEventListener('click', () => {
      if (forceGameOver.disabled) return;
      this.close();
      this.onForceGameOver?.();
    });
    section.append(heading, help, forceGameOver);
    return section;
  }

  private exportReport(): void {
    const report = buildDebugReport(
      this.state,
      this.turnHistory,
      this.truncatedTurns,
      this.issueNote,
      this.flags,
    );
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `disco-debug-${report.exportedAt.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private render(): void {
    const scrollTop = this.content.scrollTop;
    this.content.replaceChildren();

    if (this.access === 'report') {
      this.content.append(this.renderReportSection());
      this.content.scrollTop = scrollTop;
      return;
    }

    const summary = document.createElement('div');
    summary.className = 'debug-summary';
    summary.textContent = `phase=${this.state.phase}  score=${this.state.score}  drops=${this.state.dropCount}  level=${this.state.level}  turnsLeft=${this.state.turnsRemaining}/${this.state.turnsPerLevel}`;
    this.content.append(
      summary,
      this.renderDebugActions(),
      this.heading('Committed board'),
      makeBoardGrid(this.state.board, {
        flagPrefix: 'committed-board',
        flags: this.flags,
        onToggleFlag: (target, label) => this.toggleFlag(target, label),
      }),
    );

    const unresolved: string[] = [];
    for (let row = 0; row < this.state.board.length; row++) {
      for (let col = 0; col < this.state.board[row]!.length; col++) {
        const disc = this.state.board[row]![col];
        if (!disc || !isClearable(this.state.board, row, col)) continue;
        unresolved.push(`#${disc.id} v${disc.value} ${position(row, col)} (horizontal=${countHorizontalRun(this.state.board, row, col)}, vertical=${countVerticalRun(this.state.board, row, col)})`);
      }
    }
    const audit = document.createElement('div');
    audit.className = unresolved.length ? 'debug-alert' : 'debug-ok';
    audit.textContent = unresolved.length
      ? `UNRESOLVED CLEAR${unresolved.length > 1 ? 'S' : ''}: ${unresolved.join('; ')}`
      : 'Clear audit: no numbered tile currently qualifies.';
    this.content.append(audit);

    this.content.append(this.renderReportSection());

    if (!this.lastResult) {
      const empty = document.createElement('p');
      empty.className = 'debug-muted';
      empty.textContent = 'Drop a tile to capture a turn trace. Red cells qualify to clear under the current rules.';
      this.content.append(empty);
      this.content.scrollTop = scrollTop;
      return;
    }

    const result = this.lastResult;
    this.content.append(this.heading('Last turn'));
    const outcome = document.createElement('pre');
    outcome.textContent = `accepted=${result.accepted}  reason=${result.reason ?? '—'}\nscoreAwarded=${result.scoreAwarded}  gameOver=${result.gameOver}\nplayback=${Math.min(this.playbackFrame + 1, result.trace.frames.length)}/${result.trace.frames.length}`;
    this.content.append(outcome);

    const stepLines = stepText(result);
    if (stepLines.length === 0) {
      const steps = document.createElement('pre');
      steps.className = 'debug-steps';
      steps.textContent = '(no physics steps)';
      this.content.append(steps);
    } else {
      stepLines.forEach((line, index) => {
        const row = document.createElement('div');
        row.className = 'debug-flag-row';
        const text = document.createElement('code');
        text.textContent = line;
        row.append(this.flagButton(`step.${index}`, `physics step ${index + 1}: ${line}`), text);
        this.content.append(row);
      });
    }
    this.content.append(this.heading('Clear scans'));

    for (const scan of result.trace.scans) {
      const scanIndex = result.trace.scans.indexOf(scan);
      const details = document.createElement('details');
      details.open = scan.clears.length > 0;
      const summaryLine = document.createElement('summary');
      summaryLine.textContent = `chain ${scan.chainLevel}: ${scan.clears.length} clear${scan.clears.length === 1 ? '' : 's'}, ${scan.checks.length} numbered checked`;
      const checks = document.createElement('pre');
      checks.textContent = scan.checks.map(check => {
        const why = check.clearsByRow || check.clearsByCol
          ? `CLEAR by ${[check.clearsByRow ? 'row' : '', check.clearsByCol ? 'col' : ''].filter(Boolean).join('+')}`
          : 'keep';
        return `#${check.discId} v${check.value} ${position(check.pos.row, check.pos.col)}  horizontal=${check.rowCount} vertical=${check.colCount}  ${why}`;
      }).join('\n') || '(no numbered tiles)';
      const flag = this.flagButton(`scan.${scanIndex}`, `clear scan ${scanIndex + 1}, chain ${scan.chainLevel}`);
      details.append(summaryLine, flag, checks);
      this.content.append(details);
    }

    this.content.append(this.heading('Board changes'));
    const before = document.createElement('details');
    const beforeSummary = document.createElement('summary');
    beforeSummary.textContent = '0. Before drop';
    before.append(
      beforeSummary,
      this.flagButton('frame.before', 'board before drop'),
      makeBoardGrid(result.boardBefore, {
        compact: true,
        flagPrefix: 'frame.before',
        flags: this.flags,
        onToggleFlag: (target, label) => this.toggleFlag(target, label),
      }),
    );
    this.content.append(before);

    result.trace.frames.forEach((frame, index) => {
      const details = document.createElement('details');
      details.open = index === this.playbackFrame || index === result.trace.frames.length - 1;
      const label = document.createElement('summary');
      label.textContent = `${index + 1}. ${frame.label}${index === this.playbackFrame ? '  ← animation' : ''}`;
      details.append(
        label,
        this.flagButton(`frame.${index}`, `board frame ${index + 1}: ${frame.label}`),
        makeBoardGrid(frame.board, {
          compact: true,
          flagPrefix: `frame.${index}`,
          flags: this.flags,
          onToggleFlag: (target, flagLabel) => this.toggleFlag(target, flagLabel),
        }),
      );
      this.content.append(details);
    });
    this.content.scrollTop = scrollTop;
  }
}
