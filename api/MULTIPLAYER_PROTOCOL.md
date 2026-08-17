# Multiplayer WebSocket protocol

Protocol version: `6`

The protocol separates connection metadata from gameplay data. Frames have
one obvious job: authenticate a socket, send a client `command`, deliver a
server `event`, or report a transport error.

## Connect

The first client frame authenticates the socket:

```json
{
  "protocolVersion": 6,
  "authenticate": {
    "roomId": "ABCD2345",
    "playerId": "player-1",
    "reconnectCredential": "secret"
  }
}
```

Once authenticated, the socket supplies the room and player identity for all
later commands. Commands therefore contain only the data needed to perform
the action:

```json
{
  "protocolVersion": 6,
  "command": {
    "type": "play-turn",
    "matchId": "match-1",
    "column": 3
  }
}
```

Server events keep room context together and separate from event data:

```json
{
  "protocolVersion": 6,
  "room": {
    "id": "ABCD2345",
    "mode": {
      "id": "shared-duel",
      "version": 1,
      "rules": { "id": "shared-duel", "version": 1 }
    }
  },
  "event": {
    "type": "opponent-cursor",
    "matchId": "match-1",
    "playerId": "player-2",
    "column": 5
  }
}
```

## Message inventory

| Direction | Scope | Types |
| --- | --- | --- |
| Client command | Lobby | `set-ready` |
| Client command | Room chat | `send-chat` |
| Client command | Score Race | `publish-progress`, `finish-match`, `resume-session` |
| Client command | Shared Duel | `play-turn`, `move-cursor`, `set-paused`, `forfeit-match` |
| Server event | Shared lifecycle | `room-state`, `match-countdown`, `match-finished`, `match-paused` |
| Server event | Room chat | `chat-message`, `chat-rate-limited` |
| Server event | Score Race | `opponent-progress` |
| Server event | Shared Duel | `turn-assigned`, `turn-played`, `turn-expired`, `opponent-cursor`, `duel-status` |

The shared `room-state` event makes lobby presence explicit instead of asking
clients to infer it from readiness:

```json
{
  "type": "room-state",
  "localReady": true,
  "opponentReady": false,
  "opponentJoined": true,
  "opponentConnected": false
}
```

`opponentJoined` means the second room slot has been claimed;
`opponentConnected` means that player currently has an authenticated socket.
Together they distinguish waiting for someone to join from waiting for an
admitted opponent to reconnect.

Chat is room-scoped (no `matchId`), valid in every lifecycle phase from lobby
through result, and relayed to both players so sender and opponent stay
symmetric. Messages are length/format validated on parse and rate-limited per
player server-side (`chat-rate-limited` is sent back to the sender, never
silently dropped). Accepted chat counts as room activity and extends the
lobby/result TTL.

Transport failures retain their small shape so they can be sent even when
authentication or protocol parsing fails:

```json
{ "type": "room-transport-error", "error": "invalid-message" }
```

## Changing the protocol

1. Change the internal discriminated union in
   `src/shared/multiplayer-contracts.ts`.
2. Update its runtime parser in `src/shared/multiplayer-messages.ts`.
3. If the outer envelope changes, update the `encode*` and `parse*WireMessage`
   functions in that same module.
4. Bump `MULTIPLAYER_PROTOCOL_VERSION`; frontend and API versions are deployed
   together.
5. Add a parser test and an end-to-end gateway test for the new shape.

Top-level envelopes and individual command/event bodies reject unknown keys.
Nested game values are rebuilt field by field and may tolerate unknown keys as
documented beside their parsers.
