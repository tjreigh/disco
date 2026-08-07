import { UiRoot } from './ui/ui-root.js';
import { ZoomControls } from './ui/zoom-controls.js';
import { SHARED_DUEL_MODE_ID } from './shared/multiplayer-contracts.js';

const params = new URLSearchParams(window.location.search);
const demoMode = params.has('demo');
const multiplayerMode = params.has('room') || params.get('multiplayer') === 'create';
const sharedDuelMode = multiplayerMode && params.get('mode') === SHARED_DUEL_MODE_ID;
if (demoMode) document.documentElement.classList.add('demo-mode');
const ui = new UiRoot();
const zoomControls = new ZoomControls(ui.root, ui.mounts.stage);

if (demoMode) {
  document.title = 'Disco — Demo';
  const [{ DemoController }, { DemoOverlay }] = await Promise.all([
    import('./app/demo-controller.js'),
    import('./ui/demo-overlay.js'),
  ]);
  const demo = new DemoController(ui.canvas);
  new DemoOverlay(ui.mounts.utilities);
  // Demo is a passive attract loop (no InputHandler, nothing to interact
  // with beyond the "play disco" link) — no zoom UI here on purpose. The
  // pinch gesture is still technically live (ZoomControls listens globally),
  // just with no button to discover it, which is fine for a preview screen.
  // reclampPan() must run after handleResize() (which runs Renderer.resize())
  // in the same handler, not via a separately-registered listener — see the
  // doc comment on ZoomControls.reclampPan().
  window.addEventListener('resize', () => {
    demo.handleResize();
    zoomControls.reclampPan();
  });
} else if (sharedDuelMode) {
  const { SharedBoardGame } = await import('./app/shared-board-game-controller.js');
  const game = await SharedBoardGame.create(ui.canvas, ui.mounts, zoomControls);

  window.addEventListener('resize', () => {
    game.handleResize();
    zoomControls.reclampPan();
  });
} else if (multiplayerMode) {
  const { MultiplayerGame } = await import('./app/multiplayer-game-controller.js');
  const game = await MultiplayerGame.create(ui.canvas, ui.mounts, zoomControls);

  window.addEventListener('resize', () => {
    game.handleResize();
    zoomControls.reclampPan();
  });
} else {
  const { Game } = await import('./app/game-controller.js');
  const game = new Game(ui.canvas, ui.mounts, zoomControls);

  window.addEventListener('resize', () => {
    game.handleResize();
    zoomControls.reclampPan();
  });
}
