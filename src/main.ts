import { Game } from './app/game-controller.js';
import { UiRoot } from './ui/ui-root.js';

const ui = new UiRoot();
const game = new Game(ui.canvas, ui.mounts);

window.addEventListener('resize', () => {
  game.handleResize();
});
