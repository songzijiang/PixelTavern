import { bus } from '../utils/EventBus';
import { COLORS, MAX_HISTORY_ENTRIES, MEMORY_REFRESH_MS, REBUILD_MAX_TRIES } from '../utils/Config';
import { exportShareImage } from '../utils/ShareExport';

const API_BASE = '';

let _npcNameCache: Map<string, string> | null = null;
let _npcNamePromise: Promise<Map<string, string>> | null = null;

async function resolveNpcNames(): Promise<Map<string, string>> {
  if (_npcNameCache) return _npcNameCache;
  if (_npcNamePromise) return _npcNamePromise;
  _npcNamePromise = (async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/world-prompt`);
      if (!resp.ok) throw new Error('prompt');
      const prompt = await resp.json();
      const presetKey = prompt.preset_key || '';
      const charsResp = await fetch(`${API_BASE}/api/characters?preset_key=${encodeURIComponent(presetKey)}`);
      if (!charsResp.ok) throw new Error('characters');
      const chars = await charsResp.json();
      const map = new Map<string, string>();
      for (const c of (chars.characters || [])) {
        if (c.key && c.name) map.set(c.key, c.name);
      }
      _npcNameCache = map;
      return map;
    } catch {
      return new Map();
    }
  })();
  return _npcNamePromise;
}

function npcDisplayName(key: string): string {
  if (_npcNameCache?.has(key)) return _npcNameCache.get(key)!;
  return key;
}

export function initInfoPanel() {
  const infoPanel = document.getElementById('info-panel')!;
  const infoToggle = document.getElementById('info-toggle')!;
  const infoTabBtns = infoPanel.querySelectorAll('.tab-btn') as NodeListOf<HTMLButtonElement>;
  const tabContents: Record<string, HTMLElement> = {};
  for (const btn of infoTabBtns) {
    const t = btn.dataset.tab;
    if (t) tabContents[t] = document.getElementById(`info-tab-${t}`)!;
  }
  const tabWorld = tabContents['world'];
  const tabMemory = tabContents['memory'];
  const memoryGroupsList = document.getElementById('memory-groups-list')!;
  const npcStatusList = document.getElementById('npc-status-list')!;

  // ==== 导出/导入/删除全部按钮 ====
  const actionRow = document.createElement('div');
  actionRow.className = 'export-import-row';
  actionRow.innerHTML = `
    <button id="btn-export-history" class="icon-label-btn" title="导出全部历史"><img class="ui-icon" src="/assets/ui/icons/export.png" alt="" />导出</button>
    <button id="btn-import-history" class="icon-label-btn" title="导入历史数据"><img class="ui-icon" src="/assets/ui/icons/import.png" alt="" />导入</button>
    <button id="btn-share-image" class="icon-label-btn" title="导出对话为分享图片"><img class="ui-icon" src="/assets/ui/icons/share.png" alt="" />分享</button>
    <button id="btn-clear-history" class="icon-label-btn" title="删除全部历史"><img class="ui-icon" src="/assets/ui/icons/trash.png" alt="" />清空</button>
  `;
  tabWorld.prepend(actionRow);

  document.getElementById('btn-export-history')!.addEventListener('click', async () => {
    try {
      const r = await fetch(`${API_BASE}/api/world/export`);
      if (!r.ok) return;
      const data = await r.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pixel_tavern_export_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  });

  document.getElementById('btn-import-history')!.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const r = await fetch(`${API_BASE}/api/world/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
        if (r.ok) {
          const result = await r.json();
          alert(`导入成功：${result.imported} 条记录`);
          // 通知 TavernScene 刷新段信息并触发重建历史
          bus.emit('data:imported');
          await rebuildHistory();
        } else {
          const err = await r.json().catch(() => ({ detail: '导入失败' }));
          alert(`导入失败：${err.detail || '数据格式无效'}`);
        }
      } catch { alert('无效的 JSON 文件'); }
    });
    input.click();
  });

  let currentShareRound = 0;
  bus.on('round:changed', (info: { currentRound: number }) => {
    currentShareRound = info.currentRound;
  });

  document.getElementById('btn-share-image')!.addEventListener('click', async () => {
    try {
      const seg = currentShareRound; // 使用当前选中轮次
      const r = await fetch(`${API_BASE}/api/world/replay?from_segment=${seg}&to_segment=${seg}`);
      if (!r.ok) { alert('暂无对话可分享'); return; }
      const data = await r.json();
      const segData = data.segments?.[0];
      if (!segData) { alert('该轮次暂无数据'); return; }

      // 提取 talk 对话
      const dialogues: Array<{sec: number; speaker: string; line: string; to?: string}> = [];
      for (const tl of (segData.plan || [])) {
        if (tl.npc === '用户') continue;
        for (const a of tl.actions) {
          if (a.action === 'talk' && a.line) {
            dialogues.push({ sec: a.sec, speaker: tl.npc, line: a.line, to: a.to });
          }
        }
      }
      if (!dialogues.length) { alert('该轮次暂无对话'); return; }

      const sr = await fetch(`${API_BASE}/api/world/state`);
      const state = sr.ok ? await sr.json() : {};
      await exportShareImage(dialogues, state.calendar || '1500年01月01日', segData.topic || state.topic || '', seg, npcDisplayName);
    } catch { /* ignore */ }
  });

  document.getElementById('btn-clear-history')!.addEventListener('click', async () => {
    if (!confirm('确定删除全部世界记录？此操作不可撤销。')) return;
    try {
      await fetch(`${API_BASE}/api/world/records`, { method: 'DELETE' });
      tabWorld.querySelectorAll('.hist-entry').forEach(e => e.remove());
      if (!tabWorld.querySelector('.hist-entry')) {
        tabWorld.appendChild(createPlaceholder());
      }
      bus.emit('data:imported');
    } catch { /* ignore */ }
  });

  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  let infoCollapsed = isMobile;

  if (isMobile) {
    infoPanel.classList.add('collapsed');
    infoToggle.textContent = '▲';
  } else {
    infoPanel.classList.remove('collapsed');
    infoToggle.textContent = '◀';
    infoToggle.style.right = '326px';
  }

  infoToggle.addEventListener('click', () => {
    infoCollapsed = !infoCollapsed;
    if (isMobile) {
      if (infoCollapsed) {
        infoPanel.classList.remove('visible-mobile');
        infoToggle.textContent = '▲';
      } else {
        infoPanel.classList.add('visible-mobile');
        infoToggle.textContent = '▼';
      }
    } else {
      if (infoCollapsed) {
        infoPanel.classList.add('collapsed');
        infoToggle.textContent = '▶';
        infoToggle.style.right = '4px';
      } else {
        infoPanel.classList.remove('collapsed');
        infoToggle.textContent = '◀';
        infoToggle.style.right = '326px';
      }
    }
  });

  // 当前播放轮次高亮 + 已播放轮次标记
  let activeRound = -1;
  bus.on('round:changed', (info: { currentRound: number; latestStoredRound: number }) => {
    const playing = info.currentRound;
    tabWorld.querySelectorAll('.hist-entry').forEach(el => {
      const entry = el as HTMLElement;
      const seg = parseInt(entry.dataset.segment || '');
      el.classList.remove('current');
      if (seg < playing) el.classList.add('played');
      else el.classList.remove('played');
    });
    // 当前轮次可能在 history 中（历史）也可能不在（下一轮新）
    const cur = tabWorld.querySelector(`.hist-entry[data-segment="${playing}"]`);
    if (cur) cur.classList.add('current');
    activeRound = playing;
  });

  // Tab 切换
  infoTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      infoTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab || '';
      for (const [key, el] of Object.entries(tabContents)) {
        el.classList.toggle('active', key === tab);
      }
      if (tab === 'memory') {
        refreshMemoryTab();
      }
    });
  });

  // 监听 EventBus 的历史添加事件
  bus.on('history:add', (info: {
    timestamp: string; tick: number; topic: string; segmentStart: number;
    plan: Array<{npc: string; actions: Array<{sec: number; action: string; line?: string; duration_sec?: number; x?: number; y?: number}>}>;
  }) => {
    try {
      const old = tabWorld.querySelector(`.hist-entry[data-segment="${info.tick}"]`);
      if (old) old.remove();

      const placeholder = tabWorld.querySelector('.mem-empty');
      if (placeholder) placeholder.remove();

      const entry = buildHistEntry(info.tick, info.topic, info.plan);
      tabWorld.appendChild(entry);

      while (tabWorld.querySelectorAll('.hist-entry').length > MAX_HISTORY_ENTRIES) {
        const first = tabWorld.querySelector('.hist-entry');
        if (first) first.remove();
      }
    } catch (e) {
      console.error('[InfoPanel] history:add 处理失败', e);
    }
  });

  // ==== 构建历史条目 DOM（history:add 和 rebuildHistory 共用） ====

  function buildHistEntry(segId: number, topic: string, plan: any[] | null): HTMLElement {
    const entry = document.createElement('div');
    entry.className = 'hist-entry';
    entry.dataset.segment = String(segId);

    const summary = document.createElement('div');
    summary.className = 'hist-summary';
    const topicText = topic || '';
    summary.innerHTML = `<span class="tick">T${segId}</span><span class="topic${topicText ? '' : ' empty'}">${topicText ? esc(topicText) : '(无话题)'}</span>`;

    // 点击 summary 切换详情
    summary.addEventListener('click', () => {
      detail.classList.toggle('open');
      bus.emit('round:set', segId);
    });

    const detail = document.createElement('div');
    detail.className = 'hist-detail';
    if (plan && plan.length > 0) {
      detail.innerHTML = formatPlanDetail(plan);
    } else {
      detail.textContent = '(已归档，仅对话摘要)';
    }

    // 跳转到此轮次按钮
    const btnJump = document.createElement('button');
    btnJump.className = 'hist-btn replay-btn';
    btnJump.textContent = '↳';
    btnJump.title = '切换当前轮次到此段，点"开始"即可重播';
    btnJump.addEventListener('click', (e) => {
      e.stopPropagation();
      bus.emit('round:set', segId);
    });
    summary.appendChild(btnJump);

    entry.appendChild(summary);
    entry.appendChild(detail);
    return entry;
  }

  function formatPlanDetail(plan: any[]): string {
    let dt = '';
    for (const p of plan) {
      if (!p || !p.actions) continue;
      const isUser = p.npc === '用户';
      dt += `<span class="npc-name${isUser ? ' user-npc' : ''}">[${esc(p.npc || '?')}]</span>\n`;
      for (const a of p.actions) {
        let extra = '';
        if (a.action === 'talk' && a.line) extra = ` → "${esc(a.line)}"`;
        else if (a.action === 'user_event' && a.line) extra = ` → 「${esc(a.line)}」`;
        else if (a.action === 'walk_to') extra = ` → (${a.x},${a.y}) ${a.duration_sec ?? '?'}s`;
        const cls = a.action === 'user_event' ? ' class="user-event"' : '';
        dt += `  ${String(a.sec).padStart(2, '0')}s: <span${cls}>${a.action}${extra}</span>\n`;
      }
    }
    return dt;
  }

  function createPlaceholder(): HTMLElement {
    const ph = document.createElement('div');
    ph.className = 'mem-empty';
    ph.textContent = '暂无历史，启动世界后自动记录';
    return ph;
  }

  // 从后端 API 重建世界历史
  async function rebuildHistory() {
    try {
      const resp = await fetch(`${API_BASE}/api/world/state`);
      if (!resp.ok) return;
      const data = await resp.json();
      const segments: Array<{ segment: number; topic: string; plan?: any; user_events?: Array<{tick: number; message: string}> }> = data.segments || [];
      if (segments.length === 0) {
        console.log('[InfoPanel] rebuildHistory: API 返回 0 个段（cycle_messages 为空）');
        return;
      }
      console.log('[InfoPanel] rebuildHistory: 渲染 ' + segments.length + ' 个段');

      const ph = tabWorld.querySelector('.mem-empty');
      if (ph) ph.remove();
      // 保留顶部按钮行，只清空历史条目
      tabWorld.querySelectorAll('.hist-entry').forEach(e => e.remove());

      for (const seg of segments) {
        try {
          let plan = seg.plan || [];
          if (seg.user_events && seg.user_events.length > 0) {
            const userTimeline = {
              npc: '用户',
              actions: seg.user_events.map((ue: any) => ({
                sec: ue.tick - seg.segment * 30,
                action: 'user_event',
                line: ue.message,
              })),
            };
            plan = [userTimeline, ...plan];
          }
          const entry = buildHistEntry(seg.segment, seg.topic, plan.length > 0 ? plan : null);
          tabWorld.appendChild(entry);
        } catch (e) {
          console.error('[InfoPanel] 构建历史条目失败 seg=' + seg.segment, e);
        }
      }
    } catch (e) { console.error('[InfoPanel] rebuildHistory 失败', e); }
  }

  // 轮询等待后端可用后重建历史
  let rebuildTried = 0;
  const rebuildTimer = setInterval(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/world/state`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.last_tick > 0) {
          await rebuildHistory();
          clearInterval(rebuildTimer);
        }
      }
    } catch { /* 后端未就绪 */ }
    if (++rebuildTried > REBUILD_MAX_TRIES) clearInterval(rebuildTimer);
  }, 500);

  // 记忆 Tab
  function formatMemContent(e: { type: string; npc: string; line?: string; to?: string; emote?: string }): string {
    if (e.type === 'talk') {
      const toPart = e.to ? `对 ${npcDisplayName(e.to)} ` : '';
      return `${toPart}说：「${e.line || ''}」`;
    }
    if (e.type === 'emote') return e.emote || '';
    return '';
  }

  let npcStateCache: Map<string, { status: string; x: number; y: number; inTavern: boolean }> = new Map();

  async function refreshMemoryTab() {
    try {
      await resolveNpcNames();
      // 并行获取状态和记忆
      const [stateResp, memResp] = await Promise.all([
        fetch(`${API_BASE}/api/world/state`),
        fetch(`${API_BASE}/api/world/memories?limit=50`),
      ]);

      // 解析 NPC 状态
      npcStateCache.clear();
      if (stateResp.ok) {
        const stateData = await stateResp.json();
        const states: Array<{key: string; x: number; y: number; action: string; sitting_at: number}> = stateData.npc_states || [];
        for (const s of states) {
          let status: string;
          if (s.action === 'away_from_tavern') status = '在酒馆外';
          else if (s.sitting_at >= 0) status = `坐着`;
          else status = '站立';
          npcStateCache.set(s.key, { status, x: s.x, y: s.y, inTavern: s.action !== 'away_from_tavern' });
        }
      }

      if (!memResp.ok) throw new Error();
      const groups: Record<string, Array<{ tick: number; npc: string; type: string; line?: string; to?: string; emote?: string }>> = await memResp.json();

      // 合并：有状态的 NPC 也加入显示
      const allKeys = new Set([...Object.keys(groups), ...npcStateCache.keys()]);
      const totalMemories = Object.values(groups).reduce((s, arr) => s + arr.length, 0);

      if (allKeys.size === 0) {
        memoryGroupsList.innerHTML = '<div class="mem-empty">暂无角色信息，启动世界后自动记录</div>';
        return;
      }

      // 记住展开状态，刷新后恢复
      const openKeys = new Set<string>();
      memoryGroupsList.querySelectorAll<HTMLDetailsElement>('.mem-group[open]').forEach(el => {
        const k = el.dataset.npcKey;
        if (k) openKeys.add(k);
      });

      memoryGroupsList.innerHTML = '';
      const sortedKeys = [...allKeys].sort();
      for (const key of sortedKeys) {
        const entries = groups[key] || [];
        const name = npcDisplayName(key);
        const state = npcStateCache.get(key);

        // 状态标签
        let statusChip = '';
        if (state) {
          const color = state.inTavern ? '#6a9' : '#e66';
          statusChip = `<span class="npc-status-chip" style="color:${color};font-size:10px;margin-left:6px">${esc(state.status)}</span>`;
        }

        const group = document.createElement('details');
        group.className = 'mem-group';
        group.dataset.npcKey = key;
        group.open = openKeys.has(key);
        const header = document.createElement('summary');
        header.className = 'mem-group-header';
        header.innerHTML = `${esc(name)}${statusChip}<span class="count">${entries.length} 条</span>`;
        group.appendChild(header);

        if (entries.length === 0) {
          const row = document.createElement('div');
          row.className = 'mem-entry';
          row.innerHTML = '<span class="mem-text" style="color:#666">暂无记忆记录</span>';
          group.appendChild(row);
        } else {
          for (const m of entries.slice(-5)) {
            const row = document.createElement('div');
            row.className = 'mem-entry';
            const text = formatMemContent(m);
            row.innerHTML = `<span class="mem-tick">T${m.tick}</span><span class="mem-text">${esc(text)}</span>`;
            group.appendChild(row);
          }
        }
        memoryGroupsList.appendChild(group);
      }
    } catch {
      memoryGroupsList.innerHTML = '<div class="mem-empty">后端未连接</div>';
    }
  }

  // NPC 状态变化时刷新
  bus.on('world:state', () => {
    if (!tabMemory.classList.contains('active')) return;
    refreshMemoryTab();
  });

  setInterval(() => {
    if (tabMemory.classList.contains('active')) {
      refreshMemoryTab();
    }
  }, MEMORY_REFRESH_MS);

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
