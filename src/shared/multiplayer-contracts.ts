import type { GameOverReason } from './game-values.js';
export type { GameOverReason } from './game-values.js';

/** Stable identities and value contracts shared by multiplayer messages. */
export const MULTIPLAYER_PROTOCOL_VERSION = 3 as const;
export const SCORE_RACE_MODE_ID = 'score-race' as const;
export const SCORE_RACE_MODE_VERSION = 1 as const;
export const SCORE_RACE_RULES_VERSION = 1 as const;
export const SCORE_RACE_DURATION_MS = 3 * 60 * 1_000;

export const SHARED_DUEL_MODE_ID = 'shared-duel' as const;
export const SHARED_DUEL_MODE_VERSION = 1 as const;
export const SHARED_DUEL_RULES_VERSION = 1 as const;
export const SHARED_DUEL_TURN_TIMEOUT_MS = 15_000 as const;
export const SHARED_DUEL_DISRUPTION_THRESHOLD = 3 as const;
/** Runtime board dimensions, test-enforced against the isolated game build. */
export const SHARED_DUEL_BOARD_ROWS = 7 as const;
export const SHARED_DUEL_BOARD_COLS = 7 as const;

export type MultiplayerProtocolVersion = typeof MULTIPLAYER_PROTOCOL_VERSION;

export interface RulesIdentity {
  readonly id: string;
  readonly version: number;
}

/** Identity for the complete multiplayer contract, including its session rules. */
export interface MultiplayerModeIdentity {
  readonly id: string;
  readonly version: number;
  readonly rules: RulesIdentity;
}

export interface MultiplayerProgress {
  readonly sequence: number;
  readonly score: number;
  readonly turnsPlayed: number;
}

export interface MultiplayerPlayerProgress extends MultiplayerProgress {
  readonly playerId: string;
  readonly finished: boolean;
}

export interface MultiplayerPlayerScore {
  readonly playerId: string;
  readonly score: number;
}

/** Canonical result broadcast identically to both players. */
export interface MultiplayerMatchResult {
  readonly winnerId: string | null;
  readonly scores: readonly [MultiplayerPlayerScore, MultiplayerPlayerScore];
  /** Set when this result came from a forfeit rather than a natural finish. */
  readonly forfeitedBy: string | null;
}

/** Result projected relative to the player rendering it. */
export interface MultiplayerLocalResult {
  readonly outcome: 'win' | 'loss' | 'tie';
  readonly localScore: number;
  readonly opponentScore: number;
  readonly forfeitedBy: 'local' | 'opponent' | null;
}

interface ClientMessageBase {
  readonly protocolVersion: MultiplayerProtocolVersion;
  readonly roomId: string;
  readonly playerId: string;
}

export type MultiplayerClientMessage =
  | (ClientMessageBase & {
      readonly type: 'set-ready';
      readonly ready: boolean;
    })
  | (ClientMessageBase & {
      readonly type: 'publish-progress';
      readonly matchId: string;
      readonly progress: MultiplayerProgress;
    })
  | (ClientMessageBase & {
      readonly type: 'finish-match';
      readonly matchId: string;
      readonly progress: MultiplayerProgress;
    })
  | (ClientMessageBase & {
      readonly type: 'resume-session';
      readonly matchId: string | null;
      readonly lastProgressSequence: number;
    })
  | (ClientMessageBase & {
      readonly type: 'play-turn';
      readonly matchId: string;
      readonly column: number;
    })
  | (ClientMessageBase & {
      readonly type: 'move-cursor';
      readonly matchId: string;
      readonly column: number;
    })
  | (ClientMessageBase & {
      readonly type: 'set-paused';
      readonly matchId: string;
      readonly paused: boolean;
    })
  | (ClientMessageBase & {
      readonly type: 'forfeit-match';
      readonly matchId: string;
    });

interface ServerMessageBase {
  readonly protocolVersion: MultiplayerProtocolVersion;
  readonly roomId: string;
  readonly mode: MultiplayerModeIdentity;
}

export type MultiplayerServerMessage =
  | (ServerMessageBase & {
      readonly type: 'room-state';
      readonly localReady: boolean;
      readonly opponentReady: boolean;
    })
  | (ServerMessageBase & {
      readonly type: 'match-countdown';
      readonly matchId: string;
      readonly startsAt: number;
      readonly deadline: number;
      readonly seed: number;
    })
  | (ServerMessageBase & {
      readonly type: 'opponent-progress';
      readonly matchId: string;
      readonly progress: MultiplayerPlayerProgress;
    })
  | (ServerMessageBase & {
      readonly type: 'match-finished';
      readonly matchId: string;
      readonly result: MultiplayerMatchResult;
    })
  | (ServerMessageBase & {
      readonly type: 'turn-assigned';
      readonly matchId: string;
      readonly playerId: string;
      readonly turnDeadline: number;
      readonly board: WireBoard;
      readonly currentDisc: WireDisc;
      readonly nextDisc: WireDisc;
      readonly level: number;
      readonly turnsPerLevel: number;
      readonly turnsRemaining: number;
      readonly revision: number;
    })
  | (ServerMessageBase & {
      readonly type: 'turn-played';
      readonly matchId: string;
      readonly board: WireBoard;
      readonly turnResult: TurnResultWire;
      readonly nextPlayerId: string;
      readonly currentDisc: WireDisc;
      readonly nextDisc: WireDisc;
      readonly level: number;
      readonly turnsPerLevel: number;
      readonly turnsRemaining: number;
      readonly revision: number;
    })
  | (ServerMessageBase & {
      readonly type: 'turn-expired';
      readonly matchId: string;
      readonly board: WireBoard;
      readonly turnResult: TurnResultWire;
      readonly nextPlayerId: string;
      readonly currentDisc: WireDisc;
      readonly nextDisc: WireDisc;
      readonly level: number;
      readonly turnsPerLevel: number;
      readonly turnsRemaining: number;
      readonly revision: number;
    })
  | (ServerMessageBase & {
      readonly type: 'opponent-cursor';
      readonly matchId: string;
      readonly playerId: string;
      readonly column: number;
    })
  | (ServerMessageBase & {
      readonly type: 'match-paused';
      readonly matchId: string;
      readonly paused: boolean;
      readonly pausedBy: string;
      /**
       * The authoritative match/turn deadline at the moment of this event —
       * unchanged on pause, shifted forward by the paused duration on
       * resume. Lets clients resync their locally cached deadline exactly
       * instead of replicating the elapsed-time math themselves.
       */
      readonly deadline: number;
    })
  | (ServerMessageBase & {
      readonly type: 'duel-status';
      readonly matchId: string;
      /** Monotonically increases after every accepted turn or timeout resolution. Unchanged by cursor moves. */
      readonly revision: number;
      /** API clock reading at the instant this status was built — pairs with turnDeadline to compute a local deadline immune to client/server clock skew. */
      readonly serverTime: number;
      readonly activePlayerId: string;
      readonly turnDeadline: number;
      /** The active player's currently stored column selection. */
      readonly activeColumn: number;
      readonly paused: boolean;
      /** Non-null exactly when paused is true. */
      readonly pausedBy: string | null;
      readonly scores: readonly [MultiplayerPlayerScore, MultiplayerPlayerScore];
      readonly board: WireBoard;
      readonly currentDisc: WireDisc;
      readonly nextDisc: WireDisc;
      readonly level: number;
      readonly turnsPerLevel: number;
      readonly turnsRemaining: number;
    });

export type MultiplayerConnectionState = 'connected' | 'disconnected' | 'reconnecting';

/** Runtime-validatable room-service failure codes shared with the browser. */
export const ROOM_SERVICE_ERRORS = [
  'protocol-mismatch',
  'mode-mismatch',
  'room-not-found',
  'room-full',
  'invalid-credential',
  'stale-connection',
  'invalid-state',
  'match-mismatch',
  'stale-progress',
  'conflicting-progress',
  'non-monotonic-progress',
] as const;
export type RoomServiceErrorCode = (typeof ROOM_SERVICE_ERRORS)[number];

/** Room-service failures plus the browser transport's wire-parse failure. */
export const MULTIPLAYER_TRANSPORT_ERRORS = [...ROOM_SERVICE_ERRORS, 'invalid-message'] as const;
export type MultiplayerTransportErrorCode = (typeof MULTIPLAYER_TRANSPORT_ERRORS)[number];
const MULTIPLAYER_TRANSPORT_ERROR_SET: ReadonlySet<string> = new Set(MULTIPLAYER_TRANSPORT_ERRORS);
export function isMultiplayerTransportErrorCode(
  value: unknown,
): value is MultiplayerTransportErrorCode {
  return typeof value === 'string' && MULTIPLAYER_TRANSPORT_ERROR_SET.has(value);
}

/** Mirrors src/game/model.ts's DiscKind enum values, declared independently since src/shared must not import from src/game. */
export const WIRE_DISC_KINDS = ['numbered', 'single-cracked', 'double-cracked'] as const;
export type WireDiscKind = (typeof WIRE_DISC_KINDS)[number];
const WIRE_DISC_KIND_SET: ReadonlySet<string> = new Set(WIRE_DISC_KINDS);
export function isWireDiscKind(value: unknown): value is WireDiscKind {
  return typeof value === 'string' && WIRE_DISC_KIND_SET.has(value);
}

/** Mirrors src/game/model.ts's EntryEdge. */
export const WIRE_ENTRY_EDGES = ['top', 'right', 'bottom', 'left'] as const;
export type WireEntryEdge = (typeof WIRE_ENTRY_EDGES)[number];
const WIRE_ENTRY_EDGE_SET: ReadonlySet<string> = new Set(WIRE_ENTRY_EDGES);
export function isWireEntryEdge(value: unknown): value is WireEntryEdge {
  return typeof value === 'string' && WIRE_ENTRY_EDGE_SET.has(value);
}

/** Mirrors src/game/events.ts's BonusKind. */
export const WIRE_BONUS_KINDS = ['level', 'board-clear', 'stack'] as const;
export type WireBonusKind = (typeof WIRE_BONUS_KINDS)[number];
const WIRE_BONUS_KIND_SET: ReadonlySet<string> = new Set(WIRE_BONUS_KINDS);
export function isWireBonusKind(value: unknown): value is WireBonusKind {
  return typeof value === 'string' && WIRE_BONUS_KIND_SET.has(value);
}

export interface WireGridPos {
  readonly row: number;
  readonly col: number;
}

export interface WireDisc {
  readonly id: number;
  readonly value: number;
  readonly kind: WireDiscKind;
  readonly ownerId?: string;
}

export type WireCell = WireDisc | null;
export type WireBoard = WireCell[][];

export interface WireDropStep {
  readonly kind: 'drop';
  readonly disc: WireDisc;
  readonly entryPos: WireGridPos;
  readonly landPos: WireGridPos;
}

export interface WireClearStep {
  readonly kind: 'clear';
  readonly cleared: WireGridPos[];
  readonly discs: WireDisc[];
  readonly chainLevel: number;
  readonly pointsAwarded: number;
}

export interface WireFallMove {
  readonly from: WireGridPos;
  readonly to: WireGridPos;
  readonly disc: WireDisc;
}

export interface WireFallStep {
  readonly kind: 'fall';
  readonly moves: WireFallMove[];
}

export interface WireRevealStep {
  readonly kind: 'reveal';
  readonly positions: WireGridPos[];
  readonly discs: WireDisc[];
}

export interface WirePushStep {
  readonly kind: 'push';
  readonly edge: WireEntryEdge;
  readonly newDiscs: WireDisc[];
}

export interface WireBonusStep {
  readonly kind: 'bonus';
  readonly bonusKind: WireBonusKind;
  readonly pointsAwarded: number;
}

export type WireStep =
  | WireDropStep
  | WireClearStep
  | WireFallStep
  | WireRevealStep
  | WirePushStep
  | WireBonusStep;

export interface TurnResultWire {
  readonly playerId: string;
  /** Null when no drop occurred — the turn timer expired with no non-full column left. */
  readonly column: number | null;
  readonly triggerScoreDelta: number;
  readonly opponentScoreDelta: number;
  readonly stackSize: number;
  readonly steps: readonly WireStep[];
  readonly gameOver: boolean;
  readonly gameOverReason?: GameOverReason;
}

export function rulesIdentity(value: RulesIdentity): RulesIdentity {
  return { id: value.id, version: value.version };
}

export function multiplayerModeIdentity(
  value: Pick<MultiplayerModeIdentity, 'id' | 'version' | 'rules'>,
): MultiplayerModeIdentity {
  return {
    id: value.id,
    version: value.version,
    rules: rulesIdentity(value.rules),
  };
}

export function sameRulesIdentity(left: RulesIdentity, right: RulesIdentity): boolean {
  return left.id === right.id && left.version === right.version;
}

export function sameMultiplayerModeIdentity(
  left: MultiplayerModeIdentity,
  right: MultiplayerModeIdentity,
): boolean {
  return left.id === right.id
    && left.version === right.version
    && sameRulesIdentity(left.rules, right.rules);
}

export function determineScoreRaceResult(
  firstPlayerId: string,
  firstScore: number,
  secondPlayerId: string,
  secondScore: number,
): MultiplayerMatchResult {
  const winnerId = firstScore === secondScore
    ? null
    : firstScore > secondScore ? firstPlayerId : secondPlayerId;
  return {
    winnerId,
    scores: [
      { playerId: firstPlayerId, score: firstScore },
      { playerId: secondPlayerId, score: secondScore },
    ],
    forfeitedBy: null,
  };
}

export function localizeMultiplayerResult(
  result: MultiplayerMatchResult,
  localPlayerId: string,
): MultiplayerLocalResult | null {
  const local = result.scores.find(score => score.playerId === localPlayerId);
  const opponent = result.scores.find(score => score.playerId !== localPlayerId);
  if (!local || !opponent) return null;
  return {
    outcome: result.winnerId === null
      ? 'tie'
      : result.winnerId === localPlayerId ? 'win' : 'loss',
    localScore: local.score,
    opponentScore: opponent.score,
    forfeitedBy: result.forfeitedBy === null
      ? null
      : result.forfeitedBy === localPlayerId ? 'local' : 'opponent',
  };
}
