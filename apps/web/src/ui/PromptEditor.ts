import { COLORS } from '../utils/Config';
import { bus } from '../utils/EventBus';

const API_BASE = '';

interface PromptPreset {
  key: string;
  label: string;
  description: string;
  story_background: string;
  story_theme: string;
  is_custom?: boolean;
}

interface PromptResponse {
  ok?: boolean;
  message?: string;
  preset_key: string;
  presets: PromptPreset[];
  story_background: string;
  story_theme: string;
  system_prompt: string;
  user_prompt: string;
  calendar_start: string;
  character_overrides: Record<string, string>;
  relationship_prompt: string;
  is_custom?: boolean;
}

const CHAR_NAMES: Record<string, string> = {
  mysterious: '神秘客',
  warrior: '勇士',
  bartender: '酒保',
  witch: '女巫',
};

export function initPromptEditor() {
  const promptPresetEl = document.getElementById('prompt-preset') as HTMLSelectElement;
  const promptCalendarEl = document.getElementById('prompt-calendar-start') as HTMLInputElement;
  const promptStoryBgEl = document.getElementById('prompt-story-background') as HTMLTextAreaElement;
  const promptStoryThemeEl = document.getElementById('prompt-story-theme') as HTMLTextAreaElement;
  const promptSysEl = document.getElementById('prompt-sys-prompt') as HTMLTextAreaElement;
  const promptUsrEl = document.getElementById('prompt-usr-prompt') as HTMLTextAreaElement;
  const promptSaveBtn = document.getElementById('prompt-save')!;
  const promptStatusEl = document.getElementById('prompt-status')!;
  const charContainer = document.getElementById('prompt-char-overrides');

  if (!promptSysEl || !promptStoryBgEl || !promptStoryThemeEl || !promptPresetEl) return;

  let presets: PromptPreset[] = [];
  let currentPresetKey = '';
  let currentCharKeys: string[] = [];
  let isApplyingPromptData = false;
  let isDirty = false;
  let presetSwitchPromise: Promise<void> | null = null;
  let presetSwitchToken = 0;

  function emitPromptUpdated() {
    bus.emit('prompt:updated', 'prompt-editor', { presetKey: currentPresetKey });
  }

  async function requestJson<T extends { ok?: boolean; message?: string; detail?: string }>(url: string, options?: RequestInit): Promise<T> {
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      const detail = typeof data?.detail === 'string' ? data.detail : data?.message;
      throw new Error(detail || `请求失败 (${resp.status})`);
    }
    return data as T;
  }

  function markDirtyAndPreview() {
    if (!isApplyingPromptData) isDirty = true;
    schedulePreviewUpdate();
  }

  function renderCharOverrides(overrides: Record<string, string>) {
    if (!charContainer) return;
    charContainer.innerHTML = '';

    // 从 overrides 获取角色列表；空对象时显示全部默认角色
    const keys = Object.keys(overrides).length > 0
      ? Object.keys(overrides)
      : ['mysterious', 'warrior', 'bartender', 'witch'];
    currentCharKeys = keys;

    for (const key of keys) {
      const label = CHAR_NAMES[key] || key;
      const details = document.createElement('details');
      details.style.cssText = 'margin-bottom:6px;';
      details.innerHTML = `<summary style="cursor:pointer;color:#b0a090;font-size:12px;">${label}${key === 'bartender' ? '（必要角色）' : ''}</summary>`;
      const textarea = document.createElement('textarea');
      textarea.id = `prompt-char-${key}`;
      textarea.placeholder = `留空使用默认${label}设定…`;
      textarea.style.cssText = 'min-height:80px;';
      textarea.value = overrides[key] || '';
      textarea.addEventListener('input', markDirtyAndPreview);
      details.appendChild(textarea);
      charContainer.appendChild(details);
    }
  }

  function collectCharOverrides(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of currentCharKeys) {
      const el = document.getElementById(`prompt-char-${key}`) as HTMLTextAreaElement;
      if (el && el.value.trim()) result[key] = el.value.trim();
    }
    return result;
  }

  function renderPresets(selectedKey: string) {
    promptPresetEl.innerHTML = '';
    const actualSelectedKey = presets.some(preset => preset.key === selectedKey)
      ? selectedKey
      : (presets[0]?.key || '');

    const builtinOptions = presets.filter(p => !p.is_custom);
    const customOptions = presets.filter(p => p.is_custom);

    if (builtinOptions.length) {
      const g = document.createElement('optgroup');
      g.label = '内置风格';
      builtinOptions.forEach(p => {
        const o = document.createElement('option');
        o.value = p.key; o.textContent = `${p.label} - ${p.description}`;
        o.selected = p.key === actualSelectedKey; g.appendChild(o);
      });
      promptPresetEl.appendChild(g);
    }
    if (customOptions.length) {
      const g = document.createElement('optgroup');
      g.label = '自定义风格';
      customOptions.forEach(p => {
        const o = document.createElement('option');
        o.value = p.key; o.textContent = `${p.label} - ${p.description}`;
        o.selected = p.key === actualSelectedKey; g.appendChild(o);
      });
      promptPresetEl.appendChild(g);
    }
    promptPresetEl.value = actualSelectedKey;
    currentPresetKey = actualSelectedKey;
  }

  function updatePresetControls() {
    const currentPreset = presets.find(p => p.key === currentPresetKey);
    const deleteBtn = document.getElementById('prompt-delete-preset');
    const renameBtn = document.getElementById('prompt-rename-preset');
    if (deleteBtn) {
      deleteBtn.style.display = currentPreset?.is_custom ? '' : 'none';
    }
    if (renameBtn) {
      renameBtn.style.display = currentPreset?.is_custom ? '' : 'none';
    }
  }

  let previewTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePreviewUpdate() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 400);
  }

  async function updatePreview() {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/world-prompt/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset_key: currentPresetKey,
          story_background: promptStoryBgEl.value,
          story_theme: promptStoryThemeEl.value,
          user_prompt: promptUsrEl.value,
          character_overrides: collectCharOverrides(),
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        promptSysEl.value = data.system_prompt || '';
      }
    } catch { /* 后端未启动 */ }
  }

  function applyPromptData(data: PromptResponse, dirty = false) {
    isApplyingPromptData = true;
    presets = Array.isArray(data.presets) ? data.presets : [];
    renderPresets(data.preset_key || presets[0]?.key || '');
    promptStoryBgEl.value = data.story_background || '';
    promptStoryThemeEl.value = data.story_theme || '';
    promptSysEl.value = data.system_prompt || '';
    promptUsrEl.value = data.user_prompt || '';
    promptCalendarEl.value = data.calendar_start || '1500-01-01';
    renderCharOverrides(data.character_overrides || {});

    updatePresetControls();
    isDirty = dirty;
    isApplyingPromptData = false;
  }

  // 实时预览：编辑字段时触发
  [promptStoryBgEl, promptStoryThemeEl, promptUsrEl].forEach(el => {
    if (el) el.addEventListener('input', markDirtyAndPreview);
  });
  promptCalendarEl?.addEventListener('change', markDirtyAndPreview);
  // 角色覆盖 textarea 是动态创建的，在 renderCharOverrides 中绑定

  async function loadPrompt() {
    try {
      const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt`);
      applyPromptData(data);
      const preset = presets.find(item => item.key === currentPresetKey);
      promptStatusEl.textContent = preset?.is_custom
        ? `已加载自定义风格「${preset.label}」`
        : `当前使用内置风格「${preset?.label || currentPresetKey}」`;
      promptStatusEl.style.color = preset?.is_custom ? COLORS.success : COLORS.muted;
    } catch {
      promptStatusEl.textContent = '后端未连接';
      promptStatusEl.style.color = COLORS.error;
    }
  }

  promptPresetEl.addEventListener('change', () => {
    const newKey = promptPresetEl.value;
    const preset = presets.find(item => item.key === newKey);
    if (!preset) return;
    const previousKey = currentPresetKey;
    if (isDirty && !confirm('当前风格有未保存修改，切换后会丢失。仍然切换吗？')) {
      promptPresetEl.value = previousKey;
      return;
    }
    currentPresetKey = newKey;
    updatePresetControls();

    const token = ++presetSwitchToken;
    presetSwitchPromise = (async () => {
      try {
        const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset_key: newKey }),
        });
        if (token !== presetSwitchToken) return;
        applyPromptData(data);
        const appliedPreset = presets.find(item => item.key === currentPresetKey) || preset;
        promptStatusEl.textContent = appliedPreset.is_custom
          ? `已切换到自定义风格「${appliedPreset.label}」`
          : `已切换到「${appliedPreset.label}」风格`;
        promptStatusEl.style.color = COLORS.success;
        emitPromptUpdated();
      } catch (err) {
        if (token !== presetSwitchToken) return;
        currentPresetKey = previousKey;
        renderPresets(previousKey);
        updatePresetControls();
        promptStatusEl.textContent = err instanceof Error ? err.message : '切换风格失败';
        promptStatusEl.style.color = COLORS.error;
      } finally {
        if (token === presetSwitchToken) presetSwitchPromise = null;
      }
    })();
  });

  function collectPromptDraft() {
    return {
      story_background: promptStoryBgEl.value,
      story_theme: promptStoryThemeEl.value,
      user_prompt: promptUsrEl.value,
      calendar_start: promptCalendarEl.value,
      character_overrides: collectCharOverrides(),
    };
  }

  promptSaveBtn.addEventListener('click', async () => {
    if (presetSwitchPromise) {
      promptStatusEl.textContent = '等待风格切换完成…';
      promptStatusEl.style.color = COLORS.loading;
      await presetSwitchPromise;
    }

    const currentPreset = presets.find(p => p.key === currentPresetKey);
    const isBuiltin = !currentPreset?.is_custom;
    const draft = collectPromptDraft();

    if (isBuiltin) {
      const label = prompt('请输入自定义风格名称（如：我的酒馆风格）：');
      if (!label || !label.trim()) return;
      const key = `custom_${Date.now().toString(36)}`;

      promptStatusEl.textContent = '保存新风格中…';
      promptStatusEl.style.color = COLORS.loading;
      try {
        const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt/presets`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key,
            label: label.trim(),
            description: '用户自定义风格',
            base_preset_key: currentPresetKey,
            ...draft,
          }),
        });
        applyPromptData(data);
        promptStatusEl.textContent = data.message || `已保存为新风格「${label.trim()}」并自动切换`;
        promptStatusEl.style.color = COLORS.success;
        emitPromptUpdated();
      } catch (err) {
        promptStatusEl.textContent = err instanceof Error ? err.message : '后端未连接';
        promptStatusEl.style.color = COLORS.error;
      }
    } else {
      promptStatusEl.textContent = '保存中…';
      promptStatusEl.style.color = COLORS.loading;
      try {
        const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt/presets/${currentPresetKey}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: currentPreset?.label,
            ...draft,
          }),
        });
        applyPromptData(data);
        promptStatusEl.textContent = data.message || `已更新自定义风格「${currentPreset?.label}」`;
        promptStatusEl.style.color = COLORS.success;
        emitPromptUpdated();
      } catch (err) {
        promptStatusEl.textContent = err instanceof Error ? err.message : '后端未连接';
        promptStatusEl.style.color = COLORS.error;
      }
    }
  });

  const deleteBtn = document.getElementById('prompt-delete-preset');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const currentPreset = presets.find(p => p.key === currentPresetKey);
      if (!currentPreset?.is_custom) {
        promptStatusEl.textContent = '内置风格不可删除';
        promptStatusEl.style.color = COLORS.error;
        return;
      }
      if (!confirm(`确定删除自定义风格「${currentPreset.label}」吗？此操作不可撤销。`)) return;

      try {
        const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt/presets/${currentPresetKey}`, {
          method: 'DELETE',
        });
        applyPromptData(data);
        promptStatusEl.textContent = data.message || `已删除风格「${currentPreset.label}」`;
        promptStatusEl.style.color = COLORS.success;
        emitPromptUpdated();
      } catch (err) {
        promptStatusEl.textContent = err instanceof Error ? err.message : '后端未连接';
        promptStatusEl.style.color = COLORS.error;
      }
    });
  }

  // 重命名
  const renameBtn = document.getElementById('prompt-rename-preset');
  if (renameBtn) {
    renameBtn.addEventListener('click', async () => {
      const currentPreset = presets.find(p => p.key === currentPresetKey);
      if (!currentPreset?.is_custom) {
        promptStatusEl.textContent = '内置风格不可重命名';
        promptStatusEl.style.color = COLORS.error;
        return;
      }
      const newLabel = prompt('请输入新名称：', currentPreset.label);
      if (!newLabel || !newLabel.trim() || newLabel.trim() === currentPreset.label) return;

      try {
        const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt/presets/${currentPresetKey}/rename`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel.trim() }),
        });
        currentPreset.label = newLabel.trim();
        renderPresets(currentPresetKey);
        updatePresetControls();
        promptStatusEl.textContent = data.message || `已重命名为「${newLabel.trim()}」`;
        promptStatusEl.style.color = COLORS.success;
        emitPromptUpdated();
      } catch (err) {
        promptStatusEl.textContent = err instanceof Error ? err.message : '重命名失败';
        promptStatusEl.style.color = COLORS.error;
      }
    });
  }

  // 导出
  const exportBtn = document.getElementById('prompt-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/settings/world-prompt/export`);
        if (!resp.ok) { promptStatusEl.textContent = '导出失败'; promptStatusEl.style.color = COLORS.error; return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'pixel_tavern_world_edit.zip';
        a.click();
        URL.revokeObjectURL(url);
        promptStatusEl.textContent = '已导出世界编辑数据（含自定义素材）';
        promptStatusEl.style.color = COLORS.success;
      } catch {
        promptStatusEl.textContent = '导出失败';
        promptStatusEl.style.color = COLORS.error;
      }
    });
  }

  // 导入
  const importBtn = document.getElementById('prompt-import');
  const importFile = document.getElementById('prompt-import-file') as HTMLInputElement;
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      if (!confirm(`确定导入「${file.name}」吗？当前世界编辑配置将被覆盖。`)) { importFile.value = ''; return; }
      try {
        promptStatusEl.textContent = '导入中…';
        promptStatusEl.style.color = COLORS.loading;
        const formData = new FormData();
        formData.append('file', file);
        const resp = await fetch(`${API_BASE}/api/settings/world-prompt/import`, {
          method: 'POST',
          body: formData,
        });
        const result = await resp.json().catch(() => ({ ok: false, message: '导入失败' }));
        if (result.ok) {
          if (result.conflicts && result.conflicts.length > 0) {
            promptStatusEl.textContent = result.message;
            promptStatusEl.style.color = '#e8a040';
          } else {
            promptStatusEl.textContent = result.message || '世界编辑数据已导入';
            promptStatusEl.style.color = COLORS.success;
          }
          try { await loadPrompt(); } catch { /* load 失败不覆盖导入成功提示 */ }
          emitPromptUpdated();
        } else {
          promptStatusEl.textContent = result.message || '导入失败';
          promptStatusEl.style.color = COLORS.error;
        }
      } catch {
        promptStatusEl.textContent = '导入失败：网络错误或文件损坏';
        promptStatusEl.style.color = COLORS.error;
      }
      importFile.value = '';
    });
  }

  // 新增空白自定义风格
  const newPresetBtn = document.getElementById('prompt-new-preset');
  if (newPresetBtn) {
    newPresetBtn.addEventListener('click', async () => {
      const label = prompt('请输入新风格名称：', '我的自定义风格');
      if (!label || !label.trim()) return;
      const key = `custom_${Date.now().toString(36)}`;
      promptStatusEl.textContent = '创建空白风格中…';
      promptStatusEl.style.color = COLORS.loading;
      try {
        const data = await requestJson<PromptResponse>(`${API_BASE}/api/settings/world-prompt/presets`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key,
            label: label.trim(),
            description: '用户自定义风格',
            base_preset_key: currentPresetKey,
            story_background: '',
            story_theme: '',
            user_prompt: '{tick}\n{states}\n可用椅子: {available}{extra}',
            calendar_start: promptCalendarEl.value || '1500-01-01',
            characters: [],
          }),
        });
        applyPromptData(data);
        promptStatusEl.textContent = `已创建空白风格「${label.trim()}」`;
        promptStatusEl.style.color = COLORS.success;
        emitPromptUpdated();
      } catch (err) {
        promptStatusEl.textContent = err instanceof Error ? err.message : '创建风格失败';
        promptStatusEl.style.color = COLORS.error;
      }
    });
  }

  const tab = document.getElementById('info-tab-world-edit')!;
  const observer = new MutationObserver(() => {
    if (tab.classList.contains('active')) loadPrompt();
  });
  observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
  bus.on('prompt:updated', (source?: string) => {
    if (source === 'prompt-editor') return;
    // 角色变更时无论 tab 是否激活都要刷新，确保 System Prompt 与角色同步
    if (source === 'character-manager' || tab.classList.contains('active')) {
      loadPrompt();
    }
  });
  loadPrompt();
}
