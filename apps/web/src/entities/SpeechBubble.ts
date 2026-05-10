import Phaser from 'phaser';

export class SpeechBubble extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private textObj: Phaser.GameObjects.Text;
  private nameObj: Phaser.GameObjects.Text;
  private visibleUntil: number = 0;
  private readonly padding = 12;
  private readonly maxTextW = 260;

  constructor(scene: Phaser.Scene, x: number, y: number, text: string, speakerName?: string) {
    super(scene, x, y);

    this.bg = scene.add.graphics();
    this.add(this.bg);

    this.nameObj = scene.add.text(0, 0, '', {
      fontSize: '14px',
      color: '#c9a96e',
      fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
    });
    this.nameObj.setOrigin(0.5, 0);
    this.nameObj.setVisible(false);
    this.add(this.nameObj);

    this.textObj = scene.add.text(0, 0, '', {
      fontSize: '17px',
      color: '#f5e6d3',
      fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
      wordWrap: { width: this.maxTextW },
      lineSpacing: 4,
    });
    this.textObj.setOrigin(0.5, 0);
    this.add(this.textObj);

    this.setText(text, speakerName);
    this.setAlpha(0);
    this.setDepth(9999);
    this.setVisible(false);

    scene.add.existing(this);
  }

  setText(text: string, speakerName?: string) {
    // 手动 CJK 换行
    const wrapped = this.wrapText(text);
    this.textObj.setText(wrapped);

    const nameH = speakerName ? 20 : 0;
    if (speakerName) {
      this.nameObj.setText(speakerName);
      this.nameObj.setVisible(true);
    } else {
      this.nameObj.setVisible(false);
    }

    const textW = Math.min(Math.max(this.textObj.width, this.nameObj.width), this.maxTextW);
    const textH = this.textObj.height;

    const bw = textW + this.padding * 2;
    const bh = nameH + textH + this.padding * 2;
    const centerX = textW / 2;

    this.nameObj.setPosition(0, -bh / 2 + this.padding);
    this.textObj.setPosition(0, -bh / 2 + this.padding + nameH);

    this.drawBg(bw, bh);
    this.visibleUntil = 0;
  }

  // 按像素宽度手动换行
  private wrapText(text: string): string {
    const maxW = this.maxTextW;
    const lines: string[] = [];
    for (const para of text.split('\n')) {
      if (para.length === 0) { lines.push(''); continue; }
      let cur = '';
      let curW = 0;
      for (const ch of para) {
        const cw = this.charWidth(ch);
        if (curW + cw > maxW && cur.length > 0) {
          lines.push(cur);
          cur = ch;
          curW = cw;
        } else {
          cur += ch;
          curW += cw;
        }
      }
      if (cur) lines.push(cur);
    }
    return lines.join('\n');
  }

  private charWidth(ch: string): number {
    if (ch === ' ') return 6;
    // CJK / 全角字符 / 全角标点
    if (/[一-鿿　-〿㐀-䶿＀-￯ -⁯（）《》「」『』【】。，…！？、：；""''—]/.test(ch)) return 17;
    // 英文/数字
    if (/[A-Za-z0-9]/.test(ch)) return 9;
    return 10;
  }

  private drawBg(w: number, h: number) {
    const hw = w / 2, hh = h / 2;
    this.bg.clear();

    // 阴影
    this.bg.fillStyle(0x000000, 0.25);
    this.bg.fillRoundedRect(-hw + 2, -hh + 2, w, h, 10);

    // 主体
    this.bg.fillStyle(0x1a1a2e, 0.94);
    this.bg.fillRoundedRect(-hw, -hh, w, h, 10);
    this.bg.lineStyle(1.5, 0xc9a96e, 0.9);
    this.bg.strokeRoundedRect(-hw, -hh, w, h, 10);

    // 三角指针
    const triSize = 6;
    this.bg.fillStyle(0x1a1a2e, 0.94);
    this.bg.fillTriangle(-triSize, hh, triSize, hh, 0, hh + 10);
    this.bg.lineStyle(1.5, 0xc9a96e, 0.9);
    this.bg.beginPath();
    this.bg.moveTo(-triSize, hh);
    this.bg.lineTo(0, hh + 10);
    this.bg.lineTo(triSize, hh);
    this.bg.strokePath();
  }

  show(duration: number = 3) {
    this.setVisible(true);
    this.visibleUntil = Date.now() + duration * 1000;
    this.scene.tweens.add({
      targets: this, alpha: 1, duration: 200, ease: 'Power2',
    });
  }

  hide() {
    this.scene.tweens.add({
      targets: this, alpha: 0, duration: 300, ease: 'Power2',
      onComplete: () => { this.setVisible(false); },
    });
  }

  isExpired(): boolean {
    return this.visibleUntil > 0 && Date.now() > this.visibleUntil;
  }

  updatePosition(worldX: number, worldY: number, spriteHeight: number) {
    let bx = worldX;
    let by = worldY - spriteHeight - 14;

    const bw = (this.textObj.width || 100) / 2 + this.padding;
    const bh = (this.textObj.height || 30) + (this.nameObj.visible ? 20 : 0) + this.padding * 2 + 10;
    const gameW = this.scene.cameras.main.width;
    const gameH = this.scene.cameras.main.height;
    const topMargin = 28; // 顶部留白

    // X 方向 clamp
    if (bx - bw < 8) bx = bw + 8;
    if (bx + bw > gameW - 8) bx = gameW - bw - 8;

    // Y 方向 clamp — 上方不翻转，只限制最小 Y
    const minY = topMargin + bh / 2;
    if (by - bh / 2 < topMargin) {
      by = minY;
    }
    // 下方也限制
    if (by + bh / 2 > gameH - 8) {
      by = gameH - bh / 2 - 8;
    }

    this.setPosition(bx, by);
  }
}
