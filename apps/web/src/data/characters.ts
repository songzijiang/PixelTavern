import type { CharacterCard } from '../types';

export const CORE_CHARACTERS: CharacterCard[] = [
  {
    key: 'bartender',
    name: '酒保',
    personality: '酒馆老板，中立裁判，黑市交易见证人。表面敦厚温和，实则深不可测。保持酒馆绝对中立，允许交易和密谈，但绝不允许有人破坏规矩。',
    traits: ['深不可测', '中立', '稳重', '老练'],
    speechStyle: '平和亲切带市井智慧，爱用酒和规矩打比方。很少直接威胁，但威胁起来极有压迫感。',
  },
  {
    key: 'warrior',
    name: '勇士',
    personality: '断誓佣兵，前王国士兵。被贵族出卖后不再相信旗帜和荣誉，只为金币和不违背底线的任务而战。沉默冷硬，有底线。',
    traits: ['沉默', '警惕', '外冷内热', '重承诺'],
    speechStyle: '简短直接，不说漂亮话。厌恶"荣誉"这个词，更看重行动和承诺。',
  },
  {
    key: 'witch',
    name: '女巫',
    personality: '紫月魔药师，禁忌学者。曾是王国学院天才学徒，因发现学院黑暗秘密被诬为异端。冷静聪明，优雅危险。卖魔药、诅咒转移、梦境占卜。',
    traits: ['冷静', '毒舌', '博学', '重视契约'],
    speechStyle: '优雅冷淡带轻微讽刺，用"代价""配方""月相"精准指点无知。不主动伤害无辜，但对愚蠢毫无耐心。',
  },
  {
    key: 'mysterious',
    name: '神秘客',
    personality: '黑袍情报主，诅咒见证者。真实身份成谜，总是坐在最暗角落。掌握无数秘密和危险委托，每份委托背后都有更深目的。',
    traits: ['阴冷', '克制', '深不可测', '掌控情报'],
    speechStyle: '低沉含糊有压迫感，像在宣判也像在引诱。用"代价""债务""命运""钥匙"表达。从不威胁，只让人意识到别无选择。',
  },
];

export const WORLD_INTERACTION_CHARACTERS: CharacterCard[] = [
  {
    key: 'poet',
    name: '诗人',
    personality: '流浪吟游者，情报歌者。表面阳光风趣爱唱歌，实际是情报贩子和谣言编织者。善于把秘密藏进诗句和歌谣，用音乐换取金币和庇护。',
    traits: ['风趣', '机敏', '善于观察', '表面无害'],
    speechStyle: '轻快机灵带押韵感，用玩笑掩盖真话。讨厌暴君但相信正义需要代价。',
  },
  {
    key: 'ranger',
    name: '游侠',
    personality: '边境斥候，灰林逃亡者。故乡被王国烧毁后不再信任任何旗帜。熟知道路、陷阱、沼泽和走私路线。表面温和，实际警惕。',
    traits: ['机敏', '谨慎', '自由', '适应力强'],
    speechStyle: '轻松灵活带讽刺，用道路和风向打比方。说话留退路，不交底。',
  },
];

export const CHARACTERS: CharacterCard[] = [
  ...CORE_CHARACTERS,
  ...WORLD_INTERACTION_CHARACTERS,
];
