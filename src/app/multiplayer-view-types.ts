/**
 * Browser-only multiplayer phases. Disconnected and reconnecting are view
 * states, not wire-contract values.
 */
export type MultiplayerPhase =
  | 'lobby'
  | 'ready'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'disconnected'
  | 'reconnecting';

/** Browser-facing categories for an unusable multiplayer session. */
export type MultiplayerCompatibilityError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'rules-mismatch'
  | 'session-mismatch';
