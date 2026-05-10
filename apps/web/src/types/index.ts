export type Direction = 'front' | 'back' | 'left' | 'right';

export interface NPCConfig {
  key: string;
  folderName: string;
  startX: number;
  startY: number;
  wanderMinX: number;
  wanderMaxX: number;
  wanderMinY: number;
  wanderMaxY: number;
  patrolSpeed?: number;
  tooltip?: string;
}

// ==== 角色卡（给 AI 用） ====
export interface CharacterCard {
  key: string;
  name: string;
  personality: string;
  traits: string[];
  speechStyle: string;
  folderName?: string;
  appearance?: 'core' | 'visitor' | 'disabled';
  backgroundPrompt?: string;
  relationships?: string;
  startX?: number;
  startY?: number;
  readOnly?: boolean;
}

// ==== 世界 Tick 数据契约 ====

export interface NPCStateSnapshot {
  key: string;
  name: string;
  personality: string;
  current_action: string;
  x: number;
  y: number;
  facing: string;
}

export interface DialogueRecord {
  sec: number;
  speaker: string;
  line: string;
  to?: string;
}

export interface WorldTickRequest {
  tick: number;
  current_topic: string;
  npc_states: NPCStateSnapshot[];
  dialogue_history: DialogueRecord[];
  occupied_chairs: Record<string, string>;
  available_chairs: number[];
}

export type NPCActionType = 'idle' | 'walk_to' | 'sit' | 'stand' | 'talk' | 'emote' | 'leave_tavern' | 'look_at' | 'user_event';

export interface NPCAction {
  sec: number;
  action: NPCActionType;
  duration_sec?: number;
  line?: string;
  to?: string;
  x?: number;
  y?: number;
  emote?: string;
}

export interface NPCTimeline {
  npc: string;
  actions: NPCAction[];
}

export interface WorldTickResponse {
  tick: number;
  topic: string;
  plan: NPCTimeline[];
  user_guidance?: string;
  cache?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens: number;
    prompt_cache_miss_tokens: number;
  };
}

// ==== 行为日志 ====

export interface ActionRecord {
  tick: number;
  sec: number;
  npc: string;
  action: NPCActionType;
  duration_sec?: number;
  line?: string;
  to?: string;
  x?: number;
  y?: number;
  emote?: string;
  timestamp: number;
}

// ==== BehaviorLog 队列 ====

export interface PlanSegment {
  startTick: number;
  plan: NPCTimeline[];
}

// ==== WorldRunner ====

export type WorldState = 'idle' | 'running' | 'paused';
