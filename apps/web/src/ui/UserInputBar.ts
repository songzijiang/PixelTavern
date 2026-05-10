import { bus } from '../utils/EventBus';

let pendingMessages: string[] = [];
let worldState: 'idle' | 'running' | 'paused' = 'idle';

export function initUserInputBar() {
  const input = document.getElementById('user-event-input') as HTMLInputElement;
  const sendBtn = document.getElementById('user-event-send');
  if (!input || !sendBtn) return;

  // 创建待干预列表
  const pendingList = document.createElement('div');
  pendingList.id = 'pending-interventions';
  pendingList.style.cssText = 'display:none;position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:10001;max-width:360px;';
  document.body.appendChild(pendingList);

  function renderPending() {
    if (pendingMessages.length === 0) {
      pendingList.style.display = 'none';
      pendingList.innerHTML = '';
      return;
    }
    pendingList.style.display = 'block';
    pendingList.innerHTML = pendingMessages.map((m, i) =>
      `<div class="pending-item" style="display:flex;align-items:center;gap:6px;padding:3px 8px;background:rgba(26,26,46,0.92);border:1px solid #3d3d5c;border-radius:4px;margin-bottom:3px;font-size:11px;color:#8b7cc5;">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📝 ${esc(m)}</span>
        <button data-idx="${i}" style="padding:0 4px;font-size:10px;border:1px solid #633;border-radius:2px;background:transparent;color:#c88;cursor:pointer;" title="移除">✕</button>
      </div>`
    ).join('');

    // 移除按钮事件
    pendingList.querySelectorAll('button[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '');
        pendingMessages.splice(idx, 1);
        renderPending();
      });
    });
  }

  function send() {
    const msg = input.value.trim();
    if (!msg) return;
    pendingMessages.push(msg);
    input.value = '';
    input.style.borderColor = '#6855a0';
    renderPending();
    bus.emit('user:message', msg);
    // 世界已启动时立即触发下一轮；开始前只加入队列，等待第一轮 LLM 请求消费。
    if (worldState !== 'idle') {
      bus.emit('world:userInput', msg);
      bus.emit('world:resume');
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  input.addEventListener('focus', () => {
    if (worldState === 'running') bus.emit('world:pause');
  });

  bus.on('world:state', (payload: { state?: 'idle' | 'running' | 'paused' }) => {
    if (payload?.state) worldState = payload.state;
  });

  // 消费后刷新列表
  bus.on('user:consumed', () => {
    pendingMessages = [];
    renderPending();
    if (input) input.style.borderColor = '#3d3d5c';
  });
}

/** TavernScene 在每个 tick 请求前调用，返回所有待发送消息（换行拼接）。 */
export function consumeUserMessage(): string {
  const msg = pendingMessages.join('\n');
  if (msg) {
    // 消费后通知 UI 清空列表
    bus.emit('user:consumed');
  }
  return msg;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
