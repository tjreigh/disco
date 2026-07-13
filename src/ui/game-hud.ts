import type { Disc } from '../game/model.js';
import { DiscKind } from '../game/model.js';
import { GamePhase } from '../game/state.js';
import { computeGravityVector } from '../game/gravity.js';
import { COLOR_GRAVITY_ACCENT, COLOR_TEXT_DIM } from './rendering/theme.js';
import { isTouchDevice } from './dom-utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DIAL_CX = 40;
const DIAL_CY = 40;
const DIAL_RING_R = 26;
const DIAL_BACKDROP_R = 32;
const DIAL_ATTENTION_R = 36;
const DIAL_ARC_R = 38;

export interface GameHudState {
  phase: GamePhase;
  score: number;
  currentDisc: Disc;
  nextDisc: Disc;
  level: number;
  initialTurnsPerLevel: number;
  turnsPerLevel: number;
  turnsRemaining: number;
  /** Shared full-width pip capacity; modes with fewer turns occupy the leftmost slots. */
  turnPipCapacity?: number;
  hasGravity: boolean;
  gravityAngle?: number | undefined;
  /** Angle at the start of the in-progress tilt (GravityState.turnStartAngle) — only meaningful during Aiming. */
  gravityTurnStartAngle?: number | undefined;
  /** Max absolute tilt allowed from gravityTurnStartAngle (GravityState.maxTiltDelta) — only meaningful during Aiming. */
  gravityMaxTiltDelta?: number | undefined;
  /** No committable tilt exists yet on the staged drop — hint and compass ring pulse for attention. */
  needsTilt?: boolean;
  /** The current rotation may be committed. It is not necessarily the tutorial's required answer. */
  canConfirmTilt?: boolean;
  isStackMode?: boolean;
  currentStack?: number;
  bestStack?: number;
  lastStackScore?: {
    initial: number;
    chains: ReadonlyArray<{ level: number; cleared: number }>;
    stack: number;
    points: number;
  } | null;
}

// gravity.ts's angle convention (0 = down, increasing = counterclockwise on
// screen — see computeGravityVector) to the angle convention used below for
// arc math (0 = positive X axis/right, increasing = clockwise on screen,
// matching e.g. canvas ctx.arc or SVG's sweep-flag=1).
function dialAngleRad(gravityAngleDeg: number): number {
  return ((90 - gravityAngleDeg) * Math.PI) / 180;
}

/** Semantic gameplay status displayed as a DOM overlay over the board canvas. */
export class GameHud {
  readonly root: HTMLElement;
  private readonly score: HTMLElement;
  private readonly level: HTMLElement;
  private readonly turns: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly stackReceipt: HTMLElement;
  private readonly stackReceiptTotal: HTMLElement;
  private readonly stackReceiptBreakdown: HTMLElement;
  private readonly current: HTMLElement;
  private readonly next: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly gravity: HTMLElement;
  private readonly gravitySr: HTMLElement;
  private readonly gravityArc: SVGPathElement;
  private readonly gravityArrow: SVGLineElement;
  private readonly gravityArrowhead: SVGPolygonElement;

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
    this.stack = this.makeValue('Stack', 'game-hud__stack');
    summary.append(this.score, this.stack, this.turns, this.level);

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
    const dial = document.createElementNS(SVG_NS, 'svg');
    dial.setAttribute('class', 'game-hud__gravity-dial');
    dial.setAttribute('viewBox', '0 0 80 80');
    dial.setAttribute('aria-hidden', 'true');

    const backdrop = document.createElementNS(SVG_NS, 'circle');
    backdrop.setAttribute('cx', String(DIAL_CX));
    backdrop.setAttribute('cy', String(DIAL_CY));
    backdrop.setAttribute('r', String(DIAL_BACKDROP_R));
    backdrop.setAttribute('fill', 'rgba(15, 23, 42, 0.82)');
    backdrop.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    backdrop.setAttribute('stroke-width', '1.5');

    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', String(DIAL_CX));
    ring.setAttribute('cy', String(DIAL_CY));
    ring.setAttribute('r', String(DIAL_RING_R));
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', COLOR_TEXT_DIM);
    ring.setAttribute('stroke-width', '1');

    this.gravityArc = document.createElementNS(SVG_NS, 'path');
    this.gravityArc.setAttribute('fill', 'none');
    this.gravityArc.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    this.gravityArc.setAttribute('stroke-width', '4');
    this.gravityArc.setAttribute('stroke-linecap', 'round');
    this.gravityArc.setAttribute('opacity', '0.55');

    this.gravityArrow = document.createElementNS(SVG_NS, 'line');
    this.gravityArrow.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    this.gravityArrow.setAttribute('stroke-width', '4');
    this.gravityArrow.setAttribute('stroke-linecap', 'round');

    this.gravityArrowhead = document.createElementNS(SVG_NS, 'polygon');
    this.gravityArrowhead.setAttribute('fill', COLOR_GRAVITY_ACCENT);

    // Attention ring: outside the backdrop so it's never obscured by it, on
    // a dedicated class so tests and CSS never depend on circle order. Only
    // visible while a tilt is owed (game-hud__gravity--attention, CSS-driven).
    const attentionRing = document.createElementNS(SVG_NS, 'circle');
    attentionRing.setAttribute('class', 'game-hud__gravity-attention-ring');
    attentionRing.setAttribute('cx', String(DIAL_CX));
    attentionRing.setAttribute('cy', String(DIAL_CY));
    attentionRing.setAttribute('r', String(DIAL_ATTENTION_R));
    attentionRing.setAttribute('fill', 'none');
    attentionRing.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    attentionRing.setAttribute('stroke-width', '2.5');

    dial.append(attentionRing, backdrop, this.gravityArc, ring, this.gravityArrow, this.gravityArrowhead);

    this.gravitySr = document.createElement('span');
    this.gravitySr.className = 'game-hud__gravity-sr';
    this.gravitySr.setAttribute('aria-live', 'polite');

    this.gravity.append(dial, this.gravitySr);
    this.hint = document.createElement('p');
    this.hint.className = 'game-hud__hint';

    const status = document.createElement('div');
    status.className = 'game-hud__status';
    this.stackReceipt = document.createElement('p');
    this.stackReceipt.className = 'game-hud__stack-receipt';
    this.stackReceiptTotal = document.createElement('span');
    this.stackReceiptTotal.className = 'game-hud__stack-receipt-total';
    this.stackReceiptBreakdown = document.createElement('span');
    this.stackReceiptBreakdown.className = 'game-hud__stack-receipt-breakdown';
    this.stackReceipt.append(this.stackReceiptTotal, this.stackReceiptBreakdown);
    status.append(this.stackReceipt, this.hint);

    top.append(this.gravity);
    bottom.append(queue, status);
    this.root.append(top, bottom);
    (container ?? document.querySelector<HTMLElement>('.game-stage') ?? document.body).append(this.root);
  }

  render(state: GameHudState): void {
    this.root.hidden = state.phase === GamePhase.Menu;
    this.root.dataset.phase = state.phase;
    this.root.dataset.stackMode = String(Boolean(state.isStackMode));
    this.score.textContent = state.score.toLocaleString('en-US');
    this.level.textContent = `Level ${state.level}`;
    if (state.isStackMode) {
      this.stack.textContent = `Stack ${state.currentStack ?? 0} / Best ${state.bestStack ?? 0}`;
      this.stack.hidden = false;
      const receipt = state.lastStackScore;
      if (receipt) {
        this.stackReceiptTotal.textContent = `Last stack: ${receipt.stack} cleared · +${receipt.points.toLocaleString('en-US')}`;
        this.stackReceiptBreakdown.textContent = receipt.chains.length === 0
          ? `${receipt.initial} initial · no chain`
          : `${receipt.initial} initial + ${receipt.chains.map((batch, index) => {
            const label = receipt.chains.length === 1 || index === 0
              ? `chain ${batch.level}`
              : `C${batch.level}`;
            return `${batch.cleared} on ${label}`;
          }).join(' + ')}`;
        this.stackReceipt.hidden = false;
      } else {
        this.stackReceiptTotal.textContent = '';
        this.stackReceiptBreakdown.textContent = '';
        this.stackReceipt.hidden = true;
      }
    } else {
      this.stack.textContent = '';
      this.stack.hidden = true;
      this.stackReceiptTotal.textContent = '';
      this.stackReceiptBreakdown.textContent = '';
      this.stackReceipt.hidden = true;
    }
    const turnsRemaining = Math.max(0, state.turnsRemaining);
    const turnsTotal = Math.max(0, state.turnsPerLevel);
    const turnsScale = Math.max(turnsTotal, state.initialTurnsPerLevel);
    const pipCapacity = Math.max(turnsScale, Math.floor(state.turnPipCapacity ?? turnsScale));
    this.turns.replaceChildren();
    this.turns.append(`Turn ${turnsRemaining} / ${turnsTotal}`);
    const pips = document.createElement('span');
    pips.className = 'game-hud__pips';
    pips.setAttribute('aria-hidden', 'true');
    pips.style.gridTemplateColumns = `repeat(${pipCapacity}, minmax(0, 1fr))`;
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
      const angle = state.gravityAngle ?? 0;
      this.gravitySr.textContent = `Gravity ${gravityDirection(angle)}`;
      this.gravity.hidden = false;
      this.renderGravityDial(state, angle);
    } else {
      this.gravitySr.textContent = '';
      this.gravity.hidden = true;
    }
    // Same defensive guard as GameControls: an inconsistent caller must not
    // pulse attention cues outside a gravity Aiming phase.
    const attention = state.phase === GamePhase.Aiming && state.hasGravity && Boolean(state.needsTilt);
    const confirmReady = state.phase === GamePhase.Aiming && state.hasGravity
      && state.canConfirmTilt === true && !attention;
    this.gravity.classList.toggle('game-hud__gravity--attention', attention);
    this.hint.classList.toggle('game-hud__hint--attention', attention);
    this.hint.classList.toggle('game-hud__hint--ready', confirmReady);
    this.hint.textContent = hintFor(state, attention, confirmReady);
  }

  destroy(): void {
    this.root.remove();
  }

  // Always-visible arrow showing the current gravity direction; during
  // Aiming, also draws a faint arc showing how far the player may still
  // tilt from the turn's starting angle.
  private renderGravityDial(state: GameHudState, angle: number): void {
    const { gx, gy } = computeGravityVector(angle);
    const tipX = DIAL_CX + gx * DIAL_RING_R * 0.82;
    const tipY = DIAL_CY + gy * DIAL_RING_R * 0.82;
    this.gravityArrow.setAttribute('x1', String(DIAL_CX));
    this.gravityArrow.setAttribute('y1', String(DIAL_CY));
    this.gravityArrow.setAttribute('x2', String(tipX));
    this.gravityArrow.setAttribute('y2', String(tipY));

    const headAngle = Math.atan2(gy, gx);
    const headLen = 9;
    const leftX = tipX - headLen * Math.cos(headAngle - Math.PI / 6);
    const leftY = tipY - headLen * Math.sin(headAngle - Math.PI / 6);
    const rightX = tipX - headLen * Math.cos(headAngle + Math.PI / 6);
    const rightY = tipY - headLen * Math.sin(headAngle + Math.PI / 6);
    this.gravityArrowhead.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);

    if (state.phase === GamePhase.Aiming && state.gravityMaxTiltDelta !== undefined) {
      const start = state.gravityTurnStartAngle ?? angle;
      const delta = state.gravityMaxTiltDelta;
      const a1 = dialAngleRad(start - delta);
      const a2 = dialAngleRad(start + delta);
      const startAngle = Math.min(a1, a2);
      const endAngle = Math.max(a1, a2);
      const x1 = DIAL_CX + DIAL_ARC_R * Math.cos(startAngle);
      const y1 = DIAL_CY + DIAL_ARC_R * Math.sin(startAngle);
      const x2 = DIAL_CX + DIAL_ARC_R * Math.cos(endAngle);
      const y2 = DIAL_CY + DIAL_ARC_R * Math.sin(endAngle);
      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
      this.gravityArc.setAttribute('d', `M ${x1} ${y1} A ${DIAL_ARC_R} ${DIAL_ARC_R} 0 ${largeArc} 1 ${x2} ${y2}`);
      this.gravityArc.style.display = '';
    } else {
      this.gravityArc.style.display = 'none';
    }
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
    if (disc.kind === DiscKind.Numbered) {
      discElement.textContent = String(disc.value);
    } else {
      discElement.append(this.makeCrack('primary'));
      if (disc.kind === DiscKind.DoubleCracked) discElement.append(this.makeCrack('secondary'));
    }
    discElement.setAttribute('aria-hidden', 'true');
    slot.append(caption, discElement);
  }

  private makeCrack(variant: 'primary' | 'secondary'): HTMLElement {
    const crack = document.createElement('span');
    crack.className = `game-hud__disc-crack game-hud__disc-crack--${variant}`;
    crack.append(document.createElement('i'), document.createElement('i'));
    return crack;
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

// Touch devices already have the on-screen game-controls buttons for every
// action, so their hint stays a short tap prompt. Desktop hides those
// buttons (see the pointer:fine media query), so its hint spells out the
// keyboard shortcuts instead.
function hintFor(state: GameHudState, needsTilt = false, confirmReady = false): string {
  if (state.phase === GamePhase.Animating) return 'Resolving turn';
  const touch = isTouchDevice();
  if (state.phase === GamePhase.Aiming) {
    // Touch keeps its tap copy even while a tilt is owed — the on-screen
    // ↺/↻ buttons already pulse there; desktop has no buttons, so the hint
    // line itself carries the "you must tilt" message.
    if (needsTilt && !touch) return 'Tilt required — Q/E to tilt, then ↓/Enter';
    if (confirmReady) return touch ? 'Rotation set — tap CONFIRM' : 'Rotation set — ↓ / Enter to confirm';
    return touch ? 'Tap ↺/↻ to tilt, CONFIRM to drop' : 'Q/E tilt  ↓ / Enter confirm  Esc cancel';
  }
  if (state.hasGravity) {
    return touch ? 'Tap lane to stage a drop' : '← → choose lane  ↓ stage drop  R restart';
  }
  return touch ? 'Tap column to drop' : '← → move  ↓ / click drop  R restart';
}
