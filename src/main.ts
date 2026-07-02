import { Game } from './game.js';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const game = new Game(canvas);

window.addEventListener('resize', () => {
  game.handleResize();
});
