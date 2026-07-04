import { Game } from './app/game-controller.js';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const game = new Game(canvas);

window.addEventListener('resize', () => {
  game.handleResize();
});
