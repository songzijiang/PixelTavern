import { bus } from '../utils/EventBus';
import { CALENDAR_START, SEGMENT_LENGTH, STATE_POLL_MS } from '../utils/Config';

const API_BASE = '';
const DEFAULT_ROUNDS = 6;
const ROUNDS_PER_DAY = 6;
const ICON = '/assets/ui/icons';

interface WorldStateData {
  state: string; tick: number; elapsed: number; bufferedUntil: number; topic: string; calendar_start?: string;
}

export function initWorldControlBar() {
  const durInput = document.getElementById('world-duration') as HTMLInputElement;
  const labelEl = durInput?.previousElementSibling;
  const btnStart = document.getElementById('world-start')!;
  const btnPause = document.getElementById('world-pause')!;
  const btnStop = document.getElementById('world-stop')!;
  const btnLatest = document.getElementById('world-latest')!;
  const roundDisplay = document.getElementById('world-round')!;
  const timeDisplay = document.getElementById('world-time')!;
  const topicDisplay = document.getElementById('world-topic')!;
  const calDisplay = document.getElementById('world-calendar')!;

  if (labelEl) labelEl.textContent = '轮数';
  durInput.value = String(DEFAULT_ROUNDS);

  btnPause.setAttribute('disabled', '');
  btnStop.setAttribute('disabled', '');

  let currentState: WorldStateData = { state: 'idle', tick: 0, elapsed: 0, bufferedUntil: -1, topic: '' };
  let remainingRounds = DEFAULT_ROUNDS;
  let currentRound = 0;
  let latestStoredRound = -1;
  let prevState = 'idle';
  let calendarStart = CALENDAR_START;

  function setPauseButton(label: '暂停' | '继续') {
    const icon = label === '暂停' ? 'pause' : 'play';
    btnPause.innerHTML = `<img class="ui-icon" src="${ICON}/${icon}.png" alt="" />${label}`;
  }

  bus.on('world:state', (st: WorldStateData) => {
    currentState = st;
    if (st.calendar_start) calendarStart = st.calendar_start;
  });

  async function loadCalendarStart() {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/world-prompt`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (typeof data.calendar_start === 'string' && data.calendar_start) {
        calendarStart = data.calendar_start;
      }
    } catch { /* 后端未启动时保留默认日期 */ }
  }

  bus.on('prompt:updated', () => {
    void loadCalendarStart();
  });

  bus.on('round:changed', (info: { currentRound: number; latestStoredRound: number }) => {
    currentRound = info.currentRound;
    latestStoredRound = info.latestStoredRound;
    const isLatest = currentRound > latestStoredRound;
    roundDisplay.textContent = isLatest
      ? `R${currentRound}*`
      : `R${currentRound}/${latestStoredRound}`;
    roundDisplay.title = isLatest
      ? '下一轮（将请求 LLM）'
      : `当前查看第 ${currentRound} 轮（历史）`;
    btnLatest.style.display = isLatest ? 'none' : '';
  });

  // 继续发展：切回最新轮次
  btnLatest.addEventListener('click', () => {
    bus.emit('round:latest');
  });

  bus.on('world:roundComplete', () => {
    remainingRounds = Math.max(0, remainingRounds - 1);
    durInput.value = String(remainingRounds);
  });

  function formatRuntime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatCalendar(sec: number): string {
    const parts = calendarStart.split('-').map(n => parseInt(n, 10));
    const start = parts.length === 3 && parts.every(Number.isFinite)
      ? new Date(parts[0], parts[1] - 1, parts[2])
      : new Date(`${CALENDAR_START}T00:00:00`);
    const totalRounds = Math.floor(Math.max(0, sec) / SEGMENT_LENGTH);
    const days = Math.floor(totalRounds / ROUNDS_PER_DAY);
    const roundInDay = totalRounds % ROUNDS_PER_DAY;
    const hour = roundInDay * 4;
    start.setDate(start.getDate() + days);
    return `${start.getFullYear()}年${String(start.getMonth() + 1).padStart(2, '0')}月${String(start.getDate()).padStart(2, '0')}日 ${String(hour).padStart(2, '0')}:00`;
  }

  btnStart.addEventListener('click', () => {
    const rounds = parseInt(durInput.value, 10) || DEFAULT_ROUNDS;
    remainingRounds = rounds;
    const durSec = rounds * SEGMENT_LENGTH;
    bus.emit('world:start', durSec);
    btnStart.setAttribute('disabled', '');
    durInput.setAttribute('disabled', '');
    btnLatest.setAttribute('disabled', '');
    btnPause.removeAttribute('disabled');
    setPauseButton('暂停');
    btnStop.removeAttribute('disabled');
  });

  btnPause.addEventListener('click', () => {
    if (currentState.state === 'running') {
      bus.emit('world:pause');
      setPauseButton('继续');
    } else if (currentState.state === 'paused') {
      bus.emit('world:resume');
      setPauseButton('暂停');
    }
  });

  btnStop.addEventListener('click', () => {
    bus.emit('world:stop');
    resetUI();
  });

  function resetUI() {
    durInput.removeAttribute('disabled');
    btnStart.removeAttribute('disabled');
    btnLatest.removeAttribute('disabled');
    btnPause.setAttribute('disabled', '');
    setPauseButton('暂停');
    btnStop.setAttribute('disabled', '');
    timeDisplay.textContent = '--:--';
    topicDisplay.textContent = '酒馆静候开场';
  }

  function poll() {
    bus.emit('world:getState');

    timeDisplay.textContent = formatRuntime(currentState.tick);
    calDisplay.textContent = formatCalendar(currentState.tick);
    topicDisplay.textContent = currentState.topic || '酒馆静候开场';

    // 只在状态从非 idle 变为 idle 时重置 UI（避免每轮 poll 都覆盖用户输入）
    if (currentState.state === 'idle' && prevState !== 'idle') {
      resetUI();
    }
    prevState = currentState.state;
  }

  void loadCalendarStart();
  setInterval(poll, STATE_POLL_MS);
}
