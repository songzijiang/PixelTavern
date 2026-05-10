import Phaser from 'phaser';
import {
  CANVAS_WIDTH, CANVAS_HEIGHT,
  FLOOR_SCALE, WALL_SCALE,
  NPC_CONFIGS, WORLD_INTERACTION_NPC_CONFIGS, PROP_LAYOUT, AMBIENT_PROP_LAYOUT, COLLISION_ZONES,
  WALL_KEY, FLOOR_START_Y, SIT_SPOTS, DOOR_X, DOOR_Y,
  CHAIR_ASSET_RATIO, CHAIR_SEAT_CENTER_RATIO,
  DEFAULT_STYLE_KEY, getNpcConfigsForStyle, getWorldNpcConfigsForStyle,
} from '../constants';
import type { AmbientPropConfig } from '../constants';
import type { NPCAction, WorldTickResponse, NPCConfig, CharacterCard } from '../types';
import { NPC } from '../entities/NPC';
import { SpeechBubble } from '../entities/SpeechBubble';
import { BehaviorLog } from '../systems/BehaviorLog';
import { WorldRunner } from '../systems/WorldRunner';
import { CHARACTERS } from '../data/characters';
import { initPathfindingGrid, clearDynamicBlocks, blockCell, getPathfindingDebugGrid } from '../utils/Pathfinding';
import { CollisionEditor } from '../ui/CollisionEditor';
import { consumeUserMessage } from '../ui/UserInputBar';
import { SEGMENT_LENGTH } from '../utils/Config';
import { bus } from '../utils/EventBus';
import { startBgm } from '../ui/BgmSettings';

const API_BASE = '';
const WORLD_NPC_ENTRY_CHANCE = 0.38;
const WORLD_NPC_ENTRY_POINTS = [
  { x: 475, y: 330 },
  { x: 575, y: 420 },
  { x: 835, y: 360 },
];
const SEAT_PROP_KEYS = [
  'prop_chair1_top',
  'prop_chair1_bottom',
  'prop_chair1_left',
  'prop_chair1_right',
  'prop_chair2_top',
  'prop_chair2_bottom',
  'prop_chair2_left',
  'prop_chair2_right',
] as const;
const LEGACY_ANIM_CACHE_KEYS: Record<string, string> = {
  npc_bartender: 'bartenderAnims',
  npc_warrior: 'warriorAnims',
  npc_witch: 'witchAnims',
  npc_poet: 'poetAnims',
  npc_ranger: 'rangerAnims',
  npc_mysterious: 'mysteriousAnims',
};

interface StyleRefreshMeta {
  presetKey?: string;
}

export class TavernScene extends Phaser.Scene {
  private npcs: NPC[] = [];
  private npcMap: Map<string, NPC> = new Map();
  private propImages: Phaser.GameObjects.Image[] = [];
  private bubbles: Map<string, SpeechBubble> = new Map();
  private ambientObjects: Array<Phaser.GameObjects.Image | Phaser.GameObjects.Sprite> = [];
  private ambientGlows: Array<{ node: Phaser.GameObjects.Arc; baseAlpha: number; baseScale: number; phase: number }> = [];
  private chairOccupancy: (string | null)[] = new Array(8).fill(null);
  private behaviorLog = new BehaviorLog();
  private worldRunner = new WorldRunner();
  private tickRequestPending = false;
  private requestedSegments = new Set<number>();
  private restoredFromBackend = false;
  private lastCompletedSegment = -1;
  /** 当前轮次（用户选中的段编号）。默认=最新已存储段+1（即下一个待请求LLM的新轮次） */
  private currentRound = 0;
  private activeStartTick = 0;
  /** DB 中最大的段编号 */
  private latestStoredRound = -1;
  /** 启动时从后端恢复的段列表（用于判断某个 round 是否已有历史数据） */
  private storedSegmentSet = new Set<number>();
  private gridGraphics: Phaser.GameObjects.Graphics | null = null;
  private collisionEditor: CollisionEditor | null = null;
  private npcVisibilityBeforeCollisionEdit: Map<NPC, boolean> | null = null;
  private guidanceBySegment: Map<number, string> = new Map();
  private visibleGuidanceSegment = -1;
  private fireplaceGlow: Phaser.GameObjects.Arc[] = [];
  private atmosphereEmitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  private currentStyleKey = DEFAULT_STYLE_KEY;
  private activeNpcConfigs: NPCConfig[] = getNpcConfigsForStyle(DEFAULT_STYLE_KEY);
  private activeWorldNpcConfigs: NPCConfig[] = getWorldNpcConfigsForStyle(DEFAULT_STYLE_KEY);
  private characterCards: Map<string, CharacterCard> = new Map();
  private worldNpcKeys = new Set(this.activeWorldNpcConfigs.map(cfg => cfg.key));
  private worldNpcLastRollSegment = -1;
  private pendingStyleRefresh = false;
  private pendingStyleKey = '';
  private lightFlickerTime = 0;

  constructor() { super({ key: 'TavernScene' }); }

  async create() {
    startBgm();
    this.buildWalls();
    this.buildFloor();
    this.buildSceneAccents();
    this.placeProps();
    // 加载已保存的场景编辑数据（碰撞区 + 素材位置）
    const saved = await CollisionEditor.load();
    if (Array.isArray(saved?.zones)) {
      const savedZones = saved.zones.filter((z: Partial<typeof COLLISION_ZONES[number]>) =>
        typeof z.x === 'number' &&
        typeof z.y === 'number' &&
        typeof z.halfW === 'number' &&
        typeof z.halfH === 'number',
      );
      if (savedZones.length > 0) {
        COLLISION_ZONES.splice(0, COLLISION_ZONES.length, ...savedZones);
      }
    }
    if (saved?.props) {
      for (const sp of saved.props) {
        const existing = PROP_LAYOUT.find(p => p.key === sp.key);
        if (existing) {
          existing.x = sp.x;
          existing.y = sp.y;
          if (typeof sp.displayW === 'number') existing.displayW = sp.displayW;
        }
      }
      this.syncSitSpotsFromProps();
    }
    this.placeAmbientProps();
    this.createAtmosphereEffects();

    initPathfindingGrid(COLLISION_ZONES);
    this.drawPathGrid();

    // 场景编辑器（碰撞 + 素材 + 氛围装饰）
    const editableProps = PROP_LAYOUT.map(p => ({ ...p, depth: 0 }));
    // 将锚定的氛围装饰也加入可编辑列表
    const editableAmbient = AMBIENT_PROP_LAYOUT
      .map(a => ({
        x: a.x,
        y: a.y,
        key: a.key,
        folder: a.folder,
        file: a.file || (a.frameBase ? `${a.frameBase}_0.png` : `${a.key}.png`),
        displayW: a.displayW,
        originY: a.originY,
        depth: 0,
        _ambient: true as const,
      }));
    const allEditableProps = [...editableProps, ...editableAmbient];
    this.collisionEditor = new CollisionEditor(this, COLLISION_ZONES, allEditableProps, () => {
      // 编辑后实时更新寻路网格和可视网格
      initPathfindingGrid(COLLISION_ZONES);
      if (this.gridGraphics) { this.gridGraphics.destroy(); this.gridGraphics = null; }
      this.drawPathGrid();
      // 更新素材位置
      for (const ep of allEditableProps) {
        if ((ep as any)._ambient) {
          // 更新氛围装饰位置
          const amb = AMBIENT_PROP_LAYOUT.find(a => a.key === ep.key);
          if (amb) {
            amb.x = ep.x;
            amb.y = ep.y;
            amb.displayW = ep.displayW;
            // 更新锚点偏移
            if (amb.anchorPropKey) {
              const anchor = PROP_LAYOUT.find(p => p.key === amb.anchorPropKey);
              if (anchor) {
                amb.anchorOffsetX = ep.x - anchor.x;
                amb.anchorOffsetY = ep.y - anchor.y;
              }
            }
          }
        } else {
          const orig = PROP_LAYOUT.find(p => p.key === ep.key);
          if (orig) {
            orig.x = ep.x;
            orig.y = ep.y;
            orig.displayW = ep.displayW;
          }
          // 移动对应图片
          const img = this.propImages.find(im => ((im as any)._propDef as any)?.key === ep.key);
          if (img) this.syncPropImageAndShadow(img, ep);
        }
      }
      this.syncSitSpotsFromProps();
      this.syncAmbientProps();
    });
    // 场景编辑选项卡切换监听
    const sceneEditTab = document.getElementById('info-tab-scene-edit');
    if (sceneEditTab) {
      const obs = new MutationObserver(() => {
        this.setCollisionEditorActive(sceneEditTab.classList.contains('active'));
      });
      obs.observe(sceneEditTab, { attributes: true, attributeFilter: ['class'] });
    }

    await this.loadCurrentStyleKey();
    this.spawnNPCs();
    this.time.delayedCall(600, () => this.positionBartender());

    // 从后端恢复时间线和轮次信息
    await this.restoreFromBackend();

    // World 控制
    bus.on('world:start', (dur: number) => this.startWorld(dur));
    bus.on('world:pause', () => this.pauseWorld());
    bus.on('world:resume', () => this.resumeWorld());
    bus.on('world:stop', () => this.stopWorld());
    bus.on('world:userInput', () => {
      if (!this.tickRequestPending) {
        const ns = this.behaviorLog.nextPrefetchStart();
        this.advanceRound(ns, this.behaviorLog.topic);
      }
    });
    bus.on('world:getState', () => {
      bus.emit('world:state', {
        state: this.worldRunner.currentState,
        tick: this.behaviorLog.currentTick,
        elapsed: this.worldRunner.elapsed,
        bufferedUntil: this.behaviorLog.bufferedUntil,
        topic: this.behaviorLog.topic,
      });
    });
    bus.on('npc:spawn', (cfg: NPCConfig, card: CharacterCard) => this.spawnCustomNPC(cfg, card));
    bus.on('npc:remove', (key: string) => this.removeCustomNPC(key));
    bus.on('prompt:updated', async (_source?: string, meta?: StyleRefreshMeta) => {
      const presetKey = meta?.presetKey || '';
      if (this.worldRunner.isRunning || this.worldRunner.isPaused) {
        this.pendingStyleRefresh = true;
        if (presetKey) this.pendingStyleKey = presetKey;
        return;
      }
      await this.refreshStyleFromSettings(presetKey);
    });
    bus.on('characters:updated', async (meta?: StyleRefreshMeta) => {
      const presetKey = meta?.presetKey || '';
      if (this.worldRunner.isRunning || this.worldRunner.isPaused) {
        this.pendingStyleRefresh = true;
        if (presetKey) this.pendingStyleKey = presetKey;
        return;
      }
      this.pendingStyleRefresh = true;
      await this.refreshStyleFromSettings(presetKey);
    });

    // 切换当前轮次（点历史条目）—— 同步还原 NPC 状态
    bus.on('round:set', async (round: number) => {
      if (this.worldRunner.isRunning || this.worldRunner.isPaused) return;
      this.currentRound = Math.max(0, round);
      this.behaviorLog.restoreTick(this.currentRound * SEGMENT_LENGTH);
      await this.restoreNPCsForRound(round);
      bus.emit('round:changed', { currentRound: this.currentRound, latestStoredRound: this.latestStoredRound });
    });

    // 继续发展：切回最新轮次 —— 还原最新 NPC 状态
    bus.on('round:latest', async () => {
      if (this.worldRunner.isRunning || this.worldRunner.isPaused) return;
      this.currentRound = this.latestStoredRound + 1;
      this.behaviorLog.restoreTick(this.currentRound * SEGMENT_LENGTH);
      // 用当前 DB 中最新的 NPC 快照
      try {
        const resp = await fetch(`${API_BASE}/api/world/state`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.npc_states) this.positionNPCsFromSnapshot(data.npc_states, false);
        }
      } catch { /* ignore */ }
      bus.emit('round:changed', { currentRound: this.currentRound, latestStoredRound: this.latestStoredRound });
    });

    // 导入后刷新段信息
    bus.on('data:imported', async () => {
      await this.restoreFromBackend();
    });
  }

  spawnCustomNPC(config: NPCConfig, card: CharacterCard) {
    const npc = new NPC(this, config, this.getAnimConfigForNpcConfig(config));
    npc.setChairCallback(() => null);
    npc.setDepth(200);
    (npc as any).x = DOOR_X;
    (npc as any).y = DOOR_Y;
    npc.setAwayPose();
    this.npcs.push(npc);
    this.npcMap.set(npc.key, npc);
    return npc;
  }

  removeCustomNPC(key: string) {
    const npc = this.npcMap.get(key);
    if (!npc) return;
    if (npc.isSitting) {
      const ci = npc.chairIndex;
      if (ci >= 0) this.chairOccupancy[ci] = null;
    }
    const idx = this.npcs.indexOf(npc);
    if (idx >= 0) this.npcs.splice(idx, 1);
    this.npcMap.delete(key);
    npc.destroy();
  }

  private async loadCurrentStyleKey() {
    await this.setActiveStyle(await this.fetchCurrentPromptStyleKey());
  }

  private async refreshStyleFromSettings(preferredStyleKey = '') {
    const nextStyle = preferredStyleKey || this.pendingStyleKey || await this.fetchCurrentPromptStyleKey();
    if (nextStyle === this.currentStyleKey && !this.pendingStyleRefresh) return;

    const snapshot = this.captureNpcSnapshot();
    await this.setActiveStyle(nextStyle);
    this.rebuildNpcsForStyle(snapshot);
    this.pendingStyleRefresh = false;
    this.pendingStyleKey = '';
  }

  private async fetchCurrentPromptStyleKey(): Promise<string> {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/world-prompt`);
      if (!resp.ok) return DEFAULT_STYLE_KEY;
      const data = await resp.json();
      return typeof data.preset_key === 'string' && data.preset_key ? data.preset_key : DEFAULT_STYLE_KEY;
    } catch {
      return DEFAULT_STYLE_KEY;
    }
  }

  private async setActiveStyle(styleKey: string) {
    this.currentStyleKey = styleKey;
    const rosterLoaded = await this.loadCharacterRoster(styleKey);
    if (!rosterLoaded) {
      this.activeNpcConfigs = getNpcConfigsForStyle(styleKey);
      this.activeWorldNpcConfigs = getWorldNpcConfigsForStyle(styleKey);
    }
    this.worldNpcKeys = new Set(this.activeWorldNpcConfigs.map(cfg => cfg.key));
  }

  private async loadCharacterRoster(styleKey: string): Promise<boolean> {
    try {
      const resp = await fetch(`${API_BASE}/api/characters?preset_key=${encodeURIComponent(styleKey)}`);
      if (!resp.ok) return false;
      const data = await resp.json();
      const characters: CharacterCard[] = Array.isArray(data.characters) ? data.characters : [];
      if (!characters.length) return false;

      this.characterCards.clear();
      const coreConfigs: NPCConfig[] = [];
      const visitorConfigs: NPCConfig[] = [];
      let coreIndex = 0;
      for (const card of characters) {
        if (!card || !card.key || card.appearance === 'disabled') continue;
        this.characterCards.set(card.key, card);
        const config = this.npcConfigFromCharacter(card, coreIndex);
        if (card.appearance === 'visitor') {
          visitorConfigs.push({ ...config, startX: DOOR_X, startY: DOOR_Y });
        } else {
          coreConfigs.push(config);
          coreIndex += 1;
        }
      }
      if (!coreConfigs.length && !visitorConfigs.length) return false;
      this.activeNpcConfigs = coreConfigs;
      this.activeWorldNpcConfigs = visitorConfigs;
      return true;
    } catch {
      return false;
    }
  }

  private npcConfigFromCharacter(card: CharacterCard, index: number): NPCConfig {
    const npcKey = `npc_${card.key}`;
    const fallback = NPC_CONFIGS.find(c => c.key === npcKey) ??
      WORLD_INTERACTION_NPC_CONFIGS.find(c => c.key === npcKey);
    const defaultSpots = [
      { x: 200, y: FLOOR_START_Y + 95 },
      { x: 400, y: 420 },
      { x: 650, y: FLOOR_START_Y + 100 },
      { x: 780, y: 530 },
      { x: 520, y: 470 },
      { x: 560, y: 350 },
    ];
    const spot = defaultSpots[index % defaultSpots.length];
    return {
      key: npcKey,
      folderName: card.folderName || fallback?.folderName || card.name || card.key,
      startX: typeof card.startX === 'number' ? card.startX : fallback?.startX ?? spot.x,
      startY: typeof card.startY === 'number' ? card.startY : fallback?.startY ?? spot.y,
      wanderMinX: fallback?.wanderMinX ?? 120,
      wanderMaxX: fallback?.wanderMaxX ?? 880,
      wanderMinY: fallback?.wanderMinY ?? FLOOR_START_Y + 60,
      wanderMaxY: fallback?.wanderMaxY ?? 580,
      tooltip: `${card.name || card.key}\n${card.personality || ''}`,
    };
  }

  private rebuildNpcsForStyle(
    snapshot: Array<{key: string; x: number; y: number; action: string; facing: string; sitting_at: number}>,
  ) {
    for (const bubble of this.bubbles.values()) bubble.hide();
    this.bubbles.clear();
    for (const npc of this.npcs) npc.destroy();
    this.npcs = [];
    this.npcMap.clear();
    this.chairOccupancy.fill(null);

    this.spawnNPCs();
    if (snapshot.length > 0) {
      this.positionNPCsFromSnapshot(snapshot);
    } else {
      this.positionBartender();
    }
    this.ensureNpcAnimationsPlaying();
  }

  private captureNpcSnapshot() {
    return this.npcs.map((n) => {
      let action = 'idle';
      if (n.isAway) action = 'away_from_tavern';
      else if (n.isSitting) action = `sitting_at_chair_${n.chairIndex}`;
      else if (n.isSpecial) action = 'dozing_in_corner';
      else if (n.key === 'npc_bartender') action = 'standing_behind_counter';

      return {
        key: n.key.replace('npc_', ''),
        x: Math.round(n.isAway ? DOOR_X : n.x),
        y: Math.round(n.isAway ? DOOR_Y : n.y),
        action,
        facing: n.facing,
        sitting_at: n.isSitting ? n.chairIndex : -1,
      };
    });
  }

  private async restoreFromBackend() {
    try {
      const resp = await fetch(`${API_BASE}/api/world/state`);
      if (!resp.ok) return;
      const data = await resp.json();

      // 重建已存储段集合
      this.storedSegmentSet.clear();
      let maxSeg = -1;
      for (const s of (data.segments || [])) {
        this.storedSegmentSet.add(s.segment);
        if (s.segment > maxSeg) maxSeg = s.segment;
      }
      this.latestStoredRound = maxSeg;

      if (data.last_tick > 0) {
        this.restoredFromBackend = true;
        const aligned = Math.ceil(data.last_tick / SEGMENT_LENGTH) * SEGMENT_LENGTH;
        this.behaviorLog.restoreTick(aligned);
      }

      // 默认当前轮次 = 最新段+1（新轮次）
      this.currentRound = this.latestStoredRound + 1;

      // 恢复 NPC 状态
      const saved: Array<{key: string; x: number; y: number; action: string; facing: string; sitting_at: number}> =
        data.npc_states || [];
      bus.emit('round:changed', { currentRound: this.currentRound, latestStoredRound: this.latestStoredRound });
      if (saved.length === 0) return;

      this.restoredFromBackend = true;
      this.chairOccupancy.fill(null);
      this.hideAllWorldNpcs();
      for (const s of saved) {
        const npcKey = `npc_${s.key}`;
        if (this.isWorldNpc(npcKey)) continue;
        const npc = this.npcMap.get(npcKey);
        if (!npc) continue;

        if (s.action === 'away_from_tavern') {
          (npc as any).x = DOOR_X; (npc as any).y = DOOR_Y;
          npc.setAwayPose();
        } else if (s.sitting_at >= 0) {
          const spot = SIT_SPOTS[s.sitting_at];
          if (spot) {
            (npc as any).x = spot.x; (npc as any).y = spot.y;
            this.chairOccupancy[s.sitting_at] = npcKey;
            npc.setVisible(true);
            (npc as any).occupiedChairIdx = s.sitting_at;
            npc.setSittingPose(spot.facing as any, false);
          }
        } else if (this.isDozingAction(s.action)) {
          (npc as any).x = s.x; (npc as any).y = s.y;
          npc.setDozingPose((s.facing || 'front') as any);
        } else {
          (npc as any).x = s.x; (npc as any).y = s.y;
          npc.setIdlePose((s.facing || 'front') as any);
        }
      }

    } catch { /* 后端未启动，从 0 开始 */ }
  }

  // ==== 世界控制 ====

  startWorld(durationSec: number) {
    if (durationSec <= 0) return;
    // 从 currentRound 的起点开始
    const startTick = this.currentRound * SEGMENT_LENGTH;
    this.activeStartTick = startTick;
    this.behaviorLog.restoreTick(startTick);
    this.worldRunner.start(startTick + durationSec);
    this.tickRequestPending = true;
    this.behaviorLog.pause();
    this.lastCompletedSegment = this.currentRound - 1;
    this.ensureNpcAnimationsPlaying();

    this.advanceRound(startTick, '');
  }

  pauseWorld() {
    this.worldRunner.pause();
    this.behaviorLog.pause();
  }

  resumeWorld() {
    this.worldRunner.resume();
    this.behaviorLog.resume();
    if (this.behaviorLog.needsPrefetch() && !this.tickRequestPending) {
      const ns = this.behaviorLog.nextPrefetchStart();
      if (this.worldRunner.targetStopTick < 0 || ns + 20 <= this.worldRunner.targetStopTick) {
        this.advanceRound(ns, this.behaviorLog.topic);
      }
    }
  }

  stopWorld() {
    this.worldRunner.stop();
    this.tickRequestPending = false;
    this.behaviorLog.clearSegments();
    this.hideGuidanceMarquee();
    this.requestedSegments.clear();
    this.currentRound = this.latestStoredRound + 1;
    for (const npc of this.npcs) {
      if (npc.isSitting) {
        const ci = npc.chairIndex;
        if (ci >= 0) this.chairOccupancy[ci] = null;
        npc.standUp();
      }
    }
    if (this.pendingStyleRefresh) {
      void this.refreshStyleFromSettings();
    }
  }

  private ensureNpcAnimationsPlaying() {
    for (const npc of this.npcs) {
      npc.ensurePoseAnimationPlaying();
    }
  }

  /** 获取指定轮次的 NPC 快照并定位 */
  private async restoreNPCsForRound(round: number) {
    try {
      const resp = await fetch(`${API_BASE}/api/world/replay?from_segment=${round}&to_segment=${round}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.npc_snapshot && data.npc_snapshot.length > 0) {
        this.positionNPCsFromSnapshot(data.npc_snapshot);
      }
    } catch { /* ignore */ }
  }

  private positionNPCsFromSnapshot(
    snapshot: Array<{key: string; x: number; y: number; action: string; facing: string; sitting_at: number}>,
    includeWorldNpcs = true,
  ) {
    // 重置椅子占用
    this.chairOccupancy.fill(null);
    if (includeWorldNpcs) this.hideWorldNpcsMissingFromSnapshot(snapshot);
    else this.hideAllWorldNpcs();
    for (const s of snapshot) {
      const npcKey = `npc_${s.key}`;
      if (!includeWorldNpcs && this.isWorldNpc(npcKey)) continue;
      const npc = this.npcMap.get(npcKey);
      if (!npc) continue;

      if (s.action === 'away_from_tavern') {
        (npc as any).x = DOOR_X; (npc as any).y = DOOR_Y;
        npc.setAwayPose();
      } else if (s.sitting_at >= 0) {
        const spot = SIT_SPOTS[s.sitting_at];
        if (spot) {
          (npc as any).x = spot.x; (npc as any).y = spot.y;
          this.chairOccupancy[s.sitting_at] = npcKey;
          npc.setVisible(true);
          (npc as any).occupiedChairIdx = s.sitting_at;
          npc.setSittingPose(spot.facing as any, false);
        }
      } else if (this.isDozingAction(s.action)) {
        (npc as any).x = s.x; (npc as any).y = s.y;
        npc.setDozingPose((s.facing || 'front') as any);
      } else {
        (npc as any).x = s.x; (npc as any).y = s.y;
        npc.setIdlePose((s.facing || 'front') as any);
      }
    }
    // 快照中没有的 NPC 确保可见（不在快照中 ≠ 不存在）
    for (const [key, npc] of this.npcMap) {
      if (!snapshot.some(s => `npc_${s.key}` === key) && !npc.isAway) {
        npc.setVisible(true);
      }
    }
    this.refreshHiddenNpcBaselineForCollisionEditor();
  }

  private isDozingAction(action: string | undefined): boolean {
    return action === 'dozing_in_corner' || action === 'sleeping_on_floor' || action === 'special';
  }

  private hideWorldNpcsMissingFromSnapshot(snapshot: Array<{key: string}>) {
    const snapshotKeys = new Set(snapshot.map(s => `npc_${s.key}`));
    for (const npc of this.npcs) {
      if (!this.isWorldNpc(npc.key) || snapshotKeys.has(npc.key)) continue;
      this.releaseChair(npc);
      (npc as any).x = DOOR_X;
      (npc as any).y = DOOR_Y;
      npc.setAwayPose();
    }
  }

  private hideAllWorldNpcs() {
    for (const npc of this.npcs) {
      if (!this.isWorldNpc(npc.key)) continue;
      this.releaseChair(npc);
      (npc as any).x = DOOR_X;
      (npc as any).y = DOOR_Y;
      npc.setAwayPose();
    }
  }

  private setCollisionEditorActive(active: boolean) {
    if (!this.collisionEditor) return;
    if (active && !this.collisionEditor.isActive) {
      this.collisionEditor.toggle();
    } else if (!active && this.collisionEditor.isActive) {
      this.collisionEditor.toggle();
    }
    this.gridGraphics?.setVisible(active);
    this.setNpcVisibilityForCollisionEditor(active);
  }

  private setNpcVisibilityForCollisionEditor(active: boolean) {
    if (active) {
      if (this.npcVisibilityBeforeCollisionEdit) return;
      this.npcVisibilityBeforeCollisionEdit = new Map();
      for (const npc of this.npcs) {
        this.npcVisibilityBeforeCollisionEdit.set(npc, npc.visible);
        npc.setVisible(false);
      }
      return;
    }

    const previousVisibility = this.npcVisibilityBeforeCollisionEdit;
    if (!previousVisibility) return;
    for (const [npc, wasVisible] of previousVisibility) {
      npc.setVisible(wasVisible);
    }
    previousVisibility.clear();
    this.npcVisibilityBeforeCollisionEdit = null;
  }

  private refreshHiddenNpcBaselineForCollisionEditor() {
    if (!this.collisionEditor?.isActive || !this.npcVisibilityBeforeCollisionEdit) return;
    for (const npc of this.npcs) {
      this.npcVisibilityBeforeCollisionEdit.set(npc, npc.visible);
      npc.setVisible(false);
    }
  }

  private positionBartender() {
    if (this.restoredFromBackend) return;
    const b = this.npcMap.get('npc_bartender');
    if (!b || b.isSitting) return;
    (b as any).x = 230;
    (b as any).y = 280;
    b.showDirection('front');
  }

  private syncSitSpotsFromProps() {
    for (let i = 0; i < SEAT_PROP_KEYS.length; i++) {
      const prop = PROP_LAYOUT.find(p => p.key === SEAT_PROP_KEYS[i]);
      if (!prop || !SIT_SPOTS[i]) continue;
      SIT_SPOTS[i].x = Math.round(prop.x);
      SIT_SPOTS[i].y = this.getChairSeatCenterY(prop);
    }
  }

  private getChairSeatCenterY(prop: (typeof PROP_LAYOUT)[number]) {
    const tk = `${prop.folder}_${prop.file.replace('.png', '')}`;
    const source = this.textures.exists(tk)
      ? this.textures.get(tk).getSourceImage() as HTMLImageElement | HTMLCanvasElement
      : null;
    const ratio = source && source.width > 0 ? source.height / source.width : CHAIR_ASSET_RATIO;
    const displayH = prop.displayW * ratio;
    return Math.round(prop.y - displayH * CHAIR_SEAT_CENTER_RATIO);
  }

  // ==== 墙壁 / 地板 / 道具 ====

  private buildWalls() {
    if (!this.textures.exists(WALL_KEY)) return;
    const tex = this.textures.get(WALL_KEY).getSourceImage();
    const tw = tex.width * WALL_SCALE, th = tex.height * WALL_SCALE;
    const cols = Math.ceil(CANVAS_WIDTH / tw) + 1;
    const rows = Math.ceil(FLOOR_START_Y / th);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        this.add.image(c * tw, r * th, WALL_KEY).setOrigin(0, 0).setScale(WALL_SCALE).setDepth(1);
  }

  private buildFloor() {
    const keys = ['地板_地板_001', '地板_地板_002', '地板_地板_003'];
    if (!this.textures.exists(keys[0])) return;
    const tex = this.textures.get(keys[0]).getSourceImage();
    const tw = tex.width * FLOOR_SCALE, th = tex.height * FLOOR_SCALE;
    const cols = Math.ceil(CANVAS_WIDTH / tw) + 1;
    const rows = Math.ceil((CANVAS_HEIGHT - FLOOR_START_Y) / th) + 1;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const k = keys[(c + r * 3) % keys.length];
        if (!this.textures.exists(k)) continue;
        this.add.image(c * tw, FLOOR_START_Y + r * th, k).setOrigin(0, 0).setScale(FLOOR_SCALE).setDepth(0);
      }
  }

  private buildSceneAccents() {
    const g = this.add.graphics().setDepth(2);

    g.fillStyle(0x0b0710, 0.34);
    g.fillRect(0, FLOOR_START_Y - 12, CANVAS_WIDTH, 26);

    g.lineStyle(2, 0x6f5333, 0.42);
    g.lineBetween(0, FLOOR_START_Y - 2, CANVAS_WIDTH, FLOOR_START_Y - 2);
    g.lineStyle(1, 0x1b1220, 0.45);
    for (let y = FLOOR_START_Y + 34; y < CANVAS_HEIGHT; y += 42) {
      g.lineBetween(0, y, CANVAS_WIDTH, y);
    }

    this.drawRug(g, 320, 462, 260, 154, 0x421f35, 0x9a6a35);
    this.drawRug(g, 730, 462, 260, 154, 0x263b34, 0x9a6a35);

    g.fillStyle(0x000000, 0.18);
    g.fillEllipse(238, FLOOR_START_Y + 112, 350, 70);
    g.fillEllipse(460, FLOOR_START_Y + 34, 220, 36);
  }

  private drawRug(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    fill: number,
    trim: number,
  ) {
    g.fillStyle(fill, 0.46);
    g.fillRect(x - w / 2, y - h / 2, w, h);
    g.lineStyle(3, trim, 0.42);
    g.strokeRect(x - w / 2 + 4, y - h / 2 + 4, w - 8, h - 8);
    g.lineStyle(1, trim, 0.22);
    g.strokeRect(x - w / 2 + 18, y - h / 2 + 18, w - 36, h - 36);
  }

  private placeProps() {
    for (const p of PROP_LAYOUT) {
      const tk = `${p.folder}_${p.file.replace('.png', '')}`;
      if (!this.textures.exists(tk)) continue;
      const img = this.add.image(p.x, p.y, tk).setOrigin(0.5, p.originY);
      const tex = this.textures.get(tk).getSourceImage();
      img.setDisplaySize(p.displayW, p.displayW * (tex.height / tex.width));
      (img as any)._propDef = p;
      this.attachPropShadowAndLight(img, p);
      this.propImages.push(img);
    }
  }

  private placeAmbientProps() {
    for (const p of AMBIENT_PROP_LAYOUT) {
      const textureKey = this.getAmbientTextureKey(p, 0);
      if (!textureKey || !this.textures.exists(textureKey)) continue;

      let obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite;
      if (p.frameBase && p.frames && p.frames > 1) {
        const animKey = this.createAmbientAnimation(p);
        const sprite = this.add.sprite(p.x, p.y, textureKey);
        if (animKey) sprite.play(animKey);
        obj = sprite;
      } else {
        obj = this.add.image(p.x, p.y, textureKey);
      }

      const tex = this.textures.get(textureKey).getSourceImage();
      obj.setOrigin(0.5, p.originY);
      obj.setDisplaySize(p.displayW, p.displayW * (tex.height / tex.width));
      obj.setDepth(p.depth);
      (obj as any)._ambientDef = p;

      if (p.glow) this.attachAmbientGlow(obj, p);
      this.ambientObjects.push(obj);
    }

    this.syncAmbientProps();
  }

  private createAmbientAnimation(p: AmbientPropConfig) {
    if (!p.frameBase || !p.frames) return null;

    const frames = Array.from({ length: p.frames }, (_, i) => {
      const key = this.getAmbientTextureKey(p, i);
      return key && this.textures.exists(key) ? { key } : null;
    }).filter((frame): frame is { key: string } => Boolean(frame));

    if (frames.length === 0) return null;

    const animKey = `ambient_${p.key}`;
    if (!this.anims.exists(animKey)) {
      this.anims.create({
        key: animKey,
        frames,
        frameRate: p.frameRate ?? 8,
        repeat: -1,
      });
    }
    return animKey;
  }

  private getAmbientTextureKey(p: AmbientPropConfig, frame: number) {
    if (p.frameBase) return `${p.folder}_${p.frameBase}_${frame}`;
    if (p.file) return `${p.folder}_${p.file.replace('.png', '')}`;
    return null;
  }

  private resolveAmbientPosition(p: AmbientPropConfig) {
    if (p.anchorPropKey) {
      const anchor = PROP_LAYOUT.find(prop => prop.key === p.anchorPropKey);
      if (anchor) {
        return {
          x: anchor.x + (p.anchorOffsetX ?? 0),
          y: anchor.y + (p.anchorOffsetY ?? 0),
        };
      }
    }
    return { x: p.x, y: p.y };
  }

  private syncAmbientProps() {
    for (const obj of this.ambientObjects) {
      const p = (obj as any)._ambientDef as AmbientPropConfig | undefined;
      if (!p) continue;
      const pos = this.resolveAmbientPosition(p);
      obj.setPosition(pos.x, pos.y);
      obj.setDepth(p.depth);

      const glow = (obj as any)._ambientGlow as { node: Phaser.GameObjects.Arc } | undefined;
      if (glow && p.glow) {
        glow.node.setPosition(pos.x + (p.glow.offsetX ?? 0), pos.y + (p.glow.offsetY ?? 0));
        glow.node.setDepth(Math.max(3, p.depth - 1));
      }
    }
  }

  private attachAmbientGlow(obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite, p: AmbientPropConfig) {
    if (!p.glow) return;

    const pos = this.resolveAmbientPosition(p);
    const node = this.add.circle(
      pos.x + (p.glow.offsetX ?? 0),
      pos.y + (p.glow.offsetY ?? 0),
      p.glow.radius,
      p.glow.color,
      p.glow.alpha,
    ).setBlendMode(Phaser.BlendModes.ADD);
    node.setDepth(Math.max(3, p.depth - 1));

    const glowState = {
      node,
      baseAlpha: p.glow.alpha,
      baseScale: 1,
      phase: this.ambientGlows.length * 1.73,
    };
    (obj as any)._ambientGlow = glowState;
    this.ambientGlows.push(glowState);
  }

  private createAtmosphereEffects() {
    this.ensureParticleTexture('pt_dust_mote', 0xf2d49a, 0.55, 6);
    this.ensureParticleTexture('pt_fire_ember', 0xff8f3a, 0.82, 5);
    this.ensureParticleTexture('pt_gold_spark', 0xffcf78, 0.68, 4);

    const dust = this.add.particles(0, 0, 'pt_dust_mote', {
      x: { min: 48, max: CANVAS_WIDTH - 48 },
      y: { min: FLOOR_START_Y + 20, max: CANVAS_HEIGHT - 70 },
      lifespan: { min: 7600, max: 12800 },
      speedX: { min: -4, max: 8 },
      speedY: { min: -8, max: -2 },
      scale: { start: 0.45, end: 0 },
      alpha: { start: 0.12, end: 0 },
      rotate: { min: 0, max: 180 },
      quantity: 1,
      frequency: 260,
      blendMode: Phaser.BlendModes.ADD,
    });
    dust.setDepth(6);
    this.atmosphereEmitters.push(dust);

    this.createEmberEmitter(118, 104, 10, 9);
    this.createEmberEmitter(100, 126, 8, 8);

    for (const p of AMBIENT_PROP_LAYOUT) {
      if (!p.glow || !p.frameBase) continue;
      const pos = this.resolveAmbientPosition(p);
      const spark = this.add.particles(pos.x + (p.glow.offsetX ?? 0), pos.y + (p.glow.offsetY ?? 0), 'pt_gold_spark', {
        lifespan: { min: 900, max: 1500 },
        speedX: { min: -5, max: 5 },
        speedY: { min: -18, max: -6 },
        scale: { start: 0.32, end: 0 },
        alpha: { start: 0.18, end: 0 },
        quantity: 1,
        frequency: p.frameBase === '蜡烛' ? 950 : 1450,
        blendMode: Phaser.BlendModes.ADD,
      });
      spark.setDepth(Math.max(4, p.depth - 1));
      this.atmosphereEmitters.push(spark);
    }
  }

  private createEmberEmitter(x: number, y: number, spreadX: number, spreadY: number) {
    const emitter = this.add.particles(x, y, 'pt_fire_ember', {
      x: { min: -spreadX, max: spreadX },
      y: { min: -spreadY, max: spreadY },
      lifespan: { min: 900, max: 1800 },
      speedX: { min: -10, max: 14 },
      speedY: { min: -38, max: -14 },
      scale: { start: 0.48, end: 0 },
      alpha: { start: 0.42, end: 0 },
      quantity: 1,
      frequency: 180,
      blendMode: Phaser.BlendModes.ADD,
    });
    emitter.setDepth(10);
    this.atmosphereEmitters.push(emitter);
  }

  private ensureParticleTexture(key: string, color: number, alpha: number, size: number) {
    if (this.textures.exists(key)) return;
    const g = this.add.graphics();
    g.fillStyle(color, alpha);
    g.fillCircle(size, size, size);
    g.fillStyle(0xffffff, Math.min(0.7, alpha + 0.2));
    g.fillCircle(size, size, Math.max(1, size * 0.38));
    g.generateTexture(key, size * 2, size * 2);
    g.destroy();
  }

  private attachPropShadowAndLight(img: Phaser.GameObjects.Image, p: (typeof PROP_LAYOUT)[number]) {
    const isWallMounted = p.key === 'prop_fireplace' || p.key === 'prop_door';
    if (!isWallMounted) {
      const shadow = this.add.ellipse(0, 0, 1, 1, 0x000000, 0.28).setOrigin(0.5, 0.5);
      (img as any)._propShadow = shadow;
      this.syncPropShadow(img, p);
    }

    if (p.key === 'prop_fireplace') {
      const glowX = p.x + img.displayWidth * 0.08;
      const glowY = p.y + img.displayHeight * 0.48;
      const outer = this.add.circle(glowX, glowY, 90, 0xff7a24, 0.14).setBlendMode(Phaser.BlendModes.ADD);
      const inner = this.add.circle(glowX, glowY, 42, 0xffd27a, 0.18).setBlendMode(Phaser.BlendModes.ADD);
      outer.setDepth(8);
      inner.setDepth(9);
      this.fireplaceGlow.push(outer, inner);
    }
  }

  private syncPropImageAndShadow(img: Phaser.GameObjects.Image, p: (typeof PROP_LAYOUT)[number]) {
    const tex = img.texture.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    img.setDisplaySize(p.displayW, p.displayW * (tex.height / tex.width));
    img.setPosition(p.x, p.y);
    this.syncPropShadow(img, p);
  }

  private syncPropShadow(img: Phaser.GameObjects.Image, p: (typeof PROP_LAYOUT)[number]) {
    const shadow = (img as any)._propShadow as Phaser.GameObjects.Ellipse | undefined;
    if (!shadow) return;

    const groundY = p.originY === 1 ? p.y : p.y + img.displayHeight;
    const w = Math.max(28, img.displayWidth * (p.file === '椅子.png' ? 0.58 : 0.72));
    const h = Math.max(8, w * 0.22);
    shadow.setPosition(p.x, groundY - 3);
    shadow.setDisplaySize(w, h);
  }

  private updateAmbientLighting(delta: number) {
    if (this.fireplaceGlow.length === 0 && this.ambientGlows.length === 0) return;

    this.lightFlickerTime += delta / 1000;
    const flicker = 1 + Math.sin(this.lightFlickerTime * 6.7) * 0.05 + Math.sin(this.lightFlickerTime * 13.1) * 0.025;
    for (let i = 0; i < this.fireplaceGlow.length; i++) {
      const glow = this.fireplaceGlow[i];
      glow.setScale(flicker + i * 0.02);
      glow.setAlpha(i === 0 ? 0.13 + (flicker - 1) * 0.4 : 0.18 + (flicker - 1) * 0.5);
    }

    for (const glow of this.ambientGlows) {
      const pulse = 1 + Math.sin(this.lightFlickerTime * 7.4 + glow.phase) * 0.045 +
        Math.sin(this.lightFlickerTime * 15.2 + glow.phase) * 0.02;
      glow.node.setScale(glow.baseScale * pulse);
      glow.node.setAlpha(glow.baseAlpha + (pulse - 1) * 0.55);
    }
  }

  /** 绘制可行动路线网格：只在高亮区域绘制线段，障碍区透明 */
  private drawPathGrid() {
    this.gridGraphics = this.add.graphics();
    const debug = getPathfindingDebugGrid();
    const COLS = debug.cols;
    const ROWS = debug.rows;
    const cell = debug.cell;

    // Static blockers are red, dynamic blockers are amber, and clearance-cost cells are green.
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const state = debug.cells[y * COLS + x];
        if (state === 0) continue;
        const color = state === 1 ? 0xff3344 : state === 2 ? 0xffa733 : 0x48d27b;
        const alpha = state === 1 ? 0.2 : state === 2 ? 0.22 : 0.08;
        this.gridGraphics.fillStyle(color, alpha);
        this.gridGraphics.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    this.gridGraphics.lineStyle(1, 0x55d68b, 0.35);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (debug.cells[y * COLS + x] === 1) continue;
        const cx = x * cell;
        const cy = y * cell;
        if (x + 1 < COLS && debug.cells[y * COLS + x + 1] !== 1) {
          this.gridGraphics.moveTo(cx + cell, cy);
          this.gridGraphics.lineTo(cx + cell, cy + cell);
        }
        if (y + 1 < ROWS && debug.cells[(y + 1) * COLS + x] !== 1) {
          this.gridGraphics.moveTo(cx, cy + cell);
          this.gridGraphics.lineTo(cx + cell, cy + cell);
        }
      }
    }
    this.gridGraphics.strokePath();

    // 门口标记（金色菱形）
    const dx = DOOR_X, dy = DOOR_Y, dm = 8;
    this.gridGraphics.fillStyle(0xffcc00, 0.8);
    this.gridGraphics.fillTriangle(dx, dy - dm, dx + dm, dy, dx, dy + dm);  // 上半
    this.gridGraphics.fillTriangle(dx, dy - dm, dx - dm, dy, dx, dy + dm);  // 下半 = 菱形
    this.gridGraphics.setDepth(100);
    this.gridGraphics.setVisible(Boolean(this.collisionEditor?.isActive));
  }

  // ==== NPC ====

  private spawnNPCs() {
    for (let i = 0; i < this.activeNpcConfigs.length; i++) {
      const cfg = this.activeNpcConfigs[i];
      const animCfg = this.getAnimConfigForNpcConfig(cfg);
      const npc = new NPC(this, cfg, animCfg);
      npc.setChairCallback(() => this.findAndReserveChair(npc));
      npc.setDepth(200);
      // 开局只有酒保在酒馆内，其他人从门外陆续进场
      if (npc.key !== 'npc_bartender') {
        (npc as any).x = DOOR_X;
        (npc as any).y = DOOR_Y;
        npc.setAwayPose();
      }
      this.npcs.push(npc);
      this.npcMap.set(npc.key, npc);
    }

    for (const cfg of this.activeWorldNpcConfigs) {
      const animCfg = this.getAnimConfigForNpcConfig(cfg);
      const npc = new NPC(this, cfg, animCfg);
      npc.setChairCallback(() => this.findAndReserveChair(npc));
      npc.setDepth(200);
      (npc as any).x = DOOR_X;
      (npc as any).y = DOOR_Y;
      npc.setAwayPose();
      this.npcs.push(npc);
      this.npcMap.set(npc.key, npc);
    }

  }

  private getAnimConfigForNpcConfig(cfg: NPCConfig) {
    const legacyKey = LEGACY_ANIM_CACHE_KEYS[cfg.key];
    return this.cache.json.get(`npcAnim_${cfg.folderName}`) ??
      (legacyKey ? this.cache.json.get(legacyKey) : null) ??
      null;
  }

  private findAndReserveChair(npc: NPC): number | null {
    if (npc.isSitting || npc.key === 'npc_bartender') return null;

    let best = -1, bestDist = Infinity;
    for (let i = 0; i < SIT_SPOTS.length; i++) {
      if (this.chairOccupancy[i] !== null) continue;
      const s = SIT_SPOTS[i];
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, s.x, s.y);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best < 0) return null;

    this.chairOccupancy[best] = npc.key;
    const spot = SIT_SPOTS[best];
    npc.assignChair(best, spot.x, spot.y, spot.facing);
    return best;
  }

  private maybeActivateWorldNpcForSegment(segmentId: number) {
    if (this.worldNpcLastRollSegment === segmentId) return;
    this.worldNpcLastRollSegment = segmentId;

    const activeVisitors = this.npcs.filter(n => this.isWorldNpc(n.key) && !n.isAway);
    if (activeVisitors.length > 0) return;
    if (Math.random() > WORLD_NPC_ENTRY_CHANCE) return;

    const candidates = this.npcs.filter(n => this.isWorldNpc(n.key) && n.isAway);
    if (candidates.length === 0) return;

    const npc = Phaser.Utils.Array.GetRandom(candidates);
    const entry = Phaser.Utils.Array.GetRandom(WORLD_NPC_ENTRY_POINTS);
    npc.returnFromDoor('world_guest');
    npc.walkTo(entry.x, entry.y, 4 + Math.random() * 2);
  }

  private getParticipatingNpcs() {
    return this.npcs.filter(n => !this.isWorldNpc(n.key) || !n.isAway);
  }

  private isWorldNpc(npcKey: string) {
    return this.worldNpcKeys.has(npcKey);
  }

  private findNpcConfig(npcKey: string) {
    return this.activeNpcConfigs.find(c => c.key === npcKey) ??
      this.activeWorldNpcConfigs.find(c => c.key === npcKey) ??
      NPC_CONFIGS.find(c => c.key === npcKey) ??
      WORLD_INTERACTION_NPC_CONFIGS.find(c => c.key === npcKey);
  }

  // ==== 主循环 ====

  update(_time: number, delta: number) {
    if (this.worldRunner.isRunning) {
      const actions = this.behaviorLog.update(delta);
      this.updateGuidanceMarquee();
      for (const action of actions) {
        this.executeAction(action);
      }

      // 检测段完成：只在跨过整段末尾时触发，避免开跑第 1 秒就扣一轮
      const currentTick = this.behaviorLog.currentTick;
      if (currentTick > this.activeStartTick && currentTick % SEGMENT_LENGTH === 0) {
        const completedSeg = currentTick / SEGMENT_LENGTH - 1;
        if (completedSeg > this.lastCompletedSegment) {
          this.currentRound = completedSeg + 1;
          this.lastCompletedSegment = completedSeg;
          bus.emit('world:roundComplete');
          bus.emit('round:changed', { currentRound: this.currentRound, latestStoredRound: this.latestStoredRound });
        }
      }

      // WorldRunner tick
      if (actions.length > 0 || this.behaviorLog.currentTick > this.worldRunner.elapsed) {
        while (this.worldRunner.elapsed < this.behaviorLog.currentTick) {
          const ok = this.worldRunner.tick();
          if (!ok) {
            this.stopWorld();
            break;
          }
        }
      }

      // 预取下一轮
      if (
        this.worldRunner.isRunning &&
        this.behaviorLog.needsPrefetch() &&
        !this.tickRequestPending
      ) {
        const nextStart = this.behaviorLog.nextPrefetchStart();
        const targetStop = this.worldRunner.targetStopTick;
        if (targetStop < 0 || nextStart + 20 <= targetStop) {
          this.advanceRound(nextStart, this.behaviorLog.topic);
        }
      }
    }

    if (!this.behaviorLog.isPaused) {
      // 动态阻挡：标记每个非隐身 NPC 的格子，后续 A* 自动避开
      clearDynamicBlocks();
      for (const npc of this.npcs) {
        if (npc.isAway) continue;
        blockCell(npc.x, npc.y, npc.isSitting ? 0 : 1);
      }
      for (const npc of this.npcs) npc.update(_time, delta);
    }

    this.updateAmbientLighting(delta);
    this.ySortAll();
    this.updateBubbles();
  }

  // ==== 动作分发 ====

  private executeAction(a: NPCAction & { npc?: string }) {
    const npcKey = a.npc ?? '';

    if (a.action === 'user_event' && a.line) {
      const someNpc = this.npcs.find(n => !n.isAway);
      if (someNpc) {
        this.showBubble(someNpc, `「${a.line}」`, 4000, '👤 用户');
      }
      return;
    }

    const npc = this.npcMap.get(`npc_${npcKey}`);
    if (!npc) return;

    switch (a.action) {
      case 'idle':
        if (!npc.isAway) npc.setIdlePose(npc.facing);
        break;

      case 'walk_to':
        if (npcKey === 'bartender') return;
        if (a.x != null && a.y != null) {
          if (npc.isAway) {
            npc.returnFromDoor();
          }
          this.releaseChair(npc);
          npc.walkTo(a.x, a.y, a.duration_sec);
        }
        break;

      case 'sit':
        if (npcKey === 'bartender') return;
        if (a.x != null && a.y != null) {
          if (npc.isAway) npc.returnFromDoor();
          const chairIdx = SIT_SPOTS.findIndex(
            s => Math.abs(s.x - a.x!) < 10 && Math.abs(s.y - a.y!) < 10
          );
          if (chairIdx >= 0 && this.chairOccupancy[chairIdx] == null) {
            this.releaseChair(npc);
            this.chairOccupancy[chairIdx] = npc.key;
            const spot = SIT_SPOTS[chairIdx];
            npc.assignChair(chairIdx, spot.x, spot.y, spot.facing);
          } else if (chairIdx < 0) {
            this.releaseChair(npc);
            npc.sitAt(a.x, a.y);
          }
        }
        break;

      case 'stand':
        this.releaseChair(npc);
        npc.standUp();
        break;

      case 'leave_tavern':
        if (npcKey === 'bartender') return;
        if (npc.isAway) return;
        this.releaseChair(npc);
        npc.walkTo(DOOR_X, DOOR_Y, a.duration_sec ?? 4);
        break;

      case 'talk':
        if (a.line) {
          if (npc.isAway) return;
          const charCount = a.line.replace(/\s/g, '').length;
          const autoDur = Math.max(3000, Math.min(14000, charCount * 120));
          const cfg = this.findNpcConfig(`npc_${npcKey}`);
          const charName = this.characterCards.get(npcKey)?.name ??
            CHARACTERS.find(c => c.key === npcKey)?.name ??
            cfg?.folderName ??
            npcKey;
          this.showBubble(npc, a.line, a.duration_sec ? a.duration_sec * 1000 : autoDur, charName);
          npc.setConversationCooldown();
          npc.playActionAnim('talk');
          if (a.to) {
            const target = this.npcMap.get(`npc_${a.to}`);
            if (target) npc.lookAt(target.x, target.y);
          }
        }
        break;

      case 'emote':
        if (a.emote && !npc.isAway) {
          npc.emoteBubble(a.emote);
          if (a.emote === 'sleepy') {
            this.releaseChair(npc);
            npc.setDozingPose(npc.facing);
          }
        }
        break;

      case 'look_at':
        if (a.to) {
          const target = this.npcMap.get(`npc_${a.to}`);
          if (target) npc.lookAt(target.x, target.y);
        }
        break;
    }
  }

  private releaseChair(npc: NPC) {
    const ci = npc.chairIndex;
    if (ci >= 0 && this.chairOccupancy[ci] === npc.key) {
      this.chairOccupancy[ci] = null;
    }
  }

  private setGuidanceForSegment(segment: number, guidance: string) {
    const text = guidance.trim();
    if (text) this.guidanceBySegment.set(segment, text);
  }

  private updateGuidanceMarquee() {
    const segment = Math.floor(this.behaviorLog.currentTick / SEGMENT_LENGTH);
    if (segment === this.visibleGuidanceSegment) return;

    const guidance = this.guidanceBySegment.get(segment);
    if (guidance) {
      this.showGuidanceMarquee(segment, guidance);
    } else {
      this.hideGuidanceMarquee();
    }
  }

  private showGuidanceMarquee(segment: number, guidance: string) {
    const el = document.getElementById('guidance-marquee');
    const textEl = el?.querySelector('span');
    if (!el || !textEl) return;
    textEl.textContent = `R${segment} 引导：${guidance.replace(/\s+/g, ' ')}`;
    // 重置动画，只滚一遍，滚完后静态显示
    textEl.style.animation = 'none';
    textEl.style.paddingLeft = '100%';
    void textEl.offsetWidth; // force reflow
    textEl.style.animation = 'guidance-scroll 24s linear 1';
    el.style.display = 'block';
    this.visibleGuidanceSegment = segment;

    // 动画结束后隐藏引导
    const onEnd = () => {
      textEl.removeEventListener('animationend', onEnd);
      el.style.display = 'none';
    };
    textEl.addEventListener('animationend', onEnd);
  }

  private hideGuidanceMarquee() {
    const el = document.getElementById('guidance-marquee');
    if (el) el.style.display = 'none';
    this.visibleGuidanceSegment = -1;
  }

  // ==== Y 排序 ====

  private ySortAll() {
    // 先建好道具的地面 Y 映射，供锚定环境物件查询
    const propGroundY = new Map<string, number>();
    const pe = this.propImages.map(img => {
      const pd = (img as any)._propDef;
      const gy = this.getPropGroundY(pd, img);
      propGroundY.set(pd.key, gy);
      return { obj: img, groundY: gy, id: pd.key, isAmbient: false, isAnchoredAmbient: false };
    });
    // 环境物件：锚定道具上的用母道具 groundY + depth 偏移（保证渲染在桌面之上）
    const ae = this.ambientObjects.map(obj => {
      const ad = (obj as any)._ambientDef as AmbientPropConfig | undefined;
      const ownGy = ad ? Math.round(ad.originY === 1 ? obj.y : obj.y + obj.displayHeight) : Math.round(obj.y + obj.displayHeight);
      const anchorGy = ad?.anchorPropKey ? (propGroundY.get(ad.anchorPropKey) ?? ownGy) : ownGy;
      const localOffset = ad?.anchorPropKey ? Math.max(1, ad.depth ?? 1) : 0;
      return {
        obj,
        groundY: anchorGy + localOffset,
        id: ad?.key ?? 'ambient',
        isAmbient: true,
        isAnchoredAmbient: Boolean(ad?.anchorPropKey),
        anchorPropKey: ad?.anchorPropKey,
      };
    });
    const ne = this.npcs.filter(n => !n.isAway).map(n => ({ obj: n, groundY: this.getNpcGroundY(n), id: n.key, isAmbient: false, isAnchoredAmbient: false, anchorPropKey: undefined }));
    const all = [...pe, ...ae, ...ne];
    all.sort((a, b) => {
      const d = a.groundY - b.groundY;
      if (d === 0) {
        const priority = this.getRenderTiePriority(a) - this.getRenderTiePriority(b);
        if (priority !== 0) return priority;
        const ai = a.obj instanceof Phaser.GameObjects.Image;
        const bi = b.obj instanceof Phaser.GameObjects.Image;
        if (ai && !bi) return -1;
        if (!ai && bi) return 1;
      }
      return d;
    });
    // 统一按 Y 排序；锚定环境使用母元素排序组，不把自身 depth 当全局深度。
    // 碰撞编辑器中手动设置的道具 depth > 0 时叠加到自动计算值上。
    all.forEach((e, i) => {
      const isNPC = !(e.obj instanceof Phaser.GameObjects.Image) && !e.isAmbient;
      const customDepth = this.getRenderCustomDepth(e);
      e.obj.setDepth(10 + i * 2 + (isNPC ? 1 : 0) + customDepth);
      if (!isNPC && !e.isAmbient) {
        const shadow = (e.obj as any)._propShadow as Phaser.GameObjects.Ellipse | undefined;
        if (shadow) shadow.setDepth(Math.max(2, e.obj.depth - 1));
      }
      // 环境物件的辉光跟随物件深度
      const glow = (e.obj as any)._ambientGlow as { node: Phaser.GameObjects.Arc } | undefined;
      if (glow) glow.node.setDepth(Math.max(3, e.obj.depth - 1));
    });
  }

  private getRenderTiePriority(e: { obj: Phaser.GameObjects.GameObject; isAmbient: boolean; isAnchoredAmbient: boolean }) {
    if (e.isAnchoredAmbient) return 3;
    if (!(e.obj instanceof Phaser.GameObjects.Image) && !e.isAmbient) return 2;
    if (!e.isAmbient) return 1;
    return 0;
  }

  private getRenderCustomDepth(e: { obj: Phaser.GameObjects.GameObject; isAnchoredAmbient: boolean; anchorPropKey?: string }) {
    const propDepth = (e.obj as any)._propDef?.depth || 0;
    if (propDepth) return propDepth;
    if (e.isAnchoredAmbient) {
      const anchorDepth = e.anchorPropKey ? ((PROP_LAYOUT.find(p => p.key === e.anchorPropKey) as any)?.depth || 0) : 0;
      return anchorDepth;
    }
    return (e.obj as any)._ambientDef?.depth || 0;
  }

  private getNpcGroundY(npc: NPC) {
    // 坐姿：对齐椅子 groundY + offset，保证 NPC 在椅子前面渲染
    if (npc.isSitting) {
      let chairIdx = npc.chairIndex;
      if (chairIdx < 0) {
        chairIdx = SIT_SPOTS.findIndex(
          s => Math.abs(s.x - npc.x) < 25 && Math.abs(s.y - npc.y) < 25,
        );
      }
      if (chairIdx >= 0) {
        const chairPropKey = SEAT_PROP_KEYS[chairIdx];
        const chairProp = chairPropKey ? PROP_LAYOUT.find(p => p.key === chairPropKey) : null;
        if (chairProp) return this.getPropGroundY(chairProp) + 3;
      }
    }
    return Math.round(npc.y);
  }

  private getPropGroundY(prop: (typeof PROP_LAYOUT)[number], img?: Phaser.GameObjects.Image) {
    if (prop.originY === 1) return Math.round(prop.y);
    if (img) return Math.round(prop.y + img.displayHeight);

    const textureKey = `${prop.folder}_${prop.file.replace('.png', '')}`;
    const source = this.textures.exists(textureKey)
      ? this.textures.get(textureKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement
      : null;
    const ratio = source && source.width > 0 ? source.height / source.width : 1;
    return Math.round(prop.y + prop.displayW * ratio);
  }

  // ==== 轮次推进（历史=读DB / 最新=请求LLM） ====

  /**
   * 根据 segmentStart 对应的 segmentId 判断：
   * - 如果 segmentId 在 storedSegmentSet 中 → 历史轮次，从后端加载已有 plan
   * - 否则 → 最新轮次，请求 LLM
   */
  private async advanceRound(segmentStart: number, currentTopic: string) {
    const segmentId = segmentStart / SEGMENT_LENGTH;

    if (this.storedSegmentSet.has(segmentId)) {
      await this.loadHistoricalRound(segmentId);
    } else {
      await this.requestLLMRound(segmentStart, currentTopic);
    }
  }

  /** 从 DB 加载历史轮次的 plan，直接喂给 BehaviorLog */
  private async loadHistoricalRound(segmentId: number) {
    const segKey = segmentId;
    if (this.requestedSegments.has(segKey)) return;
    this.requestedSegments.add(segKey);
    this.tickRequestPending = true;

    try {
      const resp = await fetch(`${API_BASE}/api/world/replay?from_segment=${segmentId}&to_segment=${segmentId}`);
      if (!resp.ok) { this.worldRunner.pause(); this.tickRequestPending = false; return; }
      const data = await resp.json();
      const segs = data.segments || [];
      if (segs.length === 0) { this.worldRunner.pause(); this.tickRequestPending = false; return; }

      const s = segs[0];
      const plan = [...(s.plan || [])];
      const guidanceLines: string[] = [];
      // 合并用户事件
      if (s.user_events && s.user_events.length > 0) {
        guidanceLines.push(...s.user_events.map((ue: any) => String(ue.message || '')).filter(Boolean));
        plan.unshift({
          npc: '用户',
          actions: s.user_events.map((ue: any) => ({
            sec: Math.max(0, ue.tick - segmentId * SEGMENT_LENGTH),
            action: 'user_event' as const,
            line: ue.message,
          })),
        });
      }

      this.setGuidanceForSegment(segmentId, guidanceLines.join('\n'));
      this.behaviorLog.appendPlan(segmentId * SEGMENT_LENGTH, plan, s.topic || '');
      // NPC 状态只在用户显式切换轮次时恢复；预取历史段不能提前把角色跳到下一段起点。
      // 历史轮次的条目已在 rebuildHistory 中渲染，无需重复 emit

      // 历史数据加载后立即恢复播放
      if (this.worldRunner.isRunning && this.behaviorLog.isPaused) {
        this.behaviorLog.resume();
      }
    } catch (err) {
      console.warn('[历史轮次] 加载失败', err);
      this.worldRunner.pause();
    }

    this.tickRequestPending = false;
  }

  /** 请求 LLM 生成新一轮 plan */
  private async requestLLMRound(segmentStart: number, currentTopic: string) {
    const segIdx = segmentStart / SEGMENT_LENGTH;
    if (this.requestedSegments.has(segIdx)) return;
    this.requestedSegments.add(segIdx);
    this.tickRequestPending = true;
    this.maybeActivateWorldNpcForSegment(segIdx);

    const participating = this.getParticipatingNpcs();
    const activeNpcKeys = new Set(participating.map(n => n.key.replace('npc_', '')));

    const states = participating.map((n) => {
      const cfg = this.findNpcConfig(n.key);
      const card = this.characterCards.get(n.key.replace('npc_', '')) ??
        CHARACTERS.find(c => c.key === n.key.replace('npc_', ''));
      let currentAction = 'idle';
      if (n.isAway) currentAction = 'away_from_tavern';
      else if (n.isSitting) currentAction = `sitting_at_chair_${n.chairIndex}`;
      else if (n.isSpecial) currentAction = 'dozing_in_corner';
      else if (n.key === 'npc_bartender') currentAction = 'standing_behind_counter';

      return {
        key: n.key.replace('npc_', ''),
        name: card?.name ?? cfg?.folderName ?? n.key.replace('npc_', ''),
        personality: card?.personality ?? '',
        current_action: currentAction,
        x: Math.round(n.isAway ? DOOR_X : n.x),
        y: Math.round(n.isAway ? DOOR_Y : n.y),
        facing: n.facing,
      };
    });

    const occupied: Record<string, string> = {};
    this.chairOccupancy.forEach((k, i) => { if (k) occupied[String(i)] = k.replace('npc_', ''); });

    const available: number[] = [];
    for (let i = 0; i < SIT_SPOTS.length; i++) {
      if (this.chairOccupancy[i] === null) available.push(i);
    }

    const recentDialogues = this.behaviorLog.getRecentDialogues(80).filter(
      d => activeNpcKeys.has(d.speaker) && (!d.to || activeNpcKeys.has(d.to)),
    );
    const userMsg = consumeUserMessage();
    const requestMeta = {
      segment: segIdx,
      npcCount: states.length,
      dialogueCount: recentDialogues.length,
      userGuidance: Boolean(userMsg.trim()),
      topic: currentTopic,
    };
    bus.emit('llm:request', {
      state: 'pending',
      ...requestMeta,
    });

    let llmSuccess = false;
    try {
      const resp = await fetch(`${API_BASE}/api/world/tick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tick: segmentStart / SEGMENT_LENGTH,
          current_topic: currentTopic,
          npc_states: states,
          dialogue_history: recentDialogues,
          occupied_chairs: occupied,
          available_chairs: available,
          user_message: userMsg,
        }),
      });

      if (resp.ok) {
        const data: WorldTickResponse = await resp.json();
        if (data.plan && data.plan.length > 0) {
          const guidanceText = data.user_guidance || userMsg;
          const guidanceTimeline = guidanceText
            ? [{ npc: '用户', actions: [{ sec: 0, action: 'user_event' as const, line: guidanceText }] }]
            : [];
          const fullPlan = [...guidanceTimeline, ...data.plan];
          const actionCount = data.plan.reduce((sum, timeline) => sum + (timeline.actions?.length || 0), 0);
          this.setGuidanceForSegment(segmentStart / SEGMENT_LENGTH, guidanceText);
          this.behaviorLog.appendPlan(segmentStart, fullPlan, data.topic || '');
          llmSuccess = true;
          bus.emit('llm:request', {
            state: 'success',
            ...requestMeta,
            actionCount,
            topic: data.topic || currentTopic,
            cache: data.cache,
          });
          // 记录该轮已存储，后续可作为历史回放
          this.storedSegmentSet.add(segmentStart / SEGMENT_LENGTH);
          if (segmentStart / SEGMENT_LENGTH > this.latestStoredRound) {
            this.latestStoredRound = segmentStart / SEGMENT_LENGTH;
          }
          bus.emit('history:add', {
            timestamp: new Date().toISOString(),
            tick: Math.floor(segmentStart / SEGMENT_LENGTH),
            topic: data.topic,
            segmentStart,
            plan: fullPlan,
          });
        } else {
          console.warn('[世界] LLM 返回空计划，暂停世界运行');
          bus.emit('llm:request', {
            state: 'error',
            ...requestMeta,
            message: '模型返回空计划',
          });
          this.worldRunner.pause();
        }
      } else {
        console.warn(`[世界] LLM 请求失败 HTTP ${resp.status}，暂停世界运行`);
        bus.emit('llm:request', {
          state: 'error',
          ...requestMeta,
          message: `HTTP ${resp.status}`,
        });
        this.worldRunner.pause();
      }
    } catch (err) {
      console.warn('[世界] LLM 连接错误，暂停世界运行', err);
      bus.emit('llm:request', {
        state: 'error',
        ...requestMeta,
        message: err instanceof Error ? err.message : '连接错误',
      });
      this.worldRunner.pause();
    }

    // 失败时移除标记，允许后续重试
    if (!llmSuccess) {
      this.requestedSegments.delete(segIdx);
    }

    if (llmSuccess && this.worldRunner.isRunning && this.behaviorLog.isPaused) {
      this.behaviorLog.resume();
    }

    this.tickRequestPending = false;
  }

  // ==== 对话气泡 ====

  private showBubble(npc: NPC, text: string, durMs: number, speakerName?: string) {
    this.hideBubble(npc);
    const b = new SpeechBubble(this, npc.x, npc.y + npc.contentTopY - 12, text, speakerName);
    b.show(durMs / 1000);
    this.bubbles.set(String(this.npcs.indexOf(npc)), b);
  }

  private hideBubble(npc: NPC) {
    const k = String(this.npcs.indexOf(npc));
    const b = this.bubbles.get(k);
    if (b) { b.hide(); this.bubbles.delete(k); }
  }

  private updateBubbles() {
    for (const [k, b] of this.bubbles) {
      const npc = this.npcs[Number(k)];
      b.updatePosition(npc.x, npc.y, npc.spriteHeight);
      if (b.isExpired()) { b.hide(); this.bubbles.delete(k); }
    }
  }
}
