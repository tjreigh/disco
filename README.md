# Disco

Disco is an original puzzle game inspired by Drop7. It currently retains some
familiar foundations as an homage, but its rules and identity are intended to
evolve independently.

The rules live in `src/engine.ts`, `src/physics.ts`, and `src/board.ts`. They
have no browser dependencies. Rendering, animation, audio, and input are thin
adapters around the synchronous `GameEngine` turn result.

Run all headless tests:

```sh
npm test
```

To run only the turn-level engine tests, use `npm run test:engine`.

The engine accepts injected disc factories, so tests can use exact sequences
instead of mocking `Math.random()`:

```ts
const engine = new GameEngine({
  discFactory: () => makeDisc(7, DiscKind.Numbered),
  crackedDiscFactory: () => makeDisc(3, DiscKind.SingleCracked),
});

const result = engine.drop(2);
```

`result.steps` describes everything that occurred during the turn. The browser
uses those steps for animation; tests can assert them directly.

The in-game logic debugger can export a JSON issue report. Schema version 2
includes `turnHistory`, containing every attempted turn in the current game in
chronological order, including each turn's physics steps, clear scans, and board
frames. `lastTurn` remains available as a convenience for older analysis tools.
