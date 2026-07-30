export const MULTIPLAYER_PROTOCOL_VERSION = 1 as const;
export const SCORE_RACE_MODE_ID = 'score-race' as const;
export const SCORE_RACE_RULES_VERSION = 1 as const;

export type MultiplayerProtocolVersion = typeof MULTIPLAYER_PROTOCOL_VERSION;

export interface RulesIdentity {
  readonly id: string;
  readonly version: number;
}

export interface MultiplayerModeIdentity {
  readonly modeId: string;
  readonly rules: RulesIdentity;
}

export interface MultiplayerPlayerProgress {
  readonly playerId: string;
  readonly sequence: number;
  readonly score: number;
  readonly turnsPlayed: number;
  readonly finished: boolean;
}

export interface MultiplayerResult {
  readonly outcome: 'win' | 'loss' | 'tie';
  readonly winnerId: string | null;
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
      readonly progress: MultiplayerPlayerProgress;
    })
  | (ClientMessageBase & {
      readonly type: 'finish-match';
      readonly matchId: string;
      readonly progress: MultiplayerPlayerProgress;
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
      readonly result: MultiplayerResult;
    });

export type MultiplayerConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export function rulesIdentity(value: RulesIdentity): RulesIdentity {
  return { id: value.id, version: value.version };
}

export function sameRulesIdentity(left: RulesIdentity, right: RulesIdentity): boolean {
  return left.id === right.id && left.version === right.version;
}

export function determineScoreRaceResult(
  localPlayerId: string,
  localScore: number,
  opponentPlayerId: string,
  opponentScore: number,
): MultiplayerResult {
  if (localScore === opponentScore) {
    return {
      outcome: 'tie',
      winnerId: null,
      localScore,
      opponentScore,
    };
  }
  const localWon = localScore > opponentScore;
  return {
    outcome: localWon ? 'win' : 'loss',
    winnerId: localWon ? localPlayerId : opponentPlayerId,
    localScore,
    opponentScore,
  };
}
