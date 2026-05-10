import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { TavernScene } from './scenes/TavernScene';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from './constants';

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  parent: 'game-container',
  backgroundColor: '#1a1a2e',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, TavernScene],
};
