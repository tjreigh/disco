import type { Disc } from '../game/model.js';
import { DiscKind } from '../game/model.js';
import { GamePhase } from '../game/state.js';
import { computeGravityVector } from '../game/gravity/settling.js';
import { COLOR_GRAVITY_ACCENT, COLOR_TEXT_DIM } from './rendering/theme.js';
import { cloneTemplate, isTouchDevice, mustQuery } from './dom-utils.js';

const DIAL_CX = 40;
const DIAL_CY = 40;
const DIAL_RING_R = 26;
const DIAL_ARC_R = 38;

export interface GameHudState {
  phase: GamePhase;
  score: number;
  highScore?: number;
  bestRecord?: number;
  currentDisc: Disc;
  nextDisc: Disc;
  level: number;
  initialTurnsPerLevel: number;
  turnsPerLevel: number;
  turnsRemaining: number;
  /** Opt-in live run metrics. Omit when the Advanced HUD setting is disabled. */
  advancedStats?: {
    playTimeMs: number;
    discsDropped: number;
    discsBroken: number;
  };
  /** Shared full-width pip capacity; modes with fewer turns occupy the leftmost slots. */
  turnPipCapacity?: number;
  hasGravity: boolean;
  hasRewind?: boolean;
  isRewindPreview?: boolean;
  instability?: number | undefined;
  criticalInstability?: number | undefined;
  /** Turn pips consumed by the next accepted move in rewind modes. */
  turnCost?: number | undefined;
  /** Whether the generic solo restart shortcut should be advertised. */
  hasRestart?: boolean;
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
  stackCascadeActive?: boolean;
  lastStackScore?: {
    initial: number;
    chains: ReadonlyArray<{ level: number; cleared: number }>;
    stack: number;
    points: number;
  } | null;
}

interface ControlHint {
  controls: string;
  action: string;
}

// gravity/settling.ts's angle convention (0 = down, increasing = counterclockwise on
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
  private readonly turnsLabel: HTMLElement;
  private readonly turnPips: HTMLElement;
  private readonly records: HTMLElement;
  private readonly advanced: HTMLElement;
  private readonly advancedTime: HTMLTimeElement;
  private readonly advancedDrops: HTMLElement;
  private readonly advancedBroken: HTMLElement;
  private readonly stackReceipt: HTMLElement;
  private readonly stackReceiptTotal: HTMLElement;
  private readonly stackReceiptBreakdown: HTMLElement;
  private readonly current: HTMLElement;
  private readonly next: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly gravity: HTMLElement;
  private readonly instability: HTMLElement;
  private readonly instabilityValue: HTMLElement;
  private readonly pressure: HTMLElement;
  private readonly gravitySr: HTMLElement;
  private readonly gravityArc: SVGPathElement;
  private readonly gravityArrow: SVGLineElement;
  private readonly gravityArrowhead: SVGPolygonElement;
  private turnsRenderKey = '';
  private currentDiscRenderKey = '';
  private nextDiscRenderKey = '';
  private hintRenderKey = '';
  private advancedRenderKey = '';

  constructor(container?: HTMLElement | null) {
    const fragment = cloneTemplate('tpl-game-hud');
    this.root = mustQuery(fragment, '.game-hud');
    this.score = mustQuery(fragment, '.game-hud__score');
    this.level = mustQuery(fragment, '.game-hud__level');
    this.turns = mustQuery(fragment, '.game-hud__turns');
    this.turnsLabel = mustQuery(fragment, '[data-ui-ref="turns-label"]');
    this.turnPips = mustQuery(fragment, '.game-hud__pips');
    this.records = mustQuery(fragment, '.game-hud__records');
    this.advanced = mustQuery(fragment, '.game-hud__advanced');
    this.advancedTime = mustQuery(fragment, '[data-advanced-stat="time"]');
    this.advancedDrops = mustQuery(fragment, '[data-advanced-stat="drops"]');
    this.advancedBroken = mustQuery(fragment, '[data-advanced-stat="broken"]');
    this.current = mustQuery(fragment, '.game-hud__disc-slot[aria-label="Current disc"]');
    this.next = mustQuery(fragment, '.game-hud__disc-slot[aria-label="Next disc"]');
    this.gravity = mustQuery(fragment, '.game-hud__gravity');
    this.gravitySr = mustQuery(fragment, '.game-hud__gravity-sr');
    // Attention ring: outside the backdrop so it's never obscured by it, on
    // a dedicated class so tests and CSS never depend on circle order. Only
    // visible while a tilt is owed (game-hud__gravity--attention, CSS-driven).
    const attentionRing = mustQuery<SVGCircleElement>(fragment, '.game-hud__gravity-attention-ring');
    const backdrop = mustQuery<SVGCircleElement>(fragment, '[data-ui-ref="gravity-backdrop"]');
    this.gravityArc = mustQuery<SVGPathElement>(fragment, '[data-ui-ref="gravity-arc"]');
    const ring = mustQuery<SVGCircleElement>(fragment, '[data-ui-ref="gravity-ring"]');
    this.gravityArrow = mustQuery<SVGLineElement>(fragment, '[data-ui-ref="gravity-arrow"]');
    this.gravityArrowhead = mustQuery<SVGPolygonElement>(fragment, '[data-ui-ref="gravity-arrowhead"]');
    this.instability = mustQuery(fragment, '.game-hud__instability');
    this.instabilityValue = mustQuery(fragment, '.game-hud__instability-value');
    this.pressure = mustQuery(fragment, '.game-hud__pressure');
    this.hint = mustQuery(fragment, '.game-hud__hint');
    this.stackReceipt = mustQuery(fragment, '.game-hud__stack-receipt');
    this.stackReceiptTotal = mustQuery(fragment, '.game-hud__stack-receipt-total');
    this.stackReceiptBreakdown = mustQuery(fragment, '.game-hud__stack-receipt-breakdown');

    // Geometry/opacity/etc. are static in the template; only the theme
    // colors — sourced from rendering/theme.ts, not literal hex in markup —
    // stay imperative, set once here.
    attentionRing.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    backdrop.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    this.gravityArc.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    ring.setAttribute('stroke', COLOR_TEXT_DIM);
    this.gravityArrow.setAttribute('stroke', COLOR_GRAVITY_ACCENT);
    this.gravityArrowhead.setAttribute('fill', COLOR_GRAVITY_ACCENT);

    (container ?? document.querySelector<HTMLElement>('.game-stage') ?? document.body).append(fragment);
  }

  render(state: GameHudState): void {
    this.root.hidden = state.phase === GamePhase.Menu;
    this.root.dataset.phase = state.phase;
    this.root.dataset.stackMode = String(Boolean(state.isStackMode));
    this.root.dataset.rewindMode = String(Boolean(state.hasRewind));
    this.root.dataset.rewindPreview = String(Boolean(state.isRewindPreview));
    this.score.textContent = state.score.toLocaleString('en-US');
    this.level.textContent = `Level ${state.level}`;
    const highScoreValue = state.highScore ?? 0;
    const bestRecordValue = state.bestRecord ?? 0;
    const highScore = highScoreValue.toLocaleString('en-US');
    const bestRecord = bestRecordValue.toLocaleString('en-US');
    this.records.textContent = state.isStackMode
      ? `High ${highScore} · Best turn ${bestRecord} cleared`
      : `High ${highScore} · Best chain ${bestRecord} wave${bestRecordValue === 1 ? '' : 's'}`;
    this.renderAdvancedStats(state.advancedStats);
    if (state.isStackMode) {
      const receipt = state.lastStackScore;
      if (state.stackCascadeActive && (state.currentStack ?? 0) > 0) {
        this.stackReceiptTotal.textContent = `This turn: ${state.currentStack} cleared so far`;
        this.stackReceiptBreakdown.textContent = 'Clear waves combine into one total';
        this.stackReceipt.hidden = false;
      } else if (receipt) {
        this.stackReceiptTotal.textContent = `Last turn: ${receipt.stack} total cleared · +${receipt.points.toLocaleString('en-US')}`;
        this.stackReceiptBreakdown.textContent = receipt.chains.length === 0
          ? `1 clear wave · ${receipt.initial} cleared together`
          : `${receipt.chains.length + 1} clear waves · ${[receipt.initial, ...receipt.chains.map(batch => batch.cleared)].join(' + ')}`;
        this.stackReceipt.hidden = false;
      } else {
        this.stackReceiptTotal.textContent = '';
        this.stackReceiptBreakdown.textContent = '';
        this.stackReceipt.hidden = true;
      }
    } else {
      this.stackReceiptTotal.textContent = '';
      this.stackReceiptBreakdown.textContent = '';
      this.stackReceipt.hidden = true;
    }
    const turnsRemaining = Math.max(0, state.turnsRemaining);
    const turnsTotal = Math.max(0, state.turnsPerLevel);
    const turnsScale = Math.max(turnsTotal, state.initialTurnsPerLevel);
    const pipCapacity = Math.max(turnsScale, Math.floor(state.turnPipCapacity ?? turnsScale));
    const turnsRenderKey = `${turnsRemaining}:${turnsTotal}:${turnsScale}:${pipCapacity}`;
    if (turnsRenderKey !== this.turnsRenderKey) {
      this.turnsRenderKey = turnsRenderKey;
      this.turnsLabel.textContent = `Turn ${turnsRemaining} / ${turnsTotal}`;
      this.turnPips.replaceChildren();
      this.turnPips.style.gridTemplateColumns = `repeat(${pipCapacity}, minmax(0, 1fr))`;
      for (let index = 0; index < turnsTotal; index++) {
        const pip = document.createElement('i');
        pip.className = `game-hud__pip${index < turnsRemaining ? ' game-hud__pip--remaining' : ''}`;
        this.turnPips.append(pip);
      }
      for (let index = turnsTotal; index < turnsScale; index++) {
        const pip = document.createElement('i');
        pip.className = 'game-hud__pip game-hud__pip--placeholder';
        this.turnPips.append(pip);
      }
    }
    const currentDiscRenderKey = `${state.currentDisc.id}:${state.currentDisc.kind}:${state.currentDisc.value}`;
    if (currentDiscRenderKey !== this.currentDiscRenderKey) {
      this.currentDiscRenderKey = currentDiscRenderKey;
      this.renderDisc(this.current, state.currentDisc, 'Current disc');
    }
    const nextDiscRenderKey = `${state.nextDisc.id}:${state.nextDisc.kind}:${state.nextDisc.value}`;
    if (nextDiscRenderKey !== this.nextDiscRenderKey) {
      this.nextDiscRenderKey = nextDiscRenderKey;
      this.renderDisc(this.next, state.nextDisc, 'Next disc');
    }

    if (state.hasGravity) {
      const angle = state.gravityAngle ?? 0;
      this.gravitySr.textContent = `Gravity ${gravityDirection(angle)}`;
      this.gravity.hidden = false;
      this.renderGravityDial(state, angle);
    } else {
      this.gravitySr.textContent = '';
      this.gravity.hidden = true;
    }
    if (state.hasRewind) {
      const instability = state.instability ?? 0;
      const turnCost = Math.max(1, state.turnCost ?? 1);
      this.instabilityValue.textContent = `INSTABILITY ${instability}`;
      this.pressure.textContent = `PRESSURE ×${turnCost}`;
      this.instability.setAttribute(
        'aria-label',
        `Timeline instability ${instability}. Each move consumes ${turnCost} turn ${turnCost === 1 ? 'pip' : 'pips'}.`,
      );
      this.instability.dataset.turnCost = String(turnCost);
      this.instability.classList.toggle('game-hud__instability--pressured', turnCost > 1);
      this.instability.classList.toggle(
        'game-hud__instability--critical',
        instability >= (state.criticalInstability ?? Number.POSITIVE_INFINITY),
      );
      this.instability.hidden = false;
    } else {
      this.instabilityValue.textContent = '';
      this.pressure.textContent = '';
      this.instability.hidden = true;
      delete this.instability.dataset.turnCost;
      this.instability.classList.remove('game-hud__instability--pressured');
      this.instability.classList.remove('game-hud__instability--critical');
    }
    // Same defensive guard as GameControls: an inconsistent caller must not
    // pulse attention cues outside a gravity Aiming phase.
    const attention = state.phase === GamePhase.Aiming && state.hasGravity && Boolean(state.needsTilt);
    const confirmReady = state.phase === GamePhase.Aiming && state.hasGravity
      && state.canConfirmTilt === true && !attention;
    this.gravity.classList.toggle('game-hud__gravity--attention', attention);
    this.hint.classList.toggle('game-hud__hint--attention', attention);
    this.hint.classList.toggle('game-hud__hint--ready', confirmReady);
    this.renderHint(state, attention, confirmReady);
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

  private renderAdvancedStats(stats: GameHudState['advancedStats']): void {
    this.root.dataset.advancedHud = String(Boolean(stats));
    if (!stats) {
      this.advanced.hidden = true;
      this.advancedTime.textContent = '';
      this.advancedTime.removeAttribute('datetime');
      this.advancedDrops.textContent = '';
      this.advancedBroken.textContent = '';
      this.advancedRenderKey = '';
      return;
    }

    const totalSeconds = Math.max(0, Math.floor(stats.playTimeMs / 1_000));
    const discsDropped = Math.max(0, Math.floor(stats.discsDropped));
    const discsBroken = Math.max(0, Math.floor(stats.discsBroken));
    const renderKey = `${totalSeconds}:${discsDropped}:${discsBroken}`;
    if (renderKey === this.advancedRenderKey) return;
    this.advancedRenderKey = renderKey;
    this.advancedTime.textContent = formatPlayTime(totalSeconds);
    this.advancedTime.dateTime = `PT${totalSeconds}S`;
    this.advancedTime.setAttribute('aria-label', `Active play time ${accessiblePlayTime(totalSeconds)}`);
    this.advancedDrops.textContent = discsDropped.toLocaleString('en-US');
    this.advancedBroken.textContent = discsBroken.toLocaleString('en-US');
    this.advanced.hidden = false;
  }

  private makeCrack(variant: 'primary' | 'secondary'): HTMLElement {
    const crack = document.createElement('span');
    crack.className = `game-hud__disc-crack game-hud__disc-crack--${variant}`;
    crack.append(document.createElement('i'), document.createElement('i'));
    return crack;
  }

  private renderHint(state: GameHudState, needsTilt: boolean, confirmReady: boolean): void {
    const controls = controlHintsFor(state, needsTilt, confirmReady);
    const text = controls ? '' : hintFor(state, needsTilt, confirmReady);
    const renderKey = controls
      ? `controls:${controls.map((hint) => `${hint.controls}:${hint.action}`).join('|')}`
      : `text:${text}`;
    if (renderKey === this.hintRenderKey) return;

    this.hintRenderKey = renderKey;
    this.hint.replaceChildren();
    this.hint.classList.toggle('game-hud__hint--controls', Boolean(controls));
    if (!controls) {
      this.hint.textContent = text;
      return;
    }

    for (const hint of controls) {
      const group = document.createElement('span');
      group.className = 'game-hud__hint-action';
      group.setAttribute('aria-label', `${hint.controls}: ${hint.action}`);
      const keycap = document.createElement('kbd');
      keycap.textContent = hint.controls;
      keycap.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = hint.action;
      label.setAttribute('aria-hidden', 'true');
      group.append(keycap, label);
      this.hint.append(group);
    }
  }
}

function discLabel(disc: Disc): string {
  return disc.kind === DiscKind.Numbered ? `number ${disc.value}` : disc.kind.replace('-', ' ');
}

function formatPlayTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function accessiblePlayTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
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
function controlHintsFor(
  state: GameHudState,
  needsTilt = false,
  confirmReady = false,
): ControlHint[] | null {
  if (isTouchDevice() || state.phase === GamePhase.Animating) return null;
  if (state.phase === GamePhase.Aiming) {
    if (needsTilt || confirmReady) return null;
    return [
      { controls: 'Q / E', action: 'Tilt' },
      { controls: '↓ / Enter', action: 'Confirm' },
      { controls: 'Esc', action: 'Cancel' },
    ];
  }
  if (state.hasGravity) {
    const hints: ControlHint[] = [
      { controls: '← →', action: 'Choose lane' },
      { controls: '↓', action: 'Stage drop' },
    ];
    if (state.hasRestart !== false) hints.push({ controls: 'R', action: 'New game' });
    return hints;
  }

  const hints: ControlHint[] = [
    { controls: '← →', action: 'Move' },
    { controls: '↓ / Click', action: 'Drop' },
  ];
  if (state.hasRewind) hints.push({ controls: 'Z', action: 'Rewind' });
  if (state.hasRestart !== false) hints.push({ controls: 'R', action: 'New game' });
  return hints;
}

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
  if (state.hasRewind) {
    return touch ? 'Tap column to drop · REWIND undoes one turn' : '← → move  ↓ / click drop  Z rewind  R restart';
  }
  return touch ? 'Tap column to drop' : '← → move  ↓ / click drop  R restart';
}
