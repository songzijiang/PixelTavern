import type { NPCConfig } from './types';

export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 640;

export const FLOOR_SCALE = 0.07;
export const WALL_SCALE = 0.15;
export const NPC_TARGET_HEIGHT = 192;
export const NPC_PATROL_SPEED = 30;
export const ASSET_PATH = 'assets/';
export const WALL_KEY = '墙壁_墙壁_001';
export const FLOOR_START_Y = 200;
export const DOOR_X = 880;
export const DOOR_Y = 180;
export const DOOR_RADIUS = 55;
export const CHAIR_ASSET_RATIO = 475 / 289;
export const CHAIR_SEAT_CENTER_RATIO = 0.34;

export interface PropConfig {
  key: string;
  folder: string;
  file: string;
  x: number;
  y: number;
  displayW: number;
  originY: number;
}

export interface AmbientPropConfig {
  key: string;
  folder: string;
  file?: string;
  frameBase?: string;
  frames?: number;
  frameRate?: number;
  anchorPropKey?: string;
  anchorOffsetX?: number;
  anchorOffsetY?: number;
  x: number;
  y: number;
  displayW: number;
  originY: number;
  depth: number;
  glow?: {
    color: number;
    radius: number;
    alpha: number;
    offsetX?: number;
    offsetY?: number;
  };
}

export const PROP_LAYOUT: PropConfig[] = [
  { key: 'prop_fireplace', folder: '物体', file: '炉火.png', x: 100, y: 0, displayW: 200, originY: 0 },
  { key: 'prop_door', folder: '物体', file: '门.png', x: 870, y: 21, displayW: 140, originY: 0 },
  { key: 'prop_barrel1', folder: '物体', file: '酒桶.png', x: 394, y: 142, displayW: 70, originY: 0 },
  { key: 'prop_barrel2', folder: '物体', file: '酒桶.png', x: 462, y: 143, displayW: 70, originY: 0 },
  { key: 'prop_barrel3', folder: '物体', file: '酒桶.png', x: 526, y: 144, displayW: 70, originY: 0 },
  { key: 'prop_counter', folder: '桌椅', file: '柜台.png', x: 99, y: 191, displayW: 340, originY: 0 },
  // 桌子1（左）+ 4 把椅子
  { key: 'prop_table1', folder: '桌椅', file: '桌子.png', x: 322, y: 494, displayW: 180, originY: 1 },
  { key: 'prop_chair1_top', folder: '桌椅', file: '椅子.png', x: 320, y: 396, displayW: 90, originY: 1 },
  { key: 'prop_chair1_bottom', folder: '桌椅', file: '椅子.png', x: 316, y: 563, displayW: 90, originY: 1 },
  { key: 'prop_chair1_left', folder: '桌椅', file: '椅子.png', x: 200, y: 497, displayW: 90, originY: 1 },
  { key: 'prop_chair1_right', folder: '桌椅', file: '椅子.png', x: 445, y: 495, displayW: 90, originY: 1 },
  // 桌子2（右）+ 4 把椅子
  { key: 'prop_table2', folder: '桌椅', file: '桌子.png', x: 727, y: 492, displayW: 180, originY: 1 },
  { key: 'prop_chair2_top', folder: '桌椅', file: '椅子.png', x: 730, y: 395, displayW: 90, originY: 1 },
  { key: 'prop_chair2_bottom', folder: '桌椅', file: '椅子.png', x: 728, y: 556, displayW: 90, originY: 1 },
  { key: 'prop_chair2_left', folder: '桌椅', file: '椅子.png', x: 621, y: 503, displayW: 90, originY: 1 },
  { key: 'prop_chair2_right', folder: '桌椅', file: '椅子.png', x: 844, y: 509, displayW: 90, originY: 1 },
];

export const AMBIENT_PROP_LAYOUT: AmbientPropConfig[] = [
  { key: 'ambient_wall_lamp_left', folder: '物体', frameBase: '壁灯', frames: 4, frameRate: 7, x: 352, y: 78, displayW: 54, originY: 0.5, depth: 7, glow: { color: 0xffa044, radius: 70, alpha: 0.08 } },
  { key: 'ambient_wall_lamp_right', folder: '物体', frameBase: '壁灯', frames: 4, frameRate: 7, x: 599, y: 73, displayW: 54, originY: 0.5, depth: 7, glow: { color: 0xffa044, radius: 70, alpha: 0.08 } },
  { key: 'ambient_hanging_lantern', folder: '物体', frameBase: '吊灯', frames: 4, frameRate: 6, x: 785, y: 31, displayW: 58, originY: 0.18, depth: 10, glow: { color: 0xffb45c, radius: 84, alpha: 0.07, offsetY: 30 } },
  { key: 'ambient_counter_candle', folder: '物体', frameBase: '蜡烛', frames: 4, frameRate: 8, anchorPropKey: 'prop_counter', anchorOffsetX: 121, anchorOffsetY: 29, x: 220, y: 220, displayW: 34, originY: 1, depth: 1, glow: { color: 0xffbd5c, radius: 42, alpha: 0.09, offsetY: -22 } },
  { key: 'ambient_table1_candle', folder: '物体', frameBase: '蜡烛', frames: 4, frameRate: 8, anchorPropKey: 'prop_table1', anchorOffsetX: 15, anchorOffsetY: -96, x: 337, y: 398, displayW: 36, originY: 1, depth: 1, glow: { color: 0xffbd5c, radius: 46, alpha: 0.09, offsetY: -24 } },
  { key: 'ambient_table2_candle', folder: '物体', frameBase: '蜡烛', frames: 4, frameRate: 8, anchorPropKey: 'prop_table2', anchorOffsetX: 32, anchorOffsetY: -100, x: 759, y: 392, displayW: 36, originY: 1, depth: 1, glow: { color: 0xffbd5c, radius: 46, alpha: 0.09, offsetY: -24 } },
  { key: 'ambient_table1_mug', folder: '物体', file: '酒杯.png', anchorPropKey: 'prop_table1', anchorOffsetX: -29, anchorOffsetY: -86, x: 293, y: 408, displayW: 38, originY: 1, depth: 2 },
  { key: 'ambient_table2_scroll', folder: '物体', file: '羊皮纸.png', anchorPropKey: 'prop_table2', anchorOffsetX: -18, anchorOffsetY: -99, x: 709, y: 393, displayW: 48, originY: 1, depth: 2 },
  { key: 'ambient_counter_coins', folder: '物体', file: '金币.png', anchorPropKey: 'prop_counter', anchorOffsetX: 54, anchorOffsetY: 29, x: 153, y: 220, displayW: 34, originY: 1, depth: 2 },
];

export interface CollisionZone {
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

export const COLLISION_ZONES: CollisionZone[] = [
  { x: 100, y: 140, halfW: 90, halfH: 70 },        // 壁炉
  { x: 395, y: 194, halfW: 35, halfH: 35 },        // 酒桶1
  { x: 459, y: 197, halfW: 35, halfH: 35 },        // 酒桶2
  { x: 524, y: 194, halfW: 35, halfH: 35 },        // 酒桶3
  { x: 129, y: 265, halfW: 124, halfH: 70 },       // 吧台
  { x: 319, y: 389, halfW: 54, halfH: 26 },        // 桌子1
  { x: 730, y: 380, halfW: 55, halfH: 24 },        // 桌子2
];

export const NPC_CONFIGS: NPCConfig[] = [
  { key: 'npc_bartender', folderName: '酒保',
    startX: 230, startY: 280,
    wanderMinX: 120, wanderMaxX: 440,
    wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 500,
    tooltip: '格里芬·铁桶\n矮人 · 酒馆老板\n"再来一杯？这杯算我的。"' },
  { key: 'npc_warrior', folderName: '勇士',
    startX: 400, startY: 420,
    wanderMinX: 150, wanderMaxX: 880,
    wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
    tooltip: '艾德琳·钢刃\n人类 · 流浪佣兵\n"荣耀不在于不败，而在于永不言弃。"' },
  { key: 'npc_witch', folderName: '女巫',
    startX: 650, startY: FLOOR_START_Y + 100,
    wanderMinX: 150, wanderMaxX: 880,
    wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
    tooltip: '莫尔加娜·暗星\n暗精灵 · 术士/情报贩子\n"命运之线早已织就……"' },
  { key: 'npc_mysterious', folderName: '神秘客',
    startX: 780, startY: 530,
    wanderMinX: 120, wanderMaxX: 880,
    wanderMinY: 300, wanderMaxY: 580,
    tooltip: '代号「渡鸦」\n身份不详\n"不该问的事，别问。"' },
];

export const WORLD_INTERACTION_NPC_CONFIGS: NPCConfig[] = [
  { key: 'npc_poet', folderName: '诗人',
    startX: DOOR_X, startY: DOOR_Y,
    wanderMinX: 120, wanderMaxX: 880,
    wanderMinY: 300, wanderMaxY: 580,
    tooltip: '莱昂·风歌\n半精灵 · 随机访客\n"今晚的副歌要不要写得危险一点？"' },
  { key: 'npc_ranger', folderName: '游侠',
    startX: DOOR_X, startY: DOOR_Y,
    wanderMinX: 120, wanderMaxX: 880,
    wanderMinY: 300, wanderMaxY: 580,
    tooltip: '希尔瓦娜·影步\n木精灵 · 随机访客\n"风向不对。门外有人。"' },
];

export const DEFAULT_STYLE_KEY = 'dark_border';

export const STYLE_NPC_CONFIGS: Record<string, NPCConfig[]> = {
  dark_border: NPC_CONFIGS,
  court_intrigue: [
    { key: 'npc_bartender', folderName: '宫廷老管家',
      startX: 200, startY: FLOOR_START_Y + 95,
      wanderMinX: 120, wanderMaxX: 440,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 500,
      tooltip: '塞维安·灰钥\n人类 · 地下会所主持者\n"在这里，姓氏只是一件可暂存的外衣。"' },
    { key: 'npc_warrior', folderName: '宫廷护卫',
      startX: 400, startY: 420,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '伊莎贝尔·赤誓\n人类 · 失势卫队长\n"我守的不是王冠，是出口。"' },
    { key: 'npc_witch', folderName: '宫廷占星师',
      startX: 650, startY: FLOOR_START_Y + 100,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '薇奥兰·银相\n人类 · 前宫廷占星师\n"星象从不撒谎，只会让人后悔听懂。"' },
    { key: 'npc_mysterious', folderName: '流亡情报官',
      startX: 780, startY: 530,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '卢修斯·黑蜡\n人类 · 流亡贵族密探\n"真正的友谊需要更多象征。"' },
  ],
  mercenary_comedy: [
    { key: 'npc_bartender', folderName: '佣兵酒保',
      startX: 200, startY: FLOOR_START_Y + 95,
      wanderMinX: 120, wanderMaxX: 440,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 500,
      tooltip: '布隆·铜锅\n矮人 · 前佣兵老板\n"刀可以带，脑子也得带。"' },
    { key: 'npc_warrior', folderName: '任务狂战士',
      startX: 400, startY: 420,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '卡拉·不拒单\n人类 · 职业佣兵\n"最后一次，真的是最后一次。"' },
    { key: 'npc_witch', folderName: '炼金药师',
      startX: 650, startY: FLOOR_START_Y + 100,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '米拉·泡泡瓶\n人类 · 天才炼金师\n"这次一定没问题，大概。"' },
    { key: 'npc_mysterious', folderName: '老佣兵顾问',
      startX: 780, startY: 530,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '老霍克\n人类 · 退休冒险者\n"墓碑上想刻什么？先说好。"' },
  ],
  mist_mystery: [
    { key: 'npc_bartender', folderName: '雾港酒保',
      startX: 200, startY: FLOOR_START_Y + 95,
      wanderMinX: 120, wanderMaxX: 440,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 500,
      tooltip: '奥伦·灯塔\n人类 · 雾港老酒保\n"今晚早点收工，雾不对。"' },
    { key: 'npc_warrior', folderName: '码头护卫',
      startX: 400, startY: 420,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '玛拉·铁钩\n人类 · 码头巡防旧兵\n"我见过人落水，也见过水把人还回来。"' },
    { key: 'npc_witch', folderName: '民俗学者',
      startX: 650, startY: FLOOR_START_Y + 100,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '伊芙琳·潮页\n人类 · 禁忌民俗学者\n"传说不是假的，只是被翻译坏了。"' },
    { key: 'npc_mysterious', folderName: '旧案调查员',
      startX: 780, startY: 530,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '凯尔·雾档\n人类 · 前调查员\n"第三号码头，所有线索都回到那里。"' },
  ],
  steam_wasteland: [
    { key: 'npc_bartender', folderName: '装甲酒车主',
      startX: 200, startY: FLOOR_START_Y + 95,
      wanderMinX: 120, wanderMaxX: 440,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 500,
      tooltip: '格里姆·锅炉\n人类 · 酒车工程师\n"锅炉和人一样，压力太高都会炸。"' },
    { key: 'npc_warrior', folderName: '车队护卫',
      startX: 400, startY: 420,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '拉娜·沙刃\n人类 · 荒原护卫\n"燃料比金币值钱，脚印比地图可靠。"' },
    { key: 'npc_witch', folderName: '荒原机修师',
      startX: 650, startY: FLOOR_START_Y + 100,
      wanderMinX: 150, wanderMaxX: 880,
      wanderMinY: FLOOR_START_Y + 60, wanderMaxY: 580,
      tooltip: '妮克丝·火花\n侏儒 · 机修炼金师\n"别碰那根线，它还记得旧帝国。"' },
    { key: 'npc_mysterious', folderName: '废土遗物商',
      startX: 780, startY: 530,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '零号商人\n身份不明 · 旧帝国遗物贩子\n"K-12 相位稳定器，还能让你活两个沙暴季。"' },
  ],
};

export const STYLE_WORLD_INTERACTION_NPC_CONFIGS: Record<string, NPCConfig[]> = {
  dark_border: WORLD_INTERACTION_NPC_CONFIGS,
  court_intrigue: [
    { key: 'npc_poet', folderName: '假面信使',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '佩林·白羽\n半精灵 · 随机访客\n"这封信没有署名，所以才值钱。"' },
    { key: 'npc_ranger', folderName: '债务决斗家',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '罗莎·红手套\n人类 · 随机访客\n"欠债的人总说自己还有选择。"' },
  ],
  mercenary_comedy: [
    { key: 'npc_poet', folderName: '吵闹吟游者',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '皮普·乱弦\n半身人 · 随机访客\n"好消息，我把委托唱明白了；坏消息，雇主也听见了。"' },
    { key: 'npc_ranger', folderName: '走私向导',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '奈德·三条路\n人类 · 随机访客\n"别问哪条近，问哪条不收尸。"' },
  ],
  mist_mystery: [
    { key: 'npc_poet', folderName: '码头歌者',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '萝温·潮声\n人类 · 随机访客\n"我只是唱歌，可雾会跟着和声。"' },
    { key: 'npc_ranger', folderName: '雾港巡夜人',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '诺尔·旧灯\n人类 · 随机访客\n"巡夜铃响了三次，可钟楼没人。"' },
  ],
  steam_wasteland: [
    { key: 'npc_poet', folderName: '广播说书人',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '巴兹·电台\n人类 · 随机访客\n"这里是盐尘频段，活人请回话。"' },
    { key: 'npc_ranger', folderName: '沙路侦察兵',
      startX: DOOR_X, startY: DOOR_Y,
      wanderMinX: 120, wanderMaxX: 880,
      wanderMinY: 300, wanderMaxY: 580,
      tooltip: '赛拉·风镜\n人类 · 随机访客\n"沙暴后面有车队，也可能是掠夺者。"' },
  ],
};

export function normalizeStyleKey(styleKey: string | undefined | null): string {
  const key = styleKey || DEFAULT_STYLE_KEY;
  return STYLE_NPC_CONFIGS[key] ? key : DEFAULT_STYLE_KEY;
}

export function getNpcConfigsForStyle(styleKey: string | undefined | null): NPCConfig[] {
  return STYLE_NPC_CONFIGS[normalizeStyleKey(styleKey)];
}

export function getWorldNpcConfigsForStyle(styleKey: string | undefined | null): NPCConfig[] {
  return STYLE_WORLD_INTERACTION_NPC_CONFIGS[normalizeStyleKey(styleKey)];
}

// 可坐的椅子位置（8 个座位），facing 朝向桌子
export interface SitSpot {
  x: number;
  y: number;
  table: number;
  facing: string;
}
// 朝向：上→下(front) 下→上(back) 左→右(right) 右→左(left)
export const SIT_SPOTS: SitSpot[] = [
  { x: 320, y: 345, table: 0, facing: 'front' },
  { x: 320, y: 475, table: 0, facing: 'back'  },
  { x: 235, y: 410, table: 0, facing: 'right' },
  { x: 405, y: 410, table: 0, facing: 'left'  },
  { x: 730, y: 345, table: 1, facing: 'front' },
  { x: 730, y: 475, table: 1, facing: 'back'  },
  { x: 645, y: 410, table: 1, facing: 'right' },
  { x: 815, y: 410, table: 1, facing: 'left'  },
];
