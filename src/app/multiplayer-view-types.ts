/**
 * Canonical frontend session/view state for multiplayer play.
 *
 * These describe the browser's own session lifecycle and connection state,
 * not a value that crosses the wire — `disconnected` and `reconnecting` in
 * particular are pure client-side connection states with no server message
 * counterpart. They must not be added to
 * src/shared/multiplayer-contracts.ts, which is reserved for values that
 * actually cross the browser/API boundary.
 *
 * Score Race's MultiplayerSessionController and Disco Duel's
 * SharedBoardSessionController both project this same phase shape, as do
 * the mode-agnostic MultiplayerRoomOverlay and the per-mode HUDs. All of
 * them import from here (via local aliases where a component-specific name
 * improves its public API) rather than redeclaring the union.
 */
export type MultiplayerPhase =
  | 'lobby'
  | 'ready'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'disconnected'
  | 'reconnecting';

/**
 * Canonical frontend classification of why a multiplayer session became
 * unusable. Each session controller is the single choke point that assigns
 * one of these (see failCompatibility in multiplayer-session-controller.ts
 * and #failCompatibility in shared-board-session-controller.ts) — UI only
 * ever renders the category, never the raw offending payload, which is
 * logged to the console at that same choke point.
 */
export type MultiplayerCompatibilityError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'rules-mismatch'
  | 'session-mismatch';
