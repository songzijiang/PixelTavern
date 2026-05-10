const BGM_PATH = '/assets/audio/bgm.mp3';
const STORAGE_KEY = 'pixeltavern:bgm';

interface BgmState {
  volume: number;
  muted: boolean;
}

let bgmAudio: HTMLAudioElement | null = null;

function getAudio(): HTMLAudioElement {
  if (!bgmAudio) {
    bgmAudio = new Audio(BGM_PATH);
    bgmAudio.loop = true;
    bgmAudio.preload = 'auto';
  }
  return bgmAudio;
}

function loadState(): BgmState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        volume: typeof parsed.volume === 'number' ? parsed.volume : 50,
        muted: !!parsed.muted,
      };
    }
  } catch { /* ignore */ }
  return { volume: 50, muted: false };
}

function saveState(state: BgmState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function applyVolume(state: BgmState) {
  const audio = getAudio();
  audio.volume = state.muted ? 0 : state.volume / 100;
}

export function startBgm() {
  const audio = getAudio();
  const state = loadState();
  applyVolume(state);
  audio.play().catch(() => {
    // 浏览器可能阻止自动播放，用户首次交互后恢复
    const resume = () => {
      audio.play().catch(() => {});
      document.removeEventListener('click', resume);
      document.removeEventListener('keydown', resume);
    };
    document.addEventListener('click', resume);
    document.addEventListener('keydown', resume);
  });
}

export function initBgmSettings() {
  const tab = document.getElementById('info-tab-settings');
  if (!tab) return;

  // 在 tab 内构建 BGM 设置 UI
  const section = document.createElement('div');
  section.id = 'bgm-section';
  section.innerHTML = `
    <h2>设置</h2>
    <div class="bgm-block">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <img class="ui-icon" src="/assets/ui/icons/status.png" alt="" style="width:16px;height:16px;" />
        <span style="color:#c9a96e;font-size:13px;font-weight:600;">背景音乐</span>
        <span style="color:#6a8;font-size:11px;">— 月下药草</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(201,169,110,0.06);border:1px solid rgba(201,169,110,0.18);border-radius:4px;">
        <button id="bgm-play-btn" class="icon-label-btn" title="播放 / 暂停" style="padding:4px 10px;border:1px solid #5a6a5a;border-radius:3px;background:rgba(90,140,90,0.15);color:#8db8a0;cursor:pointer;font-size:12px;">
          <img class="ui-icon" src="/assets/ui/icons/pause.png" alt="" style="width:12px;height:12px;" /><span id="bgm-play-label">暂停</span>
        </button>
        <span style="color:#4a4a4a;">|</span>
        <button id="bgm-mute-btn" class="icon-label-btn" title="静音切换" style="padding:4px 10px;border:1px solid #5a5a5a;border-radius:3px;background:rgba(100,100,100,0.12);color:#a0a0a0;cursor:pointer;font-size:12px;">
          <span id="bgm-mute-label">静音</span>
        </button>
        <span style="color:#4a4a4a;">|</span>
        <label style="color:#b0a090;font-size:11px;">音量</label>
        <input type="range" id="bgm-volume-slider" min="0" max="100" value="50" style="width:100px;accent-color:#c9a96e;height:4px;" />
        <span id="bgm-volume-label" style="color:#c9a96e;font-size:12px;min-width:36px;text-align:right;">50%</span>
      </div>
    </div>
  `;

  // 替换 tab 内容
  tab.innerHTML = '';
  tab.appendChild(section);

  const playBtn = document.getElementById('bgm-play-btn') as HTMLButtonElement;
  const playLabel = document.getElementById('bgm-play-label')!;
  const playIcon = playBtn?.querySelector('img') as HTMLImageElement;
  const muteBtn = document.getElementById('bgm-mute-btn') as HTMLButtonElement;
  const muteLabel = document.getElementById('bgm-mute-label')!;
  const volumeSlider = document.getElementById('bgm-volume-slider') as HTMLInputElement;
  const volumeLabel = document.getElementById('bgm-volume-label')!;

  const state = loadState();
  let playing = true;
  volumeSlider.value = String(state.volume);
  volumeLabel.textContent = `${state.volume}%`;

  function updateUI() {
    if (playing) {
      playLabel.textContent = '暂停';
      if (playIcon) { playIcon.src = '/assets/ui/icons/pause.png'; }
      playBtn.style.borderColor = '#5a6a5a';
      playBtn.style.background = 'rgba(90,140,90,0.15)';
      playBtn.style.color = '#8db8a0';
    } else {
      playLabel.textContent = '播放';
      if (playIcon) { playIcon.src = '/assets/ui/icons/play.png'; }
      playBtn.style.borderColor = '#6a5a3a';
      playBtn.style.background = 'rgba(180,150,60,0.12)';
      playBtn.style.color = '#c9a96e';
    }
    if (state.muted) {
      muteLabel.textContent = '取消静音';
      muteBtn.style.color = '#e07060';
      muteBtn.style.borderColor = '#6a4a4a';
    } else {
      muteLabel.textContent = '静音';
      muteBtn.style.color = '#a0a0a0';
      muteBtn.style.borderColor = '#5a5a5a';
    }
    volumeSlider.value = String(state.volume);
    volumeLabel.textContent = `${state.volume}%`;
  }

  updateUI();

  playBtn.addEventListener('click', () => {
    const audio = getAudio();
    if (playing) {
      audio.pause();
      playing = false;
    } else {
      audio.play().catch(() => {});
      playing = true;
    }
    // 只有正在播放时保存 playing 状态
    updateUI();
  });

  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    applyVolume(state);
    saveState(state);
    updateUI();
  });

  volumeSlider.addEventListener('input', () => {
    state.volume = parseInt(volumeSlider.value, 10);
    applyVolume(state);
    saveState(state);
    updateUI();
  });

  // tab 激活时刷新
  const observer = new MutationObserver(() => {
    if (tab.classList.contains('active')) {
      updateUI();
    }
  });
  observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
}
