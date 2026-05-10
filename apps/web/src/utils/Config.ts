/** 可配置常量，替代散落的魔法数字。 */

// 世界 Tick
export const SEGMENT_LENGTH = 30;
export const PREFETCH_AHEAD = 25;

// 行为日志
export const MAX_HISTORY_ENTRIES = 30;
export const MEMORY_REFRESH_MS = 5000;
export const STATE_POLL_MS = 500;

// 后端重建重试
export const REBUILD_MAX_TRIES = 30;

// 气泡时长
export const BUBBLE_MIN_MS = 3000;
export const BUBBLE_MAX_MS = 14000;
export const BUBBLE_CHAR_MS = 120;

// Emote
export const EMOTE_DURATION_MS = 2500;

// NPC
export const STUCK_SIDESTEP_TIME = 0.4;
export const STUCK_DETOUR_TIME = 1.5;
export const STUCK_TELEPORT_TIME = 3.0;
export const STUCK_DETOUR_DIST = 60;
export const WAYPOINT_REACH_RADIUS = 5;
export const CHAIR_SEEK_TIMEOUT_MS = 20000;
export const CHAIR_SIT_APPROACH_RADIUS = 24;
export const NPC_MIN_WALK_SPEED = 26;
export const NPC_MAX_WALK_SPEED = 110;

// 寻路
export const PATHFINDING_CELL = 20;
export const NAVIGATION_PADDING_PX = 8;
export const NAVIGATION_CLEARANCE_CELLS = 2;
export const DYNAMIC_BLOCK_RADIUS_CELLS = 1;

// 日历
export const CALENDAR_START = '1500-01-01';
export const SECONDS_PER_DAY = 180;

// UI 颜色
export const COLORS = {
  success: '#6a9',
  error: '#e66',
  loading: '#c9a96e',
  muted: '#888',
  empty: '#555',
} as const;
