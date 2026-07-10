# Disco

Disco is an original puzzle game inspired by Drop7. It currently retains some
familiar foundations as an homage, but its rules and identity are intended to
evolve independently.

The headless rules live under `src/game/`. Rendering and DOM UI live under
`src/ui/`; audio, input, and cookie persistence live under `src/platform/`.
These adapters are coordinated by `src/app/game-controller.ts` around the
synchronous `GameEngine` turn result.

The browser game is a static Cloudflare Pages deploy. Its runtime has no
client framework or bundled third-party game dependencies; `yarn build`
compiles `src/` into `public/` and copies `index.html`.

An optional account/statistics API lives under `api/`. It is a separate Fastify
and SQLite Node service for VPS deployment, used for OIDC sign-in, cross-device
stats sync, score submissions, and leaderboards. It has its own package,
dependencies, tests, deployment notes, and lockfile so the API does not change
the static Pages build surface. See `api/README.md` for API setup and VPS
deployment details.

Run all headless tests:

```sh
yarn test
```

To run only the turn-level engine tests, use `yarn run test:engine`.

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

The in-game logic debugger can export a JSON issue report. Schema version 4
includes `turnHistory`, containing the most recent turns in chronological
order, plus `truncatedTurns` when older entries were omitted. Each turn still
includes its physics steps, clear scans, and board frames. Built-in playable
values are board-aware: taller stacks favor smaller values, with a secondary
boost for values that could form an immediate horizontal or vertical match.
Replaying generation requires the same `generationSeed`, starting board, and
accepted move sequence, and it is only valid when `generationSource ===
'seeded'`. Rejected moves do not advance generation. `lastTurn` remains
available as a convenience for older analysis tools.
