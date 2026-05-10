import { bus } from '../utils/EventBus';
import { COLORS } from '../utils/Config';
import type { CharacterCard } from '../types';

const API_BASE = '';

interface PromptPreset {
  key: string;
  label: string;
  description: string;
  is_custom?: boolean;
}

interface AssetOption {
  folderName: string;
  label: string;
  preview: string;
}

interface CharacterResponse {
  preset_key: string;
  is_builtin: boolean;
  characters: CharacterCard[];
  assets: AssetOption[];
}

interface PromptUpdateMeta {
  presetKey?: string;
}

const APPEARANCE_LABELS: Record<string, string> = {
  core: '常驻',
  visitor: '随机访客',
  disabled: '不出场',
};

export function initCharacterManager() {
  const tab = document.getElementById('info-tab-world-edit') as HTMLElement;
  if (!tab) return;
  const charsSection = document.getElementById('world-edit-section-chars') as HTMLElement;
  if (!charsSection) return;

  let presets: PromptPreset[] = [];
  let currentPresetKey = '';
  let currentPresetLabel = '';
  let isBuiltin = true;
  let assets: AssetOption[] = [];
  let pendingPresetKey = '';

  function applyPresetMeta(presetKey: string) {
    currentPresetKey = presetKey;
    const preset = presets.find(item => item.key === currentPresetKey);
    currentPresetLabel = preset?.label || currentPresetKey || '默认风格';
    isBuiltin = !preset?.is_custom;
  }

  async function loadPromptMeta(preferredPresetKey = '') {
    const resp = await fetch(`${API_BASE}/api/settings/world-prompt`);
    if (!resp.ok) throw new Error('prompt');
    const data = await resp.json();
    presets = Array.isArray(data.presets) ? data.presets : [];
    const preferredExists = Boolean(preferredPresetKey && presets.some(item => item.key === preferredPresetKey));
    applyPresetMeta(preferredExists ? preferredPresetKey : (data.preset_key || ''));
  }

  async function refreshChars(preferredPresetKey = '') {
    try {
      charsSection.innerHTML = '<div class="mem-empty">加载角色中…</div>';
      await loadPromptMeta(preferredPresetKey);
      const resp = await fetch(`${API_BASE}/api/characters?preset_key=${encodeURIComponent(currentPresetKey)}`);
      if (!resp.ok) throw new Error('characters');
      const data: CharacterResponse = await resp.json();
      assets = Array.isArray(data.assets) ? data.assets : [];
      if (data.preset_key && data.preset_key !== currentPresetKey) {
        applyPresetMeta(data.preset_key);
      }
      isBuiltin = Boolean(data.is_builtin);
      render(data.characters || []);
    } catch {
      charsSection.innerHTML = '<div class="mem-empty">后端未连接，无法加载角色创作功能</div>';
    }
  }

  function render(characters: CharacterCard[]) {
    charsSection.innerHTML = `
      <h3>角色创作</h3>
      <div class="chars-style-box">
        <div><span>当前风格</span><strong>${esc(currentPresetLabel)}</strong></div>
        <div class="${isBuiltin ? 'readonly' : 'editable'}">${isBuiltin ? '系统内置，只读' : '自定义，可编辑'}</div>
      </div>
      ${isBuiltin ? '<div class="prompt-hint">内置风格的角色不可编辑。请先在上方 Prompt 编辑区保存为自定义风格。</div>' : ''}
      <div id="chars-status"></div>
      <div id="chars-list">${characters.map(renderCharRow).join('')}</div>
      ${isBuiltin ? '' : '<button id="chars-add-btn" style="margin-top:10px;width:100%;padding:7px 0;border:1px dashed #4a4a5a;border-radius:6px;background:transparent;color:#888;font-size:12px;cursor:pointer;transition:all 0.2s">+ 新增角色</button>'}
    `;

    charsSection.querySelectorAll<HTMLButtonElement>('.char-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const char = characters.find(c => c.key === btn.dataset.key);
        if (char) openCharModal(char);
      });
    });
    charsSection.querySelectorAll<HTMLButtonElement>('.char-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteCharacter(btn.dataset.key || ''));
    });
    const addBtn = charsSection.querySelector<HTMLButtonElement>('#chars-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => openCharModal(null));
  }

  function renderCharRow(char: CharacterCard): string {
    const key = escAttr(char.key);
    const name = esc(char.name || char.key);
    const app = char.appearance || 'core';
    const appearance = APPEARANCE_LABELS[app] || app;
    const folder = esc(char.folderName || '');
    return `<div class="char-row">
      <span class="char-name">${name}</span>
      <span class="char-chip ${app}">${appearance}</span>
      <span class="char-folder">${folder}</span>
      ${isBuiltin ? '' : `<button class="char-btn edit char-edit" data-key="${key}">编辑</button>`}
      ${isBuiltin ? '' : `<button class="char-btn del char-delete" data-key="${key}">✕</button>`}
    </div>`;
  }

  // ==== Modal dialog ====
  function openCharModal(char: CharacterCard | null) {
    const isNew = !char;
    const firstFolder = assets.length > 0 ? assets[0].folderName : '';
    const data = char || { key: '', name: '', folderName: firstFolder, appearance: 'core', personality: '', traits: [], speechStyle: '', backgroundPrompt: '', relationships: '', startX: 400, startY: 420, readOnly: false };
    const title = isNew ? '新增角色' : `编辑角色：${esc(char!.name || char!.key)}`;

    const overlay = document.createElement('div');
    overlay.className = 'char-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const box = document.createElement('div');
    box.className = 'char-modal-box';
    box.style.cssText = 'background:#14101e;border:1px solid #3d3d5c;border-radius:8px;padding:20px;max-width:520px;width:90%;max-height:85vh;overflow-y:auto;color:#e0d8c8';
    box.addEventListener('click', (e) => e.stopPropagation());

    box.innerHTML = `
      <h3 style="color:#c9a96e;margin:0 0 12px">${title}</h3>
      <label>角色 key ${isNew ? '' : '<span style="color:#666">(不可修改)</span>'}</label>
      <input id="modal-char-key" value="${escAttr(data.key)}" ${isNew ? 'placeholder="英文/数字/下划线"' : 'disabled'} />
      <label>角色名</label>
      <input id="modal-char-name" value="${escAttr(data.name || '')}" placeholder="姓名或称号" />
      <label>NPC 素材</label>
      <select id="modal-char-folder">${renderAssetOptions(data.folderName || '')}</select>
      <label>出场方式</label>
      <select id="modal-char-appearance">${renderAppearanceOptions(data.appearance || 'core')}</select>
      <label>性格简述</label>
      <textarea id="modal-char-personality" class="compact">${esc(data.personality || '')}</textarea>
      <label>特质（逗号分隔）</label>
      <input id="modal-char-traits" value="${escAttr((data.traits || []).join(', '))}" />
      <label>说话风格</label>
      <textarea id="modal-char-speech" class="compact">${esc(data.speechStyle || '')}</textarea>
      <label>角色背景提示词</label>
      <textarea id="modal-char-background" class="prompt">${esc(data.backgroundPrompt || '')}</textarea>
      <label>人物关系</label>
      <textarea id="modal-char-relationships" class="compact" placeholder="描述该角色与其他角色的关系…">${esc(data.relationships || '')}</textarea>
      <div class="char-position-row" style="display:flex;gap:8px;margin-top:8px">
        <label style="flex:1">初始 X<input id="modal-char-x" type="number" value="${data.startX ?? 400}" /></label>
        <label style="flex:1">初始 Y<input id="modal-char-y" type="number" value="${data.startY ?? 420}" /></label>
      </div>
      <div class="modal-actions">
        <button id="modal-char-cancel" class="cancel">取消</button>
        <button id="modal-char-save" class="primary">${isNew ? '创建角色' : '保存角色'}</button>
      </div>
      <div id="modal-char-status" style="margin-top:8px;font-size:11px"></div>
    `;

    const modalStatus = box.querySelector<HTMLElement>('#modal-char-status');
    if (!modalStatus) { overlay.remove(); return; }

    box.querySelector('#modal-char-cancel')?.addEventListener('click', () => overlay.remove());

    box.querySelector('#modal-char-save')?.addEventListener('click', async () => {
      const payload = {
        key: isNew ? value(box, '#modal-char-key') : data.key,
        name: value(box, '#modal-char-name'),
        folderName: value(box, '#modal-char-folder'),
        appearance: value(box, '#modal-char-appearance') || 'core',
        personality: value(box, '#modal-char-personality'),
        traits: value(box, '#modal-char-traits').split(',').map(s => s.trim()).filter(Boolean),
        speechStyle: value(box, '#modal-char-speech'),
        backgroundPrompt: value(box, '#modal-char-background'),
        relationships: value(box, '#modal-char-relationships'),
        startX: num(box, '#modal-char-x', 400),
        startY: num(box, '#modal-char-y', 420),
      };

      if (!payload.key || !payload.name || !payload.folderName) {
        modalStatus.textContent = 'key、角色名和素材必填';
        modalStatus.style.color = COLORS.error;
        return;
      }

      modalStatus.textContent = isNew ? '创建中…' : '保存中…';
      modalStatus.style.color = COLORS.loading;

      try {
        const url = isNew
          ? `${API_BASE}/api/characters?preset_key=${encodeURIComponent(currentPresetKey)}`
          : `${API_BASE}/api/characters/${encodeURIComponent(data.key)}?preset_key=${encodeURIComponent(currentPresetKey)}`;
        const resp = await fetch(url, {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ detail: '保存失败' }));
          throw new Error(err.detail || '保存失败');
        }
        overlay.remove();
        setStatus(isNew ? '角色已创建' : '角色已保存', COLORS.success);
        const savedPresetKey = currentPresetKey;
        bus.emit('characters:updated', { presetKey: savedPresetKey });
        bus.emit('prompt:updated', 'character-manager', { presetKey: savedPresetKey });
        await refreshChars(savedPresetKey);
      } catch (err) {
        modalStatus.textContent = err instanceof Error ? err.message : '保存失败';
        modalStatus.style.color = COLORS.error;
      }
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  async function deleteCharacter(key: string) {
    if (!key) return;
    if (!confirm(`删除角色 ${key}？此操作只影响当前自定义风格。`)) return;
    setStatus('删除中…', COLORS.loading);
    try {
      const resp = await fetch(`${API_BASE}/api/characters/${encodeURIComponent(key)}?preset_key=${encodeURIComponent(currentPresetKey)}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error('删除失败');
      setStatus('角色已删除', COLORS.success);
      const savedPresetKey = currentPresetKey;
      bus.emit('characters:updated', { presetKey: savedPresetKey });
      bus.emit('prompt:updated', 'character-manager', { presetKey: savedPresetKey });
      await refreshChars(savedPresetKey);
    } catch {
      setStatus('删除失败', COLORS.error);
    }
  }

  function renderAssetOptions(selected: string): string {
    return assets.map(asset => `
      <option value="${escAttr(asset.folderName)}" ${asset.folderName === selected ? 'selected' : ''}>${esc(asset.label || asset.folderName)}</option>
    `).join('');
  }

  function renderAppearanceOptions(selected: string): string {
    return Object.entries(APPEARANCE_LABELS).map(([value, label]) => `
      <option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>
    `).join('');
  }

  function value(root: HTMLElement, sel: string): string { return (root.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)?.value?.trim() || ''; }
  function num(root: HTMLElement, sel: string, fallback: number): number { const v = parseInt(value(root, sel), 10); return Number.isFinite(v) ? v : fallback; }

  function setStatus(text: string, color: string) {
    const status = charsSection.querySelector<HTMLElement>('#chars-status');
    if (!status) return;
    status.textContent = text;
    status.style.color = color;
  }

  const observer = new MutationObserver(() => {
    if (tab.classList.contains('active')) {
      const presetKey = pendingPresetKey;
      pendingPresetKey = '';
      refreshChars(presetKey);
    }
  });
  observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
  // 页面卸载时断开 observer
  window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
  bus.on('prompt:updated', (source?: string, meta?: PromptUpdateMeta) => {
    if (source === 'character-manager') return;
    pendingPresetKey = meta?.presetKey || pendingPresetKey;
    if (tab.classList.contains('active')) {
      const presetKey = pendingPresetKey;
      pendingPresetKey = '';
      refreshChars(presetKey);
    }
  });
  refreshChars();

  function esc(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s: string): string { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
}
