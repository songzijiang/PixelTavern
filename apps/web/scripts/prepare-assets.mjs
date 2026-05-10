import sharp from 'sharp';
import { copyFile, readdir, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const OUTPUT_DIR = join(ROOT, 'output');
const PUBLIC_DIR = join(__dirname, '..', 'public', 'assets');

const FLIP_PAIRS = [
  { dir: '酒保', flip: '004->003' },
  { dir: '勇士', flip: '004->003' },
  { dir: '女巫', flip: '003->004' },
  { dir: '诗人', flip: '003->004' },
  { dir: '游侠', flip: '003->004' },
  { dir: '神秘客', flip: '003->004' },
];

// 需要清除白边的文件（相对 public/assets/ 的路径）
const WHITE_CLEAN_FILES = [
  '桌椅/桌子.png',
  '桌椅/椅子.png',
  '桌椅/柜台.png',
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replaceFileWithRetry(tmpPath, filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(filePath, { force: true });
      await rename(tmpPath, filePath);
      return;
    } catch (err) {
      lastError = err;
      if (!['EBUSY', 'EPERM'].includes(err?.code)) break;
      await wait(150 + attempt * 150);
    }
  }
  await rm(tmpPath, { force: true }).catch(() => {});
  throw lastError;
}

async function copyFileReplacing(srcPath, dstPath) {
  await mkdir(dirname(dstPath), { recursive: true });
  const tmpPath = `${dstPath}.tmp-copy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await copyFile(srcPath, tmpPath);
  await replaceFileWithRetry(tmpPath, dstPath);
}

async function copyDirReplacing(srcDir, dstDir) {
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirReplacing(srcPath, dstPath);
    } else if (!srcPath.endsWith('_index.txt')) {
      await copyFileReplacing(srcPath, dstPath);
    }
  }
}

async function cleanWhitePixels(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let cleaned = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const px = (i / 4) % info.width;
    const py = Math.floor((i / 4) / info.width);
    // 接近白/灰的背景与投影残留会在游戏暗色场景里露出硬边，直接转透明。
    if (
      isOutsideFurnitureSilhouette(filePath, px, py, info.width, info.height) ||
      isFurnitureBackgroundResidue(filePath, px, py, info.width, info.height, r, g, b, a)
    ) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      cleaned++;
    }
  }

  await writePngReplacing(filePath, sharp(data, { raw: info }).png());
  return cleaned;
}

function isOutsideFurnitureSilhouette(filePath, x, y, width, height) {
  const nx = x / width;
  const ny = y / height;

  if (filePath.includes('桌子.png')) {
    const top = inEllipse(nx, ny, 0.5, 0.32, 0.5, 0.3) && ny <= 0.64;
    const pedestal = inRect(nx, ny, 0.43, 0.50, 0.59, 0.91);
    const leftBackLeg = inPoly(nx, ny, [[0.17, 0.65], [0.40, 0.52], [0.47, 0.60], [0.27, 0.79], [0.13, 0.75]]);
    const rightBackLeg = inPoly(nx, ny, [[0.83, 0.65], [0.60, 0.52], [0.53, 0.60], [0.73, 0.79], [0.87, 0.75]]);
    const leftFrontFoot = inPoly(nx, ny, [[0.08, 0.88], [0.30, 0.73], [0.42, 0.80], [0.24, 0.99], [0.09, 0.97]]);
    const rightFrontFoot = inPoly(nx, ny, [[0.92, 0.88], [0.70, 0.73], [0.58, 0.80], [0.76, 0.99], [0.91, 0.97]]);
    const centerBand = inRect(nx, ny, 0.37, 0.75, 0.63, 0.92);
    return !(top || pedestal || leftBackLeg || rightBackLeg || leftFrontFoot || rightFrontFoot || centerBand);
  }

  if (filePath.includes('椅子.png')) {
    const leftPost = inRect(nx, ny, 0.06, 0.0, 0.25, 0.98);
    const rightPost = inRect(nx, ny, 0.75, 0.0, 0.94, 0.98);
    const arch = inEllipse(nx, ny, 0.5, 0.19, 0.31, 0.15) && ny <= 0.33;
    const backPanel = inRect(nx, ny, 0.27, 0.12, 0.73, 0.27);
    const backBar = inRect(nx, ny, 0.23, 0.34, 0.78, 0.43);
    const seat = inPoly(nx, ny, [[0.02, 0.45], [0.94, 0.45], [0.99, 0.60], [0.93, 0.69], [0.07, 0.69], [0.00, 0.60]]);
    const apron = inRect(nx, ny, 0.12, 0.62, 0.88, 0.73);
    const leftLeg = inRect(nx, ny, 0.09, 0.66, 0.28, 1.0);
    const rightLeg = inRect(nx, ny, 0.72, 0.66, 0.91, 1.0);
    const lowerBar = inRect(nx, ny, 0.27, 0.76, 0.73, 0.84);
    return !(leftPost || rightPost || arch || backPanel || backBar || seat || apron || leftLeg || rightLeg || lowerBar);
  }

  if (filePath.includes('柜台.png')) {
    const top = inRect(nx, ny, 0.02, 0.02, 0.98, 0.36);
    const body = inRect(nx, ny, 0.03, 0.23, 0.97, 0.93);
    const leftFoot = inRect(nx, ny, 0.00, 0.82, 0.12, 1.0);
    const rightFoot = inRect(nx, ny, 0.86, 0.82, 1.0, 1.0);
    return !(top || body || leftFoot || rightFoot);
  }

  return false;
}

function isFurnitureBackgroundResidue(filePath, x, y, width, height, r, g, b, a) {
  if (a === 0) return false;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const avg = (r + g + b) / 3;
  const range = max - min;
  const neutralLight = avg >= 172 && range <= 42;
  const paleWarmWhite = r >= 210 && g >= 198 && b >= 176 && range <= 58;
  if (neutralLight || paleWarmWhite) return true;

  const neutralShadow = avg <= 125 && range <= 24;
  if (!neutralShadow) return false;

  if (filePath.includes('桌子.png')) {
    const metalBase = x >= width * 0.42 && x <= width * 0.58 && y >= height * 0.68 && y <= height * 0.88;
    return y >= height * 0.67 && !metalBase;
  }

  if (filePath.includes('椅子.png')) {
    const backOpening = x >= width * 0.24 && x <= width * 0.78 && y >= height * 0.27 && y <= height * 0.42;
    const lowerOpening = x >= width * 0.20 && x <= width * 0.82 && y >= height * 0.67 && y <= height * 0.88;
    return y >= height * 0.90 || backOpening || lowerOpening;
  }

  if (filePath.includes('柜台.png')) {
    const leftFoot = x <= width * 0.11 && y >= height * 0.80;
    const rightFoot = x >= width * 0.87 && y >= height * 0.80;
    return y >= height * 0.90 && !leftFoot && !rightFoot;
  }

  return false;
}

function inRect(x, y, left, top, right, bottom) {
  return x >= left && x <= right && y >= top && y <= bottom;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function inPoly(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}


async function writePngReplacing(filePath, pipeline) {
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  await pipeline.toFile(tmpPath);
  await replaceFileWithRetry(tmpPath, filePath);
}

async function main() {
  console.log('[prepare-assets] Copying output/ to public/assets/...');
  await mkdir(PUBLIC_DIR, { recursive: true });

  await copyDirReplacing(OUTPUT_DIR, PUBLIC_DIR);

  // 清除桌椅白边
  console.log('[prepare-assets] Cleaning white pixels from furniture...');
  for (const relPath of WHITE_CLEAN_FILES) {
    const fullPath = join(PUBLIC_DIR, relPath);
    if (!existsSync(fullPath)) {
      console.warn(`  [WARN] Not found: ${fullPath}`);
      continue;
    }
    const cleaned = await cleanWhitePixels(fullPath);
    console.log(`  ${relPath}: ${cleaned} white pixels → transparent`);
  }

  // 翻转缺失方向
  console.log('[prepare-assets] Generating missing directional sprites...');
  for (const { dir, flip } of FLIP_PAIRS) {
    const npcDir = join(PUBLIC_DIR, dir);
    const [srcSuffix, dstSuffix] = flip.split('->');
    const srcName = `${dir}_${srcSuffix}.png`;
    const dstName = `${dir}_${dstSuffix}.png`;
    const srcPath = join(npcDir, srcName);
    const dstPath = join(npcDir, dstName);

    if (!existsSync(srcPath)) {
      console.warn(`  [WARN] Source not found: ${srcPath}, skipping`);
      continue;
    }

    console.log(`  Flipping ${dir}: ${srcName} -> ${dstName}`);
    await writePngReplacing(dstPath, sharp(srcPath).flop().png());
  }

  // 生成 manifest
  console.log('[prepare-assets] Generating manifest.json...');
  const images = [];
  const animations = [];
  async function scanDir(dir, base) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath, base);
      } else if (entry.name.endsWith('.png')) {
        images.push(relative(base, fullPath).replace(/\\/g, '/'));
      } else if (
        entry.name.endsWith('_animations.json') ||
        entry.name === 'witch_animations.json'
      ) {
        animations.push(relative(base, fullPath).replace(/\\/g, '/'));
      }
    }
  }
  await scanDir(PUBLIC_DIR, PUBLIC_DIR);

  await writeFile(
    join(PUBLIC_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), images, animations }, null, 2),
    'utf-8'
  );

  console.log(`[prepare-assets] Done! ${images.length} PNGs and ${animations.length} animation JSONs in manifest.`);
}

main().catch((err) => {
  console.error('[prepare-assets] ERROR:', err);
  process.exit(1);
});
