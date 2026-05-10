import Phaser from 'phaser';
import { gameConfig } from './config';

import { initLlmSettingsPanel } from './ui/LlmSettingsPanel';
import { initPromptEditor } from './ui/PromptEditor';
import { initCharacterManager } from './ui/CharacterManager';
import { initInfoPanel } from './ui/InfoPanel';
import { initWorldControlBar } from './ui/WorldControlBar';
import { initUserInputBar } from './ui/UserInputBar';
import { initAnimationPreview } from './ui/AnimationPreview';
import { initBgmSettings } from './ui/BgmSettings';
import { sfxClick, sfxTab, sfxToggle } from './utils/Sfx';

const EXPERIMENTAL_KEY = 'pixeltavern:experimental';

function isExperimentalEnabled(): boolean {
  return localStorage.getItem(EXPERIMENTAL_KEY) === '1';
}

function applyExperimentalMode() {
  const on = isExperimentalEnabled();
  const sceneBtn = document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="scene-edit"]');
  if (sceneBtn) sceneBtn.style.display = on ? '' : 'none';
}

function initExperimentalToggle() {
  const toggle = document.getElementById('experimental-toggle') as HTMLInputElement | null;
  const notice = document.getElementById('experimental-notice');
  const safetySection = document.getElementById('experimental-safety-section');
  const safetyPrompt = document.getElementById('experimental-safety-prompt') as HTMLTextAreaElement | null;
  const safetySave = document.getElementById('experimental-safety-save');
  const safetyStatus = document.getElementById('experimental-safety-status');

  if (!toggle) return;

  // 恢复状态
  const on = isExperimentalEnabled();
  toggle.checked = on;
  if (notice) notice.style.display = on ? '' : 'none';
  if (safetySection) safetySection.style.display = on ? '' : 'none';
  applyExperimentalMode();

  // 加载安全提示词
  if (on && safetyPrompt) {
    fetch('/api/settings/safety-prompt').then(r => r.json()).then(d => {
      if (safetyPrompt) safetyPrompt.value = d.prompt || '';
    }).catch(() => {});
  }

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    localStorage.setItem(EXPERIMENTAL_KEY, enabled ? '1' : '0');
    if (notice) notice.style.display = enabled ? '' : 'none';
    if (safetySection) safetySection.style.display = enabled ? '' : 'none';
    applyExperimentalMode();

    if (enabled && safetyPrompt) {
      fetch('/api/settings/safety-prompt').then(r => r.json()).then(d => {
        if (safetyPrompt) safetyPrompt.value = d.prompt || '';
      }).catch(() => {});
    }
    if (!enabled) {
      // 关闭实验功能时清除自定义安全审核词，回退到系统默认
      fetch('/api/settings/safety-prompt', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '' }),
      }).catch(() => {});
    }
  });

  safetySave?.addEventListener('click', async () => {
    if (!safetyPrompt || !safetyStatus) return;
    try {
      const r = await fetch('/api/settings/safety-prompt', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: safetyPrompt.value }),
      });
      if (r.ok) { safetyStatus.textContent = '已保存'; safetyStatus.style.color = '#6a9'; }
      else { safetyStatus.textContent = '保存失败'; safetyStatus.style.color = '#e66'; }
    } catch { safetyStatus.textContent = '保存失败'; safetyStatus.style.color = '#e66'; }
  });
}

function initApp() {
  new Phaser.Game(gameConfig);

  initExperimentalToggle();
  initLlmSettingsPanel();
  initPromptEditor();
  initCharacterManager();
  initInfoPanel();
  initWorldControlBar();
  initUserInputBar();
  initAnimationPreview();
  initBgmSettings();

  // 全局 UI 音效委托
  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const role = el.getAttribute('role');
    if (el.tagName === 'BUTTON' || role === 'button' || el.closest('button')) {
      const btn = el.closest('button') || el;
      if (btn.getAttribute('role') === 'switch' || (btn as HTMLInputElement).type === 'checkbox') {
        sfxToggle();
      } else {
        sfxClick();
      }
    } else if (el.closest('.tab-btn')) {
      sfxTab();
    }
  });
}

// 首次运行免责声明（后端标记文件检测）
async function checkDisclaimer() {
  try {
    const resp = await fetch('/api/admin/first-run');
    const data = await resp.json();
    if (!data.firstRun) {
      initApp();
      return;
    }
  } catch {
    // 后端不可达时直接启动
    initApp();
    return;
  }

  const overlay = document.getElementById('disclaimer-overlay');
  const agreeBtn = document.getElementById('disclaimer-agree');
  if (!overlay || !agreeBtn) {
    initApp();
    return;
  }

  overlay.classList.remove('hidden');
  agreeBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/disclaimer-accept', { method: 'POST' });
    } catch {
      // 后端不可达不影响前端启动
    }
    overlay.classList.add('hidden');
    initApp();
  });
}

checkDisclaimer();
