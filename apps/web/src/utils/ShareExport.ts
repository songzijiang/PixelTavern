/**
 * 会话导出为分享图片。
 * 渲染选中轮次的对话 + 角色头像，导出为 PNG 下载。
 */

const NPC_PORTRAITS: Record<string, string> = {
  bartender: '酒保',
  warrior: '勇士',
  witch: '女巫',
  mysterious: '神秘客',
  poet: '诗人',
  ranger: '游侠',
};

interface DialogueLine {
  sec: number;
  speaker: string;
  line: string;
  to?: string;
}

interface ShareRow {
  data: DialogueLine;
  quoteLines: string[];
  rowH: number;
}

const portraitCache = new Map<string, HTMLImageElement>();

function loadPortrait(npcKey: string): Promise<HTMLImageElement | null> {
  if (portraitCache.has(npcKey)) return Promise.resolve(portraitCache.get(npcKey)!);
  return new Promise((resolve) => {
    const folder = NPC_PORTRAITS[npcKey];
    if (!folder) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      portraitCache.set(npcKey, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = `assets/${folder}/${folder}_001.png`;
  });
}

let _resolveName: ((key: string) => string) | undefined;

function NPC_NAMES(key: string): string {
  return _resolveName ? _resolveName(key) : key;
}

export async function exportShareImage(dialogues: DialogueLine[], calendar: string, topic: string, segmentId: number, resolveName?: (key: string) => string) {
  _resolveName = resolveName;
  const W = 1080;
  const SCALE = 2;
  const PAD = 54;
  const HEADER_H = 238;
  const FOOTER_H = 176;
  const AVATAR = 58;
  const ROW_GAP = 18;
  const MAX_DIALOGUES = 16;
  const visibleDialogues = dialogues.slice(0, MAX_DIALOGUES);

  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d')!;
  const quoteMaxW = W - PAD * 2 - AVATAR - 132;
  measure.font = '28px "Microsoft YaHei", "PingFang SC", sans-serif';
  const rows: ShareRow[] = visibleDialogues.map((data) => {
    const quoteLines = wrapText(measure, `「${data.line}」`, quoteMaxW, 3);
    return {
      data,
      quoteLines,
      rowH: Math.max(104, 58 + quoteLines.length * 34),
    };
  });

  const omitted = Math.max(0, dialogues.length - visibleDialogues.length);
  const contentH = rows.reduce((sum, row) => sum + row.rowH, 0) + Math.max(0, rows.length - 1) * ROW_GAP;
  const H = HEADER_H + contentH + (omitted > 0 ? 44 : 0) + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);

  const computedDate = getGameDate(segmentId);
  const displayDate = calendar?.trim() || computedDate;
  const titleTopic = topic?.trim() || '酒馆记事';

  drawBackground(ctx, W, H);
  drawHeader(ctx, W, PAD, displayDate, titleTopic, segmentId);

  const speakers = new Set(visibleDialogues.map(d => d.speaker));
  await Promise.all([...speakers].map(k => loadPortrait(k)));

  let y = HEADER_H;
  for (let i = 0; i < rows.length; i++) {
    drawDialogueRow(ctx, rows[i], PAD, y, W - PAD * 2, AVATAR, i);
    y += rows[i].rowH + ROW_GAP;
  }

  if (omitted > 0) {
    ctx.fillStyle = 'rgba(229, 205, 145, 0.72)';
    ctx.font = '22px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`另有 ${omitted} 条对话已收起，打开项目可查看完整轮次`, W / 2, y + 18);
    y += 44;
  }

  await drawFooter(ctx, W, H, PAD);

  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/png');
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const fileDate = computedDate.replace(/[年月]/g, '-').replace('日', '');
  a.download = `PixelTavern_R${segmentId}_${fileDate}.png`;
  a.click();
  URL.revokeObjectURL(url);
}

function getGameDate(segmentId: number) {
  const start = new Date('1500-01-01T00:00:00');
  const totalRounds = segmentId;
  const gameDays = Math.floor(totalRounds / 6);
  const roundInDay = totalRounds % 6;
  const hour = roundInDay * 4;
  start.setDate(start.getDate() + gameDays);
  return `${start.getFullYear()}年${String(start.getMonth() + 1).padStart(2, '0')}月${String(start.getDate()).padStart(2, '0')}日 ${String(hour).padStart(2, '0')}:00`;
}

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#130d13');
  bg.addColorStop(0.42, '#24151b');
  bg.addColorStop(1, '#0b0b0f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const ember = ctx.createRadialGradient(130, 120, 20, 130, 120, 360);
  ember.addColorStop(0, 'rgba(255, 143, 64, 0.24)');
  ember.addColorStop(1, 'rgba(255, 143, 64, 0)');
  ctx.fillStyle = ember;
  ctx.fillRect(0, 0, W, H);

  const moon = ctx.createRadialGradient(W - 120, 92, 10, W - 120, 92, 300);
  moon.addColorStop(0, 'rgba(123, 95, 191, 0.18)');
  moon.addColorStop(1, 'rgba(123, 95, 191, 0)');
  ctx.fillStyle = moon;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(226, 190, 113, 0.62)';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, W - 48, H - 48);
  ctx.strokeStyle = 'rgba(226, 190, 113, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(34, 34, W - 68, H - 68);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  for (let i = 0; i < 260; i++) {
    const x = (i * 97) % W;
    const y = (i * 193) % H;
    const s = (i % 3) + 1;
    ctx.fillRect(x, y, s, s);
  }
}

function drawHeader(ctx: CanvasRenderingContext2D, W: number, PAD: number, date: string, topic: string, segmentId: number) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  roundRect(ctx, PAD, 48, W - PAD * 2, 150, 18);
  ctx.fill();

  ctx.fillStyle = '#f3d99a';
  ctx.font = '700 54px "Microsoft YaHei", "PingFang SC", serif';
  ctx.textAlign = 'left';
  ctx.fillText('PixelTavern 像素酒馆', PAD + 30, 112);

  ctx.fillStyle = '#c58f55';
  ctx.font = '24px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText('黑暗奇幻边境酒馆 · 本轮实录', PAD + 32, 150);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#e7c67c';
  ctx.font = '700 26px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(`R${segmentId}`, W - PAD - 34, 104);
  ctx.fillStyle = 'rgba(236, 221, 181, 0.78)';
  ctx.font = '22px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(date, W - PAD - 34, 140);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.font = '700 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(truncateText(ctx, topic, W - PAD * 2 - 68), PAD + 34, 204);
}

function drawDialogueRow(
  ctx: CanvasRenderingContext2D,
  row: ShareRow,
  x: number,
  y: number,
  w: number,
  avatarSize: number,
  idx: number,
) {
  const { data, quoteLines, rowH } = row;
  const cardFill = idx % 2 === 0 ? 'rgba(255, 255, 255, 0.065)' : 'rgba(255, 255, 255, 0.04)';
  ctx.fillStyle = cardFill;
  roundRect(ctx, x, y, w, rowH, 18);
  ctx.fill();

  ctx.strokeStyle = 'rgba(226, 190, 113, 0.16)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, rowH - 1, 18);
  ctx.stroke();

  ctx.fillStyle = 'rgba(226, 190, 113, 0.82)';
  ctx.font = '700 21px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${String(data.sec).padStart(2, '0')}s`, x + 52, y + 44);

  const avatarX = x + 96;
  const avatarY = y + Math.floor((rowH - avatarSize) / 2);
  drawAvatar(ctx, data.speaker, avatarX, avatarY, avatarSize);

  const textX = avatarX + avatarSize + 24;
  const name = NPC_NAMES(data.speaker);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f1ca76';
  ctx.font = '700 24px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(name, textX, y + 38);

  if (data.to && _resolveName && _resolveName(data.to) !== data.to) {
    ctx.fillStyle = 'rgba(217, 199, 160, 0.58)';
    ctx.font = '20px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(`对 ${NPC_NAMES(data.to)}`, textX + ctx.measureText(name).width + 18, y + 38);
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = '28px "Microsoft YaHei", "PingFang SC", sans-serif';
  for (let i = 0; i < quoteLines.length; i++) {
    ctx.fillText(quoteLines[i], textX, y + 76 + i * 34);
  }
}

function drawAvatar(ctx: CanvasRenderingContext2D, speaker: string, x: number, y: number, size: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(13, 10, 13, 0.92)';
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(226, 190, 113, 0.72)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const portrait = portraitCache.get(speaker);
  if (portrait && portrait.complete && portrait.naturalWidth > 0) {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(portrait, x, y, size, size);
  } else {
    ctx.fillStyle = '#d7b36b';
    ctx.font = '700 28px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(NPC_NAMES(speaker).slice(0, 1), x + size / 2, y + size / 2 + 10);
  }
  ctx.restore();
}

async function drawFooter(ctx: CanvasRenderingContext2D, W: number, H: number, PAD: number) {
  const top = H - 144;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  roundRect(ctx, PAD, top, W - PAD * 2, 92, 16);
  ctx.fill();

  ctx.fillStyle = 'rgba(236, 221, 181, 0.72)';
  ctx.font = '20px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('AI 生成剧情，使用者对提示词与传播负责；请遵守当地法律与平台规则。', PAD + 26, top + 36);
  ctx.fillText('素材由 AI 辅助生成，如有权利问题请联系处理。', PAD + 26, top + 66);

  const qrSize = 78;
  const qrImg = await loadQr(qrSize);
  const qrX = W - PAD - qrSize - 22;
  const qrY = top + 7;
  if (qrImg && qrImg.complete && qrImg.naturalWidth > 0) {
    ctx.fillStyle = '#f3ead1';
    roundRect(ctx, qrX - 5, qrY - 5, qrSize + 10, qrSize + 10, 10);
    ctx.fill();
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
  ctx.font = '18px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('github.com/songzijiang/PixelTavern', qrX - 16, top + 56);
  ctx.fillStyle = 'rgba(226, 190, 113, 0.68)';
  ctx.font = '700 19px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText('开源项目入口', qrX - 16, top + 30);
}

function loadQr(size: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=https://github.com/songzijiang/PixelTavern`;
  });
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    const next = line + ch;
    if (ctx.measureText(next).width <= maxWidth || line.length === 0) {
      line = next;
      continue;
    }
    lines.push(line);
    line = ch;
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && ctx.measureText(lines[maxLines - 1]).width > maxWidth) {
    lines[maxLines - 1] = truncateText(ctx, lines[maxLines - 1], maxWidth);
  } else if (lines.length === maxLines && text.length > lines.join('').length) {
    lines[maxLines - 1] = truncateText(ctx, `${lines[maxLines - 1]}...`, maxWidth);
  }
  return lines;
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}...`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}...`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
