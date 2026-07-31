import { UiRoot } from './ui/ui-root.js';

const params = new URLSearchParams(window.location.search);
const demoMode = params.has('demo');
const multiplayerMode = params.has('room') || params.get('multiplayer') === 'create';
if (demoMode) document.documentElement.classList.add('demo-mode');
const ui = new UiRoot();

if (demoMode) {
  document.title = 'Disco — Demo';
  const [{ DemoController }, { DemoOverlay }] = await Promise.all([
    import('./app/demo-controller.js'),
    import('./ui/demo-overlay.js'),
  ]);
  const demo = new DemoController(ui.canvas);
  new DemoOverlay(ui.mounts.utilities);
  window.addEventListener('resize', () => demo.handleResize());
} else if (multiplayerMode) {
  const { MultiplayerGame } = await import('./app/multiplayer-game-controller.js');
  const game = await MultiplayerGame.create(ui.canvas, ui.mounts);

  window.addEventListener('resize', () => {
    game.handleResize();
  });
} else {
  const { Game } = await import('./app/game-controller.js');
  const game = new Game(ui.canvas, ui.mounts);

  window.addEventListener('resize', () => {
    game.handleResize();
  });
}
