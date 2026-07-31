/** Stable identities and value contracts shared by multiplayer messages. */
export const MULTIPLAYER_PROTOCOL_VERSION = 2 as const;
export const SCORE_RACE_MODE_ID = 'score-race' as const;
export const SCORE_RACE_MODE_VERSION = 1 as const;
export const SCORE_RACE_RULES_VERSION = 1 as const;
export const SCORE_RACE_DURATION_MS = 3 * 60 * 1_000;

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
}

/** Result projected relative to the player rendering it. */
export interface MultiplayerLocalResult {
  readonly outcome: 'win' | 'loss' | 'tie';
  readonly localScore: number;
  readonly opponentScore: number;
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
    });

export type MultiplayerConnectionState = 'connected' | 'disconnected' | 'reconnecting';

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
  };
}
