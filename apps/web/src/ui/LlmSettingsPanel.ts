import { COLORS } from '../utils/Config';
import { bus } from '../utils/EventBus';

const API_BASE = '';

type LlmRequestState = 'pending' | 'success' | 'error' | 'idle';

interface LlmRequestPayload {
  state: LlmRequestState;
  segment?: number;
  npcCount?: number;
  dialogueCount?: number;
  actionCount?: number;
  userGuidance?: boolean;
  topic?: string;
  message?: string;
  cache?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export function initLlmSettingsPanel() {
  const inputBaseUrl = document.getElementById('cfg-base-url') as HTMLInputElement;
  const inputApiKey = document.getElementById('cfg-api-key') as HTMLInputElement;
  const inputModel = document.getElementById('cfg-model') as HTMLInputElement;
  const inputDailyNews = document.getElementById('cfg-daily-news-guidance') as HTMLInputElement | null;
  const btnSave = document.getElementById('cfg-save')!;
  const btnTest = document.getElementById('cfg-test')!;
  const btnDailyNewsTrigger = document.getElementById('daily-news-trigger') as HTMLButtonElement | null;
  const statusEl = document.getElementById('settings-status')!;
  const dailyNewsStatusEl = document.getElementById('daily-news-guidance-status');
  const llmDot = document.getElementById('llm-dot')!;
  const requestStatusEl = document.getElementById('llm-request-status');
  let worldState: 'idle' | 'running' | 'paused' = 'idle';
  let llmRequestStartedAt = 0;
  let llmRequestPayload: LlmRequestPayload | null = null;
  let llmRequestTimer: number | null = null;
  let llmStatusHideTimer: number | null = null;

  if (!inputBaseUrl) return; // 旧 HTML，跳过

  // 初始状态显示
  if (requestStatusEl) {
    requestStatusEl.textContent = '就绪';
    requestStatusEl.className = 'llm-request-status';
  }
  (async () => {
    try {
      const r = await fetch(`${API_BASE}/api/settings/llm`);
      if (r.ok) { const d = await r.json(); setLLMStatus(d.configured ? 'ok' : 'idle'); }
    } catch { /* */ }
  })();

  btnDailyNewsTrigger?.addEventListener('click', async () => {
    if (!dailyNewsStatusEl) return;
    btnDailyNewsTrigger.disabled = true;
    dailyNewsStatusEl.textContent = '正在抓取今日新闻…';
    dailyNewsStatusEl.style.color = COLORS.loading;
    try {
      const resp = await fetch(`${API_BASE}/api/settings/daily-news-guidance/trigger`, { method: 'POST' });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        dailyNewsStatusEl.textContent = `已生成手动新闻引导，将在下一次 LLM 请求注入\n\n${data.guidance || ''}`;
        dailyNewsStatusEl.style.color = COLORS.success;
        if (worldState !== 'idle') bus.emit('world:userInput', '');
      } else {
        dailyNewsStatusEl.textContent = data.message || '手动触发失败';
        dailyNewsStatusEl.style.color = COLORS.error;
      }
    } catch {
      dailyNewsStatusEl.textContent = '后端未连接，无法手动触发新闻引导';
      dailyNewsStatusEl.style.color = COLORS.error;
    } finally {
      btnDailyNewsTrigger.disabled = false;
      void loadDailyNewsStatus();
    }
  });

  function setLLMStatus(s: 'ok' | 'err' | 'testing' | 'idle') {
    if (llmDot) {
      llmDot.className = '';
      if (s === 'testing') llmDot.classList.add('testing');
      llmDot.style.background = s === 'ok' ? '#6a9' : s === 'testing' ? '#c9a96e' : s === 'err' ? '#e66' : '#888';
    }
  }

  function formatRequestStatus(payload: LlmRequestPayload, elapsedSec = 0): string {
    const round = typeof payload.segment === 'number' ? `R${payload.segment}` : '当前轮';
    if (payload.state === 'pending') {
      const parts = [
        `LLM 请求中 ${round}`,
        typeof payload.npcCount === 'number' ? `NPC ${payload.npcCount}` : '',
        typeof payload.dialogueCount === 'number' ? `上下文 ${payload.dialogueCount} 条` : '',
        payload.userGuidance ? '含用户引导' : '',
        payload.topic ? `主题: ${payload.topic}` : '',
        `${elapsedSec}s`,
      ].filter(Boolean);
      return parts.join(' · ');
    }
    if (payload.state === 'success') {
      const cache = payload.cache;
      let cacheText = '';
      if (cache) {
        const hit = cache.prompt_cache_hit_tokens ?? 0;
        const miss = cache.prompt_cache_miss_tokens ?? 0;
        const total = hit + miss;
        const pct = total > 0 ? Math.round((hit / total) * 100) : 0;
        cacheText = `cache ${pct}% (${hit}/${total})`;
      }
      return [
        `LLM 已返回 ${round}`,
        typeof payload.actionCount === 'number' ? `行动 ${payload.actionCount}` : '',
        payload.topic ? `主题: ${payload.topic}` : '',
        cacheText,
      ].filter(Boolean).join(' · ');
    }
    if (payload.state === 'error') {
      return [`LLM 请求失败 ${round}`, payload.message || '后端或模型未返回有效计划'].filter(Boolean).join(' · ');
    }
    return '';
  }

  function clearLlmRequestTimers() {
    if (llmRequestTimer !== null) {
      window.clearInterval(llmRequestTimer);
      llmRequestTimer = null;
    }
    if (llmStatusHideTimer !== null) {
      window.clearTimeout(llmStatusHideTimer);
      llmStatusHideTimer = null;
    }
  }

  function renderLlmRequestStatus(payload: LlmRequestPayload) {
    if (!requestStatusEl) return;
    clearLlmRequestTimers();
    llmRequestPayload = payload;
    requestStatusEl.className = 'llm-request-status';

    if (payload.state === 'idle') {
      requestStatusEl.textContent = '就绪';
      setLLMStatus('idle');
      return;
    }

    requestStatusEl.classList.add('active');
    requestStatusEl.classList.add(payload.state === 'pending' ? 'busy' : payload.state === 'success' ? 'ok' : 'err');

    if (payload.state === 'pending') {
      llmRequestStartedAt = Date.now();
      setLLMStatus('testing');
      const update = () => {
        const elapsedSec = Math.max(0, Math.floor((Date.now() - llmRequestStartedAt) / 1000));
        requestStatusEl.textContent = formatRequestStatus(llmRequestPayload || payload, elapsedSec);
      };
      update();
      llmRequestTimer = window.setInterval(update, 1000);
      return;
    }

    requestStatusEl.textContent = formatRequestStatus(payload);
    setLLMStatus(payload.state === 'success' ? 'ok' : 'err');
    if (payload.state === 'success') {
      llmStatusHideTimer = window.setTimeout(() => {
        requestStatusEl.className = 'llm-request-status';
        requestStatusEl.textContent = '就绪';
        setLLMStatus('idle');
      }, 6000);
    }
  }

  async function saveLlmSettings(): Promise<boolean> {
    const resp = await fetch(`${API_BASE}/api/settings/llm`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: inputBaseUrl.value.trim(),
        api_key: inputApiKey.value.trim(),
        model: inputModel.value.trim(),
        daily_news_guidance_enabled: Boolean(inputDailyNews?.checked),
      }),
    });
    return resp.ok;
  }

  bus.on('world:state', (payload: { state?: 'idle' | 'running' | 'paused' }) => {
    if (payload?.state) worldState = payload.state;
  });

  bus.on('llm:request', (payload: LlmRequestPayload) => {
    renderLlmRequestStatus(payload);
  });

  btnSave.addEventListener('click', async () => {
    statusEl.textContent = '保存中…';
    statusEl.style.color = COLORS.loading;
    try {
      if (await saveLlmSettings()) {
        statusEl.textContent = '已保存！';
        statusEl.style.color = COLORS.success;
        void loadDailyNewsStatus();
      } else {
        statusEl.textContent = '保存失败';
        statusEl.style.color = COLORS.error;
      }
    } catch {
      statusEl.textContent = '后端未连接';
      statusEl.style.color = COLORS.error;
    }
  });

  btnTest.addEventListener('click', async () => {
    statusEl.textContent = '保存配置用于测试…';
    statusEl.style.color = COLORS.loading;
    btnTest.setAttribute('disabled', '');
    setLLMStatus('testing');
    try {
      const saved = await saveLlmSettings();
      if (!saved) {
        statusEl.textContent = '保存失败，未执行测试';
        statusEl.style.color = COLORS.error;
        setLLMStatus('err');
        return;
      }
      statusEl.textContent = '已保存，测试中…';
      const resp = await fetch(`${API_BASE}/api/settings/llm/test`, { method: 'POST' });
      const data = await resp.json();
      if (data.ok) {
        statusEl.textContent = data.message;
        statusEl.style.color = COLORS.success;
        setLLMStatus('ok');
      } else {
        statusEl.textContent = data.message;
        statusEl.style.color = COLORS.error;
        setLLMStatus('err');
      }
    } catch {
      statusEl.textContent = '后端未连接';
      statusEl.style.color = COLORS.error;
      setLLMStatus('err');
    } finally {
      btnTest.removeAttribute('disabled');
    }
  });

  async function loadSettings() {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/llm`);
      if (resp.ok) {
        const data = await resp.json();
        inputBaseUrl.value = data.base_url || '';
        inputApiKey.value = '';
        inputModel.value = data.model || '';
        if (inputDailyNews) inputDailyNews.checked = Boolean(data.daily_news_guidance_enabled);
        statusEl.textContent = data.configured ? '当前已配置' : '使用默认配置';
        statusEl.style.color = data.configured ? COLORS.success : COLORS.muted;
      }
    } catch {
      statusEl.textContent = '后端未连接，将使用默认配置';
      statusEl.style.color = COLORS.muted;
    }
  }

  async function loadDailyNewsStatus() {
    if (!dailyNewsStatusEl) return;
    try {
      const resp = await fetch(`${API_BASE}/api/settings/daily-news-guidance`);
      if (!resp.ok) throw new Error(String(resp.status));
      const data = await resp.json();
      const segment = typeof data.segment === 'number' ? `R${data.segment}` : '未记录';
      if (data.pending_manual) {
        dailyNewsStatusEl.textContent = `已有手动新闻引导待发送\n生成时间：${data.pending_manual_created_at || '未记录'}\n\n${data.pending_manual_guidance || '(无内容记录)'}`;
        dailyNewsStatusEl.style.color = COLORS.loading;
        return;
      }
      dailyNewsStatusEl.textContent = data.sent_today
        ? `今日已发送新闻引导\n发送轮次：${segment}\n发送时间：${data.last_injected_at || '未记录'}\n\n${data.guidance || '(无内容记录)'}`
        : `今日尚未发送新闻引导\n今天日期：${data.today || '未知'}\n上次发送：${data.last_injected_date || '无'}`;
      dailyNewsStatusEl.style.color = data.sent_today ? COLORS.success : COLORS.muted;
    } catch {
      dailyNewsStatusEl.textContent = '今日新闻引导状态读取失败';
      dailyNewsStatusEl.style.color = COLORS.error;
    }
  }

  // 切换到设置 Tab 时加载
  const tab = document.getElementById('info-tab-settings')!;
  const observer = new MutationObserver(() => {
    if (tab.classList.contains('active')) {
      loadSettings();
      loadDailyNewsStatus();
    }
  });
  observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
  // 初始加载
  loadSettings();
  loadDailyNewsStatus();

  // 页面加载时自动测一次 LLM
  setTimeout(() => setLLMStatus('testing'), 2000);
  setTimeout(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/llm/test`, { method: 'POST' });
      const data = await resp.json();
      setLLMStatus(data.ok ? 'ok' : 'err');
    } catch { setLLMStatus('err'); }
  }, 3000);
}
