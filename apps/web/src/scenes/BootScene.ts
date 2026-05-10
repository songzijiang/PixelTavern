import Phaser from 'phaser';
import { ASSET_PATH } from '../constants';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    this.load.json('assetManifest', `${ASSET_PATH}manifest.json`);
    this.load.json('witchAnims', `${ASSET_PATH}女巫/witch_animations.json`);
    this.load.json('warriorAnims', `${ASSET_PATH}勇士/勇士_animations.json`);
    this.load.json('bartenderAnims', `${ASSET_PATH}酒保/酒保_animations.json`);
    this.load.json('poetAnims', `${ASSET_PATH}诗人/诗人_animations.json`);
    this.load.json('rangerAnims', `${ASSET_PATH}游侠/游侠_animations.json`);
    this.load.json('mysteriousAnims', `${ASSET_PATH}神秘客/神秘客_animations.json`);
  }

  create() {
    const manifest = this.cache.json.get('assetManifest');
    if (!manifest?.images?.length) {
      console.error('[BootScene] manifest.json 为空或缺失，请先运行 npm run prepare-assets');
      return;
    }

    const imagePaths: string[] = manifest.images;
    const animationPaths: string[] = manifest.animations || [];
    const manifestNpcFolders = Array.from(new Set(
      imagePaths
        .filter((relPath: string) => relPath.includes('/anim/') && relPath.endsWith('.png'))
        .map((relPath: string) => relPath.split('/')[0])
        .filter(Boolean),
    ));

    // 为每个图片注册 key 并加载
    for (const relPath of imagePaths) {
      const key = relPath.replace(/\//g, '_').replace('.png', '');
      this.load.image(key, `${ASSET_PATH}${relPath}`);
    }

    for (const relPath of animationPaths) {
      const folder = relPath.split('/')[0];
      if (!folder) continue;
      this.load.json(`npcAnim_${folder}`, `${ASSET_PATH}${relPath}`);
    }

    for (const folder of manifestNpcFolders) {
      if (animationPaths.some((relPath) => relPath.startsWith(`${folder}/`))) continue;
      this.load.json(`npcAnim_${folder}`, `${ASSET_PATH}${folder}/${folder}_animations.json`);
    }

    // 进度条
    const width = this.cameras.main.width;
    const height = this.cameras.main.height;
    const barW = 320;
    const barH = 24;
    const barX = (width - barW) / 2;
    const barY = height / 2;

    const bg = this.add.rectangle(width / 2, barY + barH / 2, barW, barH, 0x333333);
    const bar = this.add.rectangle(barX + 2, barY + 2, 0, barH - 4, 0xffcc66).setOrigin(0, 0);

    const text = this.add.text(width / 2, barY - 20, 'Loading...', {
      fontSize: '14px',
      color: '#cccccc',
    }).setOrigin(0.5);

    this.load.on('progress', (value: number) => {
      bar.width = (barW - 4) * value;
    });

    this.load.on('complete', () => {
      text.setText('Done!');
      this.time.delayedCall(200, () => {
        this.scene.start('TavernScene');
      });
    });

    this.load.start();
  }
}
