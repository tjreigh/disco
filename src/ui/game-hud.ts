import type { Disc } from '../game/model.js';
import { DiscKind } from '../game/model.js';
import { GamePhase } from '../game/state.js';

export interface GameHudState {
  phase: GamePhase;
  score: number;
  currentDisc: Disc;
  nextDisc: Disc;
  level: number;
  initialTurnsPerLevel: number;
  turnsPerLevel: number;
  turnsRemaining: number;
  hasGravity: boolean;
  gravityAngle?: number | undefined;
}

/** Semantic gameplay status displayed as a DOM overlay over the board canvas. */
export class GameHud {
  readonly root: HTMLElement;
  private readonly score: HTMLElement;
  private readonly level: HTMLElement;
  private readonly turns: HTMLElement;
  private readonly current: HTMLElement;
  private readonly next: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly gravity: HTMLElement;

  constructor(container?: HTMLElement | null) {
    this.root = document.createElement('section');
    this.root.className = 'game-hud';
    this.root.setAttribute('aria-label', 'Game status');
    this.root.hidden = true;

    const top = document.createElement('div');
    top.className = 'game-hud__top';
    const summary = document.createElement('div');
    summary.className = 'game-hud__summary';
    this.score = this.makeValue('Score', 'game-hud__score');
    this.level = this.makeValue('Level', 'game-hud__level');
    this.turns = this.makeValue('Turns remaining', 'game-hud__turns');
    summary.append(this.score, this.turns, this.level);

    top.append(summary);

    const bottom = document.createElement('div');
    bottom.className = 'game-hud__bottom';
    const queue = document.createElement('div');
    queue.className = 'game-hud__queue';
    this.current = this.makeDiscSlot('Current disc');
    this.next = this.makeDiscSlot('Next disc');
    queue.append(this.current, this.next);

    this.gravity = document.createElement('span');
    this.gravity.className = 'game-hud__gravity';
    this.gravity.setAttribute('aria-live', 'polite');
    this.hint = document.createElement('p');
    this.hint.className = 'game-hud__hint';

    top.append(this.gravity);
    bottom.append(queue, this.hint);
    this.root.append(top, bottom);
    (container ?? document.querySelector<HTMLElement>('.game-stage') ?? document.body).append(this.root);
  }

  render(state: GameHudState): void {
    this.root.hidden = state.phase === GamePhase.Menu;
    this.root.dataset.phase = state.phase;
    this.score.textContent = state.score.toLocaleString('en-US');
    this.level.textContent = `Level ${state.level}`;
    const turnsRemaining = Math.max(0, state.turnsRemaining);
    const turnsTotal = Math.max(0, state.turnsPerLevel);
    const turnsScale = Math.max(turnsTotal, state.initialTurnsPerLevel);
    this.turns.replaceChildren();
    this.turns.append(`Turn ${turnsRemaining} / ${turnsTotal}`);
    const pips = document.createElement('span');
    pips.className = 'game-hud__pips';
    pips.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < turnsTotal; index++) {
      const pip = document.createElement('i');
      pip.className = `game-hud__pip${index < turnsRemaining ? ' game-hud__pip--remaining' : ''}`;
      pips.append(pip);
    }
    for (let index = turnsTotal; index < turnsScale; index++) {
      const pip = document.createElement('i');
      pip.className = 'game-hud__pip game-hud__pip--placeholder';
      pips.append(pip);
    }
    this.turns.append(pips);
    this.renderDisc(this.current, state.currentDisc, 'Current disc');
    this.renderDisc(this.next, state.nextDisc, 'Next disc');

    if (state.hasGravity) {
      this.gravity.textContent = `Gravity ${gravityDirection(state.gravityAngle ?? 0)}`;
      this.gravity.hidden = false;
    } else {
      this.gravity.textContent = '';
      this.gravity.hidden = true;
    }
    this.hint.textContent = hintFor(state);
  }

  destroy(): void {
    this.root.remove();
  }

  private makeValue(label: string, className: string): HTMLElement {
    const element = document.createElement('span');
    element.className = className;
    element.setAttribute('aria-label', label);
    return element;
  }

  private makeDiscSlot(label: string): HTMLElement {
    const element = document.createElement('span');
    element.className = 'game-hud__disc-slot';
    element.setAttribute('aria-label', label);
    return element;
  }

  private renderDisc(slot: HTMLElement, disc: Disc, label: string): void {
    slot.replaceChildren();
    slot.setAttribute('aria-label', `${label}: ${discLabel(disc)}`);
    const caption = document.createElement('span');
    caption.className = 'game-hud__disc-caption';
    caption.textContent = label === 'Current disc' ? 'Now' : 'Next';
    const discElement = document.createElement('span');
    discElement.className = 'game-hud__disc';
    discElement.dataset.kind = disc.kind;
    discElement.dataset.value = String(disc.value);
    discElement.textContent = disc.kind === DiscKind.Numbered ? String(disc.value) : '*';
    discElement.setAttribute('aria-hidden', 'true');
    slot.append(caption, discElement);
  }
}

function discLabel(disc: Disc): string {
  return disc.kind === DiscKind.Numbered ? `number ${disc.value}` : disc.kind.replace('-', ' ');
}

function gravityDirection(angle: number): string {
  const directions = ['down', 'down-right', 'right', 'up-right', 'up', 'up-left', 'left', 'down-left'];
  const index = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return directions[index]!;
}

function hintFor(state: GameHudState): string {
  if (state.phase === GamePhase.Aiming) return 'Adjust gravity, then confirm or cancel';
  if (state.phase === GamePhase.Animating) return 'Resolving turn';
  if (state.hasGravity) return 'Choose a lane, drop, or adjust gravity';
  return 'Choose a column and drop';
}
