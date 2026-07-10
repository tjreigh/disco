import { Game } from './app/game-controller.js';

const shell = document.createElement('main');
shell.className = 'app-shell';

const topRegion = document.createElement('div');
topRegion.className = 'shell-region shell-region--top';
topRegion.setAttribute('aria-hidden', 'true');

const stage = document.createElement('div');
stage.className = 'game-stage';

const canvas = document.createElement('canvas');
stage.appendChild(canvas);

const bottomRegion = document.createElement('div');
bottomRegion.className = 'shell-region shell-region--bottom';

shell.append(topRegion, stage, bottomRegion);
document.body.appendChild(shell);

const game = new Game(canvas);

window.addEventListener('resize', () => {
  game.handleResize();
});
