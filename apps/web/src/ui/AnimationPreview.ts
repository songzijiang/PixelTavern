/**
 * NPC 动画素材检视与导入面板。
 * 显示 manifest/API 中的所有 NPC 素材，并支持上传 9 张横向 5 帧动作图生成新素材。
 */

import { COLORS } from '../utils/Config';
import { bus } from '../utils/EventBus';

const API_BASE = '';

const ACTION_NAMES: Record<string, string> = {
  idle: '闲置', walk_front: '前走', walk_back: '后走', walk_left: '左走', walk_right: '右走',
  sit: '坐下', stand: '起立', talk: '说话', special: '特殊',
};
const ACTIONS = ['idle', 'walk_front', 'walk_back', 'walk_left', 'walk_right', 'sit', 'stand', 'talk', 'special'];
const ASSET_SORT_ORDER: Record<string, number> = {
  imported: 0,
  dlc: 1,
  system: 2,
  default: 3,
};
const ACTION_ALIASES: Record<string, string[]> = {
  idle: ['idle', 'wait', 'standby', '闲置', '待机'],
  walk_front: ['walk_front', 'walkfront', 'frontwalk', 'forward', 'front', '前走', '向前', '正面'],
  walk_back: ['walk_back', 'walkback', 'backwalk', 'backward', 'backword', 'back', '后走', '向后', '背面'],
  walk_left: ['walk_left', 'walkleft', 'leftwalk', 'left', '左走', '向左'],
  walk_right: ['walk_right', 'walkright', 'rightwalk', 'right', '右走', '向右'],
  sit: ['sit', 'sitting', '坐下', '坐姿'],
  stand: ['stand', 'standing', '起立', '站起'],
  talk: ['talk', 'talking', 'speak', 'speech', '说话', '对话'],
  special: ['special', 'sneeze', 'skill', 'emote', '特殊', '喷嚏', '打喷嚏'],
};

interface AssetInfo {
  folderName: string;
  label: string;
  preview?: string;
  frameCount?: number;
  imported?: boolean;
  assetType?: string;
  assetLabel?: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function initAnimationPreview() {
  const tab = document.getElementById('info-tab-assets');
  if (!tab) return;
  const assetsTab = tab;
  let rendered = false;

  const observer = new MutationObserver(() => {
    if (assetsTab.classList.contains('active')) render();
  });
  observer.observe(assetsTab, { attributes: true, attributeFilter: ['class'] });

  async function render(force = false) {
    if (rendered && !force) return;
    rendered = true;
    assetsTab.innerHTML = '<div class="mem-empty">加载 NPC 素材中…</div>';

    try {
      const manifestResp = await fetch('assets/manifest.json');
      const manifest = await manifestResp.json();
      const manifestImages: string[] = manifest.images || [];
      const assets = (await loadAssets(manifestImages)).sort((a, b) => {
        const rankA = getAssetSortRank(a);
        const rankB = getAssetSortRank(b);
        if (rankA !== rankB) return rankA - rankB;
        return (a.label || a.folderName).localeCompare(b.label || b.folderName, 'zh-Hans-CN');
      });

      assetsTab.innerHTML = `
        <h3>NPC 素材</h3>
        ${renderImportPanel()}
        <div id="asset-import-status"></div>
        <div id="npc-assets-list"></div>
      `;
      bindImportPanel();

      const list = assetsTab.querySelector<HTMLElement>('#npc-assets-list')!;
      for (const asset of assets) {
        const section = document.createElement('details');
        section.className = 'asset-section';

        const header = document.createElement('summary');
        header.className = 'asset-section-header';
        const title = document.createElement('span');
        title.className = 'asset-title';
        title.textContent = asset.label || asset.folderName;
        const badgeText = asset.assetLabel || (asset.imported ? '用户导入' : '');
        if (badgeText) {
          const badge = document.createElement('span');
          const badgeType = asset.assetType || (asset.imported ? 'imported' : 'system');
          badge.className = `asset-badge asset-badge-${badgeType}`;
          badge.textContent = badgeText;
          title.appendChild(badge);
        }
        const actions = document.createElement('span');
        actions.className = 'asset-actions';
        const meta = document.createElement('span');
        meta.className = 'asset-meta';
        meta.textContent = `${asset.frameCount || 0} 帧`;
        actions.appendChild(meta);
        if (asset.imported) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'asset-delete-btn';
          delBtn.textContent = '删除';
          delBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteAsset(asset, delBtn);
          });
          actions.appendChild(delBtn);
        }
        header.appendChild(title);
        header.appendChild(actions);
        section.appendChild(header);

        let gridLoaded = false;
        section.addEventListener('toggle', async () => {
          if (!section.open || gridLoaded) return;
          gridLoaded = true;
          const grid = document.createElement('div');
          grid.className = 'asset-anim-grid';
          grid.innerHTML = '<div class="asset-loading">加载动画中…</div>';
          section.appendChild(grid);
          grid.innerHTML = '';
          for (const action of ACTIONS) {
            const card = await createAnimCard(asset.folderName, action, manifestImages);
            grid.appendChild(card);
          }
        });
        list.appendChild(section);
      }
    } catch {
      assetsTab.innerHTML = '<div class="mem-empty" style="color:#e66">加载失败：请确保 dev server 正在运行</div>';
    }
  }

  async function loadAssets(manifestImages: string[]): Promise<AssetInfo[]> {
    try {
      const resp = await fetch(`${API_BASE}/api/characters/assets`);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.assets)) return data.assets;
      }
    } catch { /* 后端未启动时从 manifest 兜底 */ }

    const folders = Array.from(new Set(
      manifestImages
        .filter(path => path.includes('/anim/') && path.endsWith('.png'))
        .map(path => path.split('/')[0])
        .filter(Boolean),
    )).sort();
    return folders.map(folderName => ({
      folderName,
      label: folderName,
      frameCount: manifestImages.filter(path => path.startsWith(`${folderName}/anim/`) && path.endsWith('.png')).length,
    }));
  }

  function getAssetSortRank(asset: AssetInfo): number {
    if (asset.imported) return ASSET_SORT_ORDER.imported;
    return ASSET_SORT_ORDER[asset.assetType || 'system'] ?? ASSET_SORT_ORDER.system;
  }

  function renderImportPanel(): string {
    return `
      <details class="asset-import-box">
        <summary>导入新 NPC 素材</summary>
        <div class="prompt-hint">上传 9 张横向 5 帧 PNG：每张对应一个动作，系统会裁剪白底并生成动画帧。导入后刷新页面即可在角色创建中选择。</div>
        <a class="asset-template-link icon-label-btn" href="${API_BASE}/api/characters/assets/template" download>
          <img class="ui-icon" src="/assets/ui/icons/export.png" alt="" />下载素材模板
        </a>
        <label>素材名称</label>
        <input id="asset-import-name" placeholder="例如：红发佣兵" />
        <div class="asset-bulk-row">
          <label class="asset-bulk-picker icon-label-btn">
            <img class="ui-icon" src="/assets/ui/icons/import.png" alt="" />批量选择动作图
            <input id="asset-bulk-files" type="file" accept="image/png,image/webp,image/jpeg" multiple />
          </label>
          <span id="asset-bulk-status" class="asset-bulk-status">按文件名自动匹配动作</span>
        </div>
        <div class="asset-import-grid">
          ${ACTIONS.map(action => `
            <label>${ACTION_NAMES[action]}<input type="file" accept="image/png,image/webp,image/jpeg" data-action="${action}" /><span class="asset-file-name" data-file-for="${action}">未选择</span></label>
          `).join('')}
        </div>
        <div class="btn-row">
          <button id="asset-import-submit" class="primary icon-label-btn"><img class="ui-icon" src="/assets/ui/icons/import.png" alt="" />导入素材</button>
        </div>
      </details>
    `;
  }

  function bindImportPanel() {
    const btn = assetsTab.querySelector<HTMLButtonElement>('#asset-import-submit');
    if (!btn) return;
    const importBtn = btn;
    const defaultButtonHtml = importBtn.innerHTML;
    bindActionFileInputs();
    bindBulkFileInput();

    function setImporting(isImporting: boolean) {
      importBtn.disabled = isImporting;
      importBtn.setAttribute('aria-busy', String(isImporting));
      importBtn.style.pointerEvents = isImporting ? 'none' : '';
      importBtn.innerHTML = isImporting
        ? `<img class="ui-icon" src="/assets/ui/icons/import.png" alt="" />导入中…`
        : defaultButtonHtml;
      if (!isImporting) importBtn.removeAttribute('aria-busy');
    }

    importBtn.addEventListener('click', async () => {
      if (importBtn.disabled) return;
      const status = assetsTab.querySelector<HTMLElement>('#asset-import-status');
      const name = (assetsTab.querySelector<HTMLInputElement>('#asset-import-name')?.value || '').trim();
      if (!name) {
        setImportStatus('请先填写素材名称', COLORS.error);
        return;
      }
      const form = new FormData();
      form.append('folderName', name);
      for (const action of ACTIONS) {
        const input = assetsTab.querySelector<HTMLInputElement>(`input[data-action="${action}"]`);
        const file = input?.files?.[0];
        if (!file) {
          setImportStatus(`缺少动作图：${ACTION_NAMES[action]}`, COLORS.error);
          return;
        }
        form.append(action, file);
      }

      setImportStatus('导入并裁剪中…', COLORS.loading);
      setImporting(true);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      try {
        const resp = await fetch(`${API_BASE}/api/characters/assets/import`, {
          method: 'POST',
          body: form,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || '导入失败');
        setImportStatus(data.message || '素材已导入', COLORS.success);
        bus.emit('assets:updated');
        rendered = false;
        await render(true);
      } catch (err) {
        const message = err instanceof TypeError && /fetch/i.test(err.message)
          ? '上传连接被重置：请确认后端已安装 python-multipart 并重启'
          : err instanceof Error ? err.message : '导入失败';
        setImportStatus(message, COLORS.error);
      } finally {
        setImporting(false);
      }

      function setImportStatus(text: string, color: string) {
        if (!status) return;
        status.textContent = text;
        status.style.color = color;
      }
    });
  }

  function bindActionFileInputs() {
    for (const action of ACTIONS) {
      const input = assetsTab.querySelector<HTMLInputElement>(`input[data-action="${action}"]`);
      input?.addEventListener('change', () => updateActionFileName(action));
      updateActionFileName(action);
    }
  }

  function bindBulkFileInput() {
    const input = assetsTab.querySelector<HTMLInputElement>('#asset-bulk-files');
    input?.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const result = autoFillActionFiles(files);
      input.value = '';

      const missingText = result.missing.map(action => ACTION_NAMES[action]).join('、');
      const unmatchedText = result.unmatched.slice(0, 3).join('、');
      const filledCount = ACTIONS.length - result.missing.length;
      let message = `已填入 ${filledCount}/9 个动作`;
      if (result.missing.length) message += `，缺少：${missingText}`;
      if (result.unmatched.length) message += `，未识别：${unmatchedText}${result.unmatched.length > 3 ? '…' : ''}`;
      const color = result.missing.length || result.unmatched.length ? COLORS.loading : COLORS.success;
      setBulkStatus(message, color);
      setImportStatus(message, color);
    });
  }

  function autoFillActionFiles(files: File[]) {
    const usedActions = new Set<string>();
    const matched: string[] = [];
    const unmatched: string[] = [];

    for (const file of files) {
      const action = matchActionFromFileName(file.name, usedActions);
      if (!action) {
        unmatched.push(file.name);
        continue;
      }
      if (assignFileToAction(action, file)) {
        usedActions.add(action);
        matched.push(action);
        updateActionFileName(action);
      } else {
        unmatched.push(file.name);
      }
    }

    const missing = ACTIONS.filter(action => {
      const input = assetsTab.querySelector<HTMLInputElement>(`input[data-action="${action}"]`);
      return !input?.files?.[0];
    });

    return { matched, unmatched, missing };
  }

  function matchActionFromFileName(fileName: string, usedActions: Set<string>): string | null {
    const base = normalizeFileToken(fileName.replace(/\.[^.]+$/, ''));
    let best: { action: string; score: number } | null = null;

    for (const action of ACTIONS) {
      if (usedActions.has(action)) continue;
      for (const alias of ACTION_ALIASES[action] || [action]) {
        const token = normalizeFileToken(alias);
        let score = 0;
        if (base === token) score = 1000 + token.length;
        else if (base.endsWith(token)) score = 800 + token.length;
        else if (base.includes(token)) score = 500 + token.length;
        if (score > 0 && (!best || score > best.score)) {
          best = { action, score };
        }
      }
    }

    return best?.action || null;
  }

  function normalizeFileToken(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\s_\-./\\()[\]{}【】（）]+/g, '');
  }

  function assignFileToAction(action: string, file: File): boolean {
    const input = assetsTab.querySelector<HTMLInputElement>(`input[data-action="${action}"]`);
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    return true;
  }

  function updateActionFileName(action: string) {
    const input = assetsTab.querySelector<HTMLInputElement>(`input[data-action="${action}"]`);
    const label = assetsTab.querySelector<HTMLElement>(`[data-file-for="${action}"]`);
    if (!label) return;
    const fileName = input?.files?.[0]?.name || '未选择';
    label.textContent = fileName;
    label.classList.toggle('filled', Boolean(input?.files?.[0]));
  }

  function setBulkStatus(text: string, color: string) {
    const status = assetsTab.querySelector<HTMLElement>('#asset-bulk-status');
    if (!status) return;
    status.textContent = text;
    status.style.color = color;
  }

  async function deleteAsset(asset: AssetInfo, btn: HTMLButtonElement) {
    if (!asset.imported) return;
    if (!confirm(`确定删除素材「${asset.label || asset.folderName}」吗？此操作会删除该素材的所有动画帧。`)) return;

    btn.disabled = true;
    setImportStatus(`删除素材「${asset.label || asset.folderName}」中…`, COLORS.loading);
    try {
      const resp = await fetch(`${API_BASE}/api/characters/assets?folderName=${encodeURIComponent(asset.folderName)}`, {
        method: 'DELETE',
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const detail = data.detail === 'Not Found' ? '删除接口未生效，请重启后端后再试' : data.detail;
        throw new Error(detail || '删除失败');
      }
      setImportStatus(data.message || '素材已删除', COLORS.success);
      bus.emit('assets:updated');
      rendered = false;
      await render(true);
    } catch (err) {
      btn.disabled = false;
      setImportStatus(err instanceof Error ? err.message : '删除失败', COLORS.error);
    }
  }

  async function createAnimCard(folder: string, action: string, manifest: string[]): Promise<HTMLElement> {
    const card = document.createElement('div');
    card.className = 'asset-anim-card';

    const frames: HTMLImageElement[] = [];
    for (let i = 0; i < 5; i++) {
      const path = `${folder}/anim/${folder}_${action}_${i}.png`;
      if (manifest.includes(path)) {
        try {
          frames.push(await loadImage(`assets/${path}`));
        } catch { /* 缺帧时忽略 */ }
      }
    }
    if (!frames.length) {
      card.innerHTML = `<div class="asset-missing">${ACTION_NAMES[action] || action}</div>`;
      return card;
    }

    const maxW = Math.max(...frames.map(f => f.naturalWidth));
    const maxH = Math.max(...frames.map(f => f.naturalHeight));
    const scale = Math.min(1, 80 / Math.max(maxW, maxH));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(maxW * scale));
    canvas.height = Math.max(1, Math.round(maxH * scale));
    card.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;

    let frameIdx = 0;
    let last = 0;
    function animLoop(ts: number) {
      if (ts - last >= 83) {
        last = ts;
        frameIdx = (frameIdx + 1) % frames.length;
        const f = frames[frameIdx];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (f && f.complete) ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
      }
      requestAnimationFrame(animLoop);
    }
    requestAnimationFrame(animLoop);

    const label = document.createElement('div');
    label.className = 'asset-anim-label';
    label.textContent = ACTION_NAMES[action] || action;
    card.appendChild(label);

    return card;
  }

  function setImportStatus(text: string, color: string) {
    const status = assetsTab.querySelector<HTMLElement>('#asset-import-status');
    if (!status) return;
    status.textContent = text;
    status.style.color = color;
  }

  function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
