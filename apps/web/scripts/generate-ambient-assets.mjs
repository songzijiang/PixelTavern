import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const OUT_DIR = join(ROOT, 'output', '物体');

const PALETTE = {
  dark: [28, 17, 13, 255],
  outline: [55, 33, 22, 255],
  woodDark: [82, 48, 25, 255],
  wood: [139, 79, 34, 255],
  woodLight: [199, 127, 55, 255],
  brassDark: [98, 72, 34, 255],
  brass: [173, 125, 45, 255],
  brassLight: [234, 180, 72, 255],
  waxShadow: [180, 151, 103, 255],
  wax: [233, 207, 142, 255],
  flameOuter: [237, 104, 33, 255],
  flameMid: [255, 178, 54, 255],
  flameInner: [255, 239, 136, 255],
  glass: [68, 111, 106, 190],
  parchment: [205, 167, 99, 255],
  ink: [79, 49, 35, 255],
};

function canvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function px(c, x, y, color) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (Math.floor(y) * c.width + Math.floor(x)) * 4;
  c.data[i] = color[0];
  c.data[i + 1] = color[1];
  c.data[i + 2] = color[2];
  c.data[i + 3] = color[3];
}

function rect(c, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) px(c, xx, yy, color);
  }
}

function ellipse(c, cx, cy, rx, ry, color) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) px(c, x, y, color);
    }
  }
}

function line(c, x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    px(c, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), color);
  }
}

function outlineRect(c, x, y, w, h, color) {
  rect(c, x, y, w, 1, color);
  rect(c, x, y + h - 1, w, 1, color);
  rect(c, x, y, 1, h, color);
  rect(c, x + w - 1, y, 1, h, color);
}

function flame(c, cx, y, frame, scale = 1) {
  const lean = [-1, 0, 1, 0][frame % 4];
  const h = [11, 13, 12, 14][frame % 4] * scale;
  const w = [6, 7, 6, 8][frame % 4] * scale;
  ellipse(c, cx + lean, y + h * 0.45, w * 0.58, h * 0.44, PALETTE.flameOuter);
  ellipse(c, cx + lean, y + h * 0.38, w * 0.42, h * 0.34, PALETTE.flameMid);
  ellipse(c, cx + lean, y + h * 0.33, w * 0.22, h * 0.22, PALETTE.flameInner);
  px(c, cx + lean, y, PALETTE.flameMid);
}

function drawCandle(frame) {
  const c = canvas(32, 48);
  ellipse(c, 16, 43, 10, 3, [0, 0, 0, 72]);
  rect(c, 8, 38, 16, 4, PALETTE.brassDark);
  rect(c, 10, 36, 12, 3, PALETTE.brass);
  rect(c, 12, 21, 8, 16, PALETTE.waxShadow);
  rect(c, 13, 20, 7, 16, PALETTE.wax);
  rect(c, 18, 24, 1, 8, [184, 141, 88, 255]);
  rect(c, 14, 19, 5, 2, [248, 229, 166, 255]);
  px(c, 16, 18, PALETTE.outline);
  flame(c, 16, 7, frame, 1);
  return c;
}

function drawWallLamp(frame) {
  const c = canvas(48, 56);
  rect(c, 20, 9, 8, 34, PALETTE.outline);
  rect(c, 21, 10, 6, 32, PALETTE.woodDark);
  rect(c, 23, 12, 2, 28, PALETTE.woodLight);
  rect(c, 13, 38, 22, 5, PALETTE.outline);
  rect(c, 15, 36, 18, 4, PALETTE.brass);
  rect(c, 17, 34, 14, 3, PALETTE.brassLight);
  line(c, 24, 25, 15, 36, PALETTE.brassDark);
  line(c, 25, 25, 34, 36, PALETTE.brassDark);
  flame(c, 24, 17, frame, 1.05);
  return c;
}

function drawHangingLantern(frame) {
  const c = canvas(56, 76);
  for (let y = 0; y < 18; y += 4) rect(c, 27, y, 2, 2, PALETTE.brassDark);
  line(c, 28, 18, 18, 31, PALETTE.brassDark);
  line(c, 28, 18, 38, 31, PALETTE.brassDark);
  rect(c, 16, 30, 24, 4, PALETTE.outline);
  rect(c, 18, 32, 20, 26, PALETTE.brassDark);
  rect(c, 21, 35, 14, 18, PALETTE.glass);
  rect(c, 24, 36, 2, 15, [121, 169, 149, 105]);
  rect(c, 17, 57, 22, 4, PALETTE.outline);
  rect(c, 20, 61, 16, 4, PALETTE.brass);
  flame(c, 28, 38, frame, 1.08);
  ellipse(c, 28, 70, 18, 4, [0, 0, 0, 64]);
  return c;
}

function drawMug() {
  const c = canvas(34, 30);
  ellipse(c, 17, 27, 14, 3, [0, 0, 0, 68]);
  rect(c, 7, 7, 18, 17, PALETTE.outline);
  rect(c, 9, 8, 14, 15, PALETTE.wood);
  rect(c, 11, 8, 3, 15, PALETTE.woodLight);
  rect(c, 20, 10, 8, 10, PALETTE.outline);
  rect(c, 22, 12, 4, 6, [0, 0, 0, 0]);
  rect(c, 7, 5, 18, 4, PALETTE.brass);
  rect(c, 9, 4, 14, 2, PALETTE.brassLight);
  rect(c, 10, 24, 13, 2, PALETTE.woodDark);
  return c;
}

function drawParchment() {
  const c = canvas(48, 32);
  ellipse(c, 24, 28, 20, 3, [0, 0, 0, 54]);
  rect(c, 6, 7, 35, 18, PALETTE.parchment);
  rect(c, 4, 9, 4, 14, [176, 133, 78, 255]);
  rect(c, 39, 7, 5, 17, [184, 141, 84, 255]);
  line(c, 12, 12, 30, 12, PALETTE.ink);
  line(c, 11, 16, 34, 16, PALETTE.ink);
  line(c, 13, 20, 26, 20, PALETTE.ink);
  px(c, 36, 11, [93, 35, 35, 255]);
  px(c, 37, 12, [144, 42, 38, 255]);
  return c;
}

function drawCoins() {
  const c = canvas(36, 24);
  ellipse(c, 18, 21, 14, 3, [0, 0, 0, 58]);
  ellipse(c, 13, 14, 6, 4, PALETTE.brassDark);
  ellipse(c, 13, 13, 5, 3, PALETTE.brass);
  ellipse(c, 21, 12, 6, 4, PALETTE.brassDark);
  ellipse(c, 21, 11, 5, 3, PALETTE.brassLight);
  ellipse(c, 25, 16, 5, 3, PALETTE.brass);
  rect(c, 12, 12, 3, 1, PALETTE.flameInner);
  rect(c, 19, 10, 3, 1, PALETTE.flameInner);
  return c;
}

async function writePng(name, c) {
  await sharp(c.data, { raw: { width: c.width, height: c.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(join(OUT_DIR, name));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (let i = 0; i < 4; i++) {
    await writePng(`蜡烛_${i}.png`, drawCandle(i));
    await writePng(`壁灯_${i}.png`, drawWallLamp(i));
    await writePng(`吊灯_${i}.png`, drawHangingLantern(i));
  }
  await writePng('酒杯.png', drawMug());
  await writePng('羊皮纸.png', drawParchment());
  await writePng('金币.png', drawCoins());
}

main().catch((err) => {
  console.error('[generate-ambient-assets] ERROR:', err);
  process.exit(1);
});
