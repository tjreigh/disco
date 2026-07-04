import { countHorizontalRun, countVerticalRun } from '../../game/board.js';
import type { TurnResult } from '../../game/engine.js';
import type { Board, Disc } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import type { GameState } from '../../game/state.js';
import { StepKind } from '../../game/events.js';
import { buildDebugReport } from './debug-report.js';

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
        return `${index + 1}. DROP #${step.disc.id} value=${step.disc.value} → ${position(step.toLandRow, step.col)}`;
      case StepKind.Clear:
        return `${index + 1}. CLEAR chain=${step.chainLevel} [${step.cleared.map(p => position(p.row, p.col)).join(', ')}] +${step.pointsAwarded}`;
      case StepKind.Reveal:
        return `${index + 1}. REVEAL [${step.positions.map(p => position(p.row, p.col)).join(', ')}]`;
      case StepKind.Fall:
        return `${index + 1}. FALL ${step.moves.map(m => `${position(m.from.row, m.from.col)}→${position(m.to.row, m.to.col)}`).join(', ')}`;
      case StepKind.Push:
        return `${index + 1}. PUSH ${step.newRow.length} cracked tiles`;
    }
  });
}

export class DebugPanel {
  private readonly panel: HTMLElement;
  private readonly content: HTMLElement;
  private lastResult: TurnResult | null = null;
  private readonly turnHistory: TurnResult[] = [];
  private playbackFrame = -1;
  private issueNote = '';
  private readonly flags = new Map<string, string>();

  constructor(private readonly state: GameState) {
    const toggle = document.createElement('button');
    toggle.className = 'debug-toggle';
    toggle.type = 'button';
    toggle.textContent = 'LOGIC';
    toggle.title = 'Toggle logic debugger (D)';

    this.panel = document.createElement('aside');
    this.panel.className = 'debug-panel';
    this.panel.setAttribute('aria-label', 'Game logic debugger');

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'GAME LOGIC';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close debugger');
    header.append(title, close);

    this.content = document.createElement('div');
    this.content.className = 'debug-content';
    this.panel.append(header, this.content);
    document.body.append(toggle, this.panel);

    const setOpen = (open: boolean): void => {
      this.panel.classList.toggle('debug-panel--open', open);
    };
    toggle.addEventListener('click', () => setOpen(!this.panel.classList.contains('debug-panel--open')));
    close.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'd' || event.key === 'D') setOpen(!this.panel.classList.contains('debug-panel--open'));
    });
    this.render();
  }

  recordTurn(result: TurnResult): void {
    this.lastResult = result;
    this.turnHistory.push(snapshot(result));
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
    this.turnHistory.length = 0;
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

  private exportReport(): void {
    const report = buildDebugReport(this.state, this.turnHistory, this.issueNote, this.flags);
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

    const summary = document.createElement('div');
    summary.className = 'debug-summary';
    summary.textContent = `phase=${this.state.phase}  score=${this.state.score}  drops=${this.state.dropCount}  level=${this.state.level}  turnsLeft=${this.state.turnsRemaining}/${this.state.turnsPerLevel}`;
    this.content.append(
      summary,
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

    const report = document.createElement('section');
    report.className = 'debug-report';
    const reportHeading = this.heading('Issue report');
    const help = document.createElement('p');
    help.className = 'debug-muted';
    help.textContent = 'Select FLAG on an event or click any board cell that looks wrong. The export includes the complete turn history for this game.';
    const note = document.createElement('textarea');
    note.value = this.issueNote;
    note.rows = 3;
    note.placeholder = 'What did you expect, and what happened instead?';
    note.setAttribute('aria-label', 'Issue description');
    note.addEventListener('input', () => { this.issueNote = note.value; });
    const actions = document.createElement('div');
    actions.className = 'debug-report-actions';
    const count = document.createElement('span');
    count.textContent = `${this.turnHistory.length} turn${this.turnHistory.length === 1 ? '' : 's'} · ${this.flags.size} flagged`;
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'EXPORT JSON';
    exportButton.addEventListener('click', () => this.exportReport());
    actions.append(count, exportButton);
    report.append(reportHeading, help, note, actions);
    this.content.append(report);

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
