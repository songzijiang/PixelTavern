import Phaser from 'phaser';
import type { NPCConfig, Direction } from '../types';
import { NPC_TARGET_HEIGHT, NPC_PATROL_SPEED, DOOR_X, DOOR_Y, DOOR_RADIUS } from '../constants';
import { sfxHover } from '../utils/Sfx';
import { findPath, type PathPoint } from '../utils/Pathfinding';
import {
  CHAIR_SEEK_TIMEOUT_MS,
  CHAIR_SIT_APPROACH_RADIUS,
  EMOTE_DURATION_MS,
  NPC_MAX_WALK_SPEED,
  NPC_MIN_WALK_SPEED,
  WAYPOINT_REACH_RADIUS,
} from '../utils/Config';

type NPCState = 'idle' | 'walking' | 'seeking_chair' | 'sitting' | 'special' | 'away';

const DIRECTION_KEYS: Record<Direction, string> = {
  front: '_001', back: '_002', left: '_003', right: '_004',
};

interface AnimConfig {
  animations: Record<string, { frames: string[]; frameRate: number; repeat: number }>;
}

export class NPC extends Phaser.GameObjects.Container {
  private sprites: Map<Direction, Phaser.GameObjects.Image> = new Map();
  private animSprite: Phaser.GameObjects.Sprite | null = null;
  private animConfig: AnimConfig | null = null;
  private currentAnim: string = 'idle';
  private currentDirection: Direction | null = null;
  private speed: number;
  private npcState: NPCState;
  private stateTimer = 0;
  private npcHalfW = 0;
  private npcHeight = 0;
  private targetX = 0;
  private targetY = 0;
  private dialogCooldown = 0;
  private npcKey: string;
  private tooltip: Phaser.GameObjects.Container | null = null;
  private occupiedChairIdx: number = -1;
  private onChairRequest: (() => number | null) | null = null;
  private targetFacing: Direction = 'front';
  private walkTargetX = 0;
  private walkTargetY = 0;
  private walkSpeed = 0;
  private emoteText: Phaser.GameObjects.Text | null = null;
  private emoteTimer = 0;
  private awayReason: string = '';
  private animationFolderName: string;
  private pathWaypoints: PathPoint[] = [];
  private waypointIndex = 0;
  private lastDirChange = 0;
  private lastDir: Direction | null = null;
  private shadow: Phaser.GameObjects.Ellipse | null = null;
  private gaitTimer = Math.random() * Math.PI * 2;

  constructor(scene: Phaser.Scene, config: NPCConfig, animConfig?: AnimConfig | null) {
    super(scene, config.startX, config.startY);
    this.npcKey = config.key;
    this.animationFolderName = config.folderName;
    this.speed = (config.patrolSpeed ?? NPC_PATROL_SPEED) * (0.8 + Math.random() * 0.4);
    this.npcState = 'idle';
    this.animConfig = animConfig ?? null;

    if (animConfig) {
      this.initAnimationSystem(scene, config);
    } else {
      for (const dir of ['front', 'back', 'left', 'right'] as Direction[]) {
        const tk = `${config.folderName}_${config.folderName}${DIRECTION_KEYS[dir]}`;
        const nScale = NPC_TARGET_HEIGHT / scene.textures.get(tk).getSourceImage().height;
        const img = scene.add.image(0, 0, tk).setOrigin(0.5, 1).setScale(nScale).setVisible(false);
        this.add(img); this.sprites.set(dir, img);
      }
      this.showDirection('front');
      this.npcHalfW = this.sprites.get('front')!.displayWidth / 2;
      this.npcHeight = this.sprites.get('front')!.displayHeight;
    }

    this.initGroundShadow(scene);

    if (config.tooltip) {
      this.setSize(this.npcHalfW * 2, this.npcHeight);
      this.setInteractive({ hitArea: new Phaser.Geom.Rectangle(-this.npcHalfW, -this.npcHeight, this.npcHalfW * 2, this.npcHeight), hitAreaCallback: Phaser.Geom.Rectangle.Contains, useHandCursor: true });
      this.on('pointerover', () => { this.showTooltip(config.tooltip!); sfxHover(); });
      this.on('pointerout', () => this.hideTooltip());
    }

    scene.add.existing(this);
  }

  private initGroundShadow(scene: Phaser.Scene) {
    const w = Math.max(18, this.npcHalfW * 1.35);
    const h = Math.max(6, w * 0.32);
    this.shadow = scene.add.ellipse(0, -2, w, h, 0x000000, 0.34).setOrigin(0.5, 0.5);
    this.addAt(this.shadow, 0);
  }

  private initAnimationSystem(scene: Phaser.Scene, config: NPCConfig) {
    const cfg = this.animConfig!;
    const folder = config.folderName;

    // 创建动画精灵，归一化到目标高度
    const firstFrame = cfg.animations['idle']?.frames[0] || Object.values(cfg.animations)[0].frames[0];
    const tk = `${folder}_anim_${firstFrame.replace('.png', '')}`;
    const nScale = NPC_TARGET_HEIGHT / scene.textures.get(tk).getSourceImage().height;
    this.animSprite = scene.add.sprite(0, 0, tk).setOrigin(0.5, 1).setScale(nScale).setVisible(true);
    this.add(this.animSprite);

    // 为每个动作创建 Phaser 动画
    for (const [action, anim] of Object.entries(cfg.animations)) {
      const key = this.animationKey(action);
      if (scene.anims.exists(key)) continue;
      scene.anims.create({
        key,
        frames: anim.frames.map((f: string) => ({
          key: `${folder}_anim_${f.replace('.png', '')}`,
        })),
        frameRate: anim.frameRate,
        repeat: anim.repeat,
      });
    }

    this.npcHalfW = this.animSprite.displayWidth / 2;
    this.npcHeight = this.animSprite.displayHeight;
    this.playAnim('idle');
  }

  private animationKey(action: string) {
    return `anim_${this.npcKey}_${this.animationFolderName}_${action}`;
  }

  private playAnim(action: string, restart = false) {
    if (!this.animSprite || !this.animConfig) return;
    const key = this.animationKey(action);
    if (this.scene.anims.exists(key) && (restart || this.currentAnim !== action || !this.animSprite.anims.isPlaying)) {
      if (restart && this.currentAnim === action) this.animSprite.stop();
      this.animSprite.play(key);
      this.currentAnim = action;
    }
  }

  private holdSitLastFrame() {
    if (!this.animSprite || !this.animConfig) return;
    const sit = this.animConfig.animations.sit;
    const lastFrame = sit?.frames[sit.frames.length - 1];
    if (!lastFrame) return;
    const textureKey = `${this.animationFolderName}_anim_${lastFrame.replace('.png', '')}`;
    if (this.scene.textures.exists(textureKey)) {
      this.animSprite.stop();
      this.animSprite.setTexture(textureKey);
      this.currentAnim = 'sit_hold';
      return;
    }
    // 回退：用动画最后一帧
    const animKey = this.animationKey('sit');
    const anim = this.scene.anims.get(animKey);
    const lastAnimFrame = anim?.frames?.[anim.frames.length - 1];
    if (lastAnimFrame) {
      this.animSprite.stop();
      this.animSprite.setTexture(lastAnimFrame.textureKey, lastAnimFrame.textureFrame);
      this.currentAnim = 'sit_hold';
      return;
    }
    // 最终回退：用 idle 的第一帧
    const idleFrame = this.animConfig.animations.idle?.frames[0];
    if (idleFrame) {
      const idleKey = `${this.animationFolderName}_anim_${idleFrame.replace('.png', '')}`;
      if (this.scene.textures.exists(idleKey)) {
        this.animSprite.stop();
        this.animSprite.setTexture(idleKey);
      }
    }
    this.currentAnim = 'sit_hold';
  }

  private playSitAndHold(restart = false) {
    if (!this.animSprite || !this.animConfig) return;
    if (!this.animConfig.animations.sit) return;
    if (!restart && (this.currentAnim === 'sit' || this.currentAnim === 'sit_hold')) return;
    const key = this.animationKey('sit');
    if (!this.scene.anims.exists(key)) return;
    this.animSprite.setFlipX(false);
    this.animSprite.play({ key, repeat: 0 });
    this.currentAnim = 'sit';
    this.animSprite.once('animationcomplete', () => {
      if (this.npcState === 'sitting') this.holdSitLastFrame();
    });
  }

  setChairCallback(onRequest: () => number | null) { this.onChairRequest = onRequest; }

  get key(): string { return this.npcKey; }
  get spriteHeight(): number { return this.npcHeight; }
  /** 素材最上方非空白像素在 NPC 本地坐标中的 y 偏移（负值 = 在 origin 上方） */
  get contentTopY(): number {
    if (!this.animSprite) return -this.npcHeight;
    const bounds = this.animSprite.getBounds();
    return bounds.top - this.y;
  }
  get isInConversation(): boolean { return this.dialogCooldown > 0; }
  get isSitting(): boolean { return this.npcState === 'sitting'; }
  get isSpecial(): boolean { return this.npcState === 'special'; }
  get isAway(): boolean { return this.npcState === 'away'; }
  get chairIndex(): number { return this.occupiedChairIdx; }
  get facing(): Direction { return this.currentDirection ?? 'front'; }
  get awayNote(): string { return this.awayReason; }
  setConversationCooldown() { this.dialogCooldown = 15000 + Math.random() * 10000; }

  ensurePoseAnimationPlaying() {
    if (!this.animSprite || !this.animConfig || this.npcState === 'away') return;
    if (this.npcState === 'sitting') {
      this.playSitAndHold(true);
    } else if (this.npcState === 'special') {
      this.playAnim('special', true);
    } else if (this.npcState === 'walking') {
      this.showDirection(this.currentDirection ?? 'front');
    } else {
      this.playAnim('idle', true);
    }
  }

  setSittingPose(facing: Direction, animate = false) {
    this.npcState = 'sitting';
    this.setVisible(true);  // 确保坐下时始终可见
    if (this.animSprite) {
      this.animSprite.setVisible(true);
      this.currentDirection = facing;
      this.animSprite.setFlipX(false);
      if (animate) {
        const key = this.animationKey('sit');
        if (this.scene.anims.exists(key)) {
          this.playSitAndHold(true);
        } else {
          this.holdSitLastFrame();
          if (!this.animSprite.visible) {
            this.showDirection(facing);
          }
        }
      } else {
        this.holdSitLastFrame();
      }
      return;
    }
    this.showDirection(facing);
  }

  setIdlePose(facing: Direction = 'front') {
    this.npcState = 'idle';
    this.occupiedChairIdx = -1;
    this.setVisible(true);
    this.currentDirection = null;
    this.showDirection(facing);
  }

  setAwayPose() {
    this.setVisible(false);
    this.npcState = 'away';
    this.occupiedChairIdx = -1;
    this.awayReason = '';
  }

  setDozingPose(facing: Direction = 'front') {
    this.npcState = 'special';
    this.occupiedChairIdx = -1;
    this.setVisible(true);
    this.currentDirection = facing;
    if (this.animSprite && this.animConfig?.animations.special) {
      this.animSprite.setFlipX(false);
      this.playAnim('special');
      return;
    }
    this.showDirection(facing);
  }

  /** 播放一个非循环动作动画（talk/stand/special），播完后自动切回 idle */
  playActionAnim(action: string) {
    if (!this.animSprite || !this.animConfig) return;
    if (!this.animConfig.animations[action]) return;
    if (action === 'talk' && (this.npcState === 'sitting' || this.npcState === 'special')) return;
    this.playAnim(action);
    // 动画结束后切回 idle 或 walk（由下一帧 showDirection 决定）
    const key = this.animationKey(action);
    this.animSprite.once('animationcomplete', () => {
      if (this.npcState === 'sitting') {
        this.holdSitLastFrame();
      } else if (this.npcState === 'special') {
        this.playAnim('special');
      } else if (this.npcState === 'idle') {
        this.playAnim('idle');
      } else if (this.npcState === 'walking') {
        // 行走中不打断
      }
    });
  }

  returnFromDoor(reason: string = '') {
    this.x = DOOR_X;
    this.y = DOOR_Y;
    this.setVisible(true);
    this.npcState = 'idle';
    this.awayReason = '';
    if (reason) this.awayReason = reason;
  }

  walkTo(tx: number, ty: number, durationSec?: number) {
    if (Phaser.Math.Distance.Between(this.x, this.y, tx, ty) < 16) {
      if (this.npcState !== 'sitting' && this.npcState !== 'special') {
        this.npcState = 'idle';
        this.walkSpeed = 0;
        this.pathWaypoints = [];
        this.showDirection(this.facing);
      }
      return;
    }

    if (this.npcState === 'sitting') {
      this.occupiedChairIdx = -1;
    }

    const path = findPath(this.x, this.y, tx, ty, { preciseDestination: true });
    if (!path || path.length === 0) {
      this.npcState = 'idle';
      this.walkSpeed = 0;
      return;
    }

    this.pathWaypoints = path;
    this.waypointIndex = 0;
    this.skipReachedWaypoints(WAYPOINT_REACH_RADIUS);
    this.walkTargetX = tx;
    this.walkTargetY = ty;

    if (durationSec && durationSec > 0) {
      const totalDist = this.getRemainingPathDistance();
      this.walkSpeed = Phaser.Math.Clamp(totalDist > 0 ? totalDist / durationSec : this.speed, NPC_MIN_WALK_SPEED, NPC_MAX_WALK_SPEED);
    } else {
      this.walkSpeed = 0;
    }
    this.npcState = 'walking';
    this.currentDirection = null;
  }

  standUp() {
    if (this.npcState !== 'sitting') return;
    this.occupiedChairIdx = -1;
    this.npcState = 'idle';
    if (this.animSprite) this.playAnim('idle');
  }

  sitAt(x: number, y: number, facing: Direction = 'front') {
    this.x = x;
    this.y = y;
    this.occupiedChairIdx = -1;
    this.setSittingPose(facing, true);
  }

  emoteBubble(emote: string) {
    this.hideEmote();
    const emoteMap: Record<string, string> = {
      happy: '😊', surprised: '😲', serious: '🤔', angry: '😠', sleepy: '😴', sigh: '💨', neutral: '',
    };
    const icon = emoteMap[emote] || emote;
    this.emoteText = this.scene.add.text(0, this.contentTopY - 16, icon, {
      fontSize: '28px',
    }).setOrigin(0.5, 1).setDepth(99999);
    this.add(this.emoteText);
    this.emoteTimer = EMOTE_DURATION_MS;
  }

  lookAt(targetX: number, targetY: number) {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      this.showDirection(dx > 0 ? 'right' : 'left');
    } else {
      this.showDirection(dy > 0 ? 'front' : 'back');
    }
  }

  assignChair(chairIdx: number, spotX: number, spotY: number, facing: string) {
    this.occupiedChairIdx = chairIdx;
    this.targetX = spotX; this.targetY = spotY;
    this.targetFacing = facing as Direction;
    this.npcState = 'seeking_chair';
    this.stateTimer = CHAIR_SEEK_TIMEOUT_MS;
  }

  update(_time: number, delta: number) {
    this.dialogCooldown = Math.max(0, this.dialogCooldown - delta);
    this.emoteTimer = Math.max(0, this.emoteTimer - delta);
    if (this.emoteTimer <= 0 && this.emoteText) this.hideEmote();

    const dt = delta / 1000;

    switch (this.npcState) {
      case 'idle':
        break;

      case 'walking':
        this.updateWalking(dt);
        break;

      case 'seeking_chair':
        this.updateSeeking(dt, delta);
        break;

      case 'sitting':
      case 'special':
      case 'away':
        break;
    }

    this.updateVisualMotion(dt);
  }

  private getRemainingPathDistance(): number {
    if (this.pathWaypoints.length === 0 || this.waypointIndex >= this.pathWaypoints.length) return 0;

    let total = Phaser.Math.Distance.Between(
      this.x,
      this.y,
      this.pathWaypoints[this.waypointIndex].x,
      this.pathWaypoints[this.waypointIndex].y,
    );

    for (let i = this.waypointIndex + 1; i < this.pathWaypoints.length; i++) {
      total += Phaser.Math.Distance.Between(
        this.pathWaypoints[i - 1].x,
        this.pathWaypoints[i - 1].y,
        this.pathWaypoints[i].x,
        this.pathWaypoints[i].y,
      );
    }

    return total;
  }

  private skipReachedWaypoints(radius: number) {
    while (
      this.waypointIndex < this.pathWaypoints.length - 1 &&
      Phaser.Math.Distance.Between(
        this.x,
        this.y,
        this.pathWaypoints[this.waypointIndex].x,
        this.pathWaypoints[this.waypointIndex].y,
      ) <= radius
    ) {
      this.waypointIndex++;
    }
  }

  private updateVisualMotion(dt: number) {
    if (this.npcState === 'away') return;

    const moving = this.npcState === 'walking' || this.npcState === 'seeking_chair';
    this.gaitTimer += dt * (moving ? 11 : 2.2);
    const lift = moving ? -Math.abs(Math.sin(this.gaitTimer)) * 2.2 : Math.sin(this.gaitTimer) * 0.45;
    this.setSpriteLocalY(lift);

    if (this.shadow) {
      const pulse = moving ? 1 + Math.sin(this.gaitTimer * 2) * 0.05 : 1;
      this.shadow.setScale(pulse, 1);
      this.shadow.setAlpha(this.npcState === 'sitting' ? 0.24 : 0.34);
    }
  }

  private setSpriteLocalY(y: number) {
    if (this.animSprite) {
      this.animSprite.setY(y);
      return;
    }
    for (const sprite of this.sprites.values()) {
      sprite.setY(y);
    }
  }

  private updateWalking(dt: number) {
    if (this.pathWaypoints.length === 0 || this.waypointIndex >= this.pathWaypoints.length) {
      this.npcState = 'idle';
      this.walkSpeed = 0;
      if (this.animSprite) { this.animSprite.setFlipX(false); this.playAnim('idle'); }
      return;
    }

    const target = this.pathWaypoints[this.waypointIndex];
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const reachRadius = this.waypointIndex >= this.pathWaypoints.length - 1
      ? WAYPOINT_REACH_RADIUS
      : Math.max(4, WAYPOINT_REACH_RADIUS);

    // 到达当前路点，前进到下一个
    if (dist <= reachRadius) {
      this.x = target.x; this.y = target.y;
      this.waypointIndex++;
      if (this.waypointIndex >= this.pathWaypoints.length) {
        // 到达最终目标
        // 门口检查：目标在门口附近则离店
        if (this.npcKey !== 'npc_bartender' &&
            Phaser.Math.Distance.Between(this.x, this.y, DOOR_X, DOOR_Y) < DOOR_RADIUS) {
          this.setVisible(false);
          this.npcState = 'away';
          this.awayReason = '';
          return;
        }
        this.npcState = 'idle';
        this.walkSpeed = 0;
        if (this.animSprite) { this.animSprite.setFlipX(false); this.playAnim('idle'); }
        return;
      }
      return; // 继续走向下一个路点
    }

    // 方向判定
    const absDx = Math.abs(dx), absDy = Math.abs(dy);
    const newDir: Direction = absDx >= absDy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'front' : 'back');
    const now = this.scene.time.now;
    if (now - this.lastDirChange > 140 || this.lastDir !== newDir) {
      this.showDirection(newDir);
      this.lastDirChange = now;
    }
    this.lastDir = newDir;

    const spd = this.walkSpeed > 0 ? this.walkSpeed : this.speed;
    const step = Math.min(spd * dt, dist);
    const nx = dx / dist, ny = dy / dist;
    this.x += nx * step;
    this.y += ny * step;
  }

  private hideEmote() {
    if (this.emoteText) { this.emoteText.destroy(); this.emoteText = null; }
  }

  private updateSeeking(dt: number, delta: number) {
    // 使用 A* 走向目标椅子
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < CHAIR_SIT_APPROACH_RADIUS) {
      this.x = this.targetX; this.y = this.targetY;
      this.setSittingPose(this.targetFacing, true);
      return;
    }

    // A* 寻路到椅子
    if (this.pathWaypoints.length === 0 || this.waypointIndex >= this.pathWaypoints.length) {
      const path = findPath(this.x, this.y, this.targetX, this.targetY, {
        goalRadius: CHAIR_SIT_APPROACH_RADIUS,
        preciseDestination: false,
      });
      if (path && path.length > 0) {
        this.pathWaypoints = path;
        this.waypointIndex = 0;
        this.skipReachedWaypoints(WAYPOINT_REACH_RADIUS);
      }
    }

    // 沿路点移动
    if (this.pathWaypoints.length > 0 && this.waypointIndex < this.pathWaypoints.length) {
      const wp = this.pathWaypoints[this.waypointIndex];
      const wdx = wp.x - this.x;
      const wdy = wp.y - this.y;
      const wdist = Math.sqrt(wdx * wdx + wdy * wdy);
      if (wdist < WAYPOINT_REACH_RADIUS) {
        this.waypointIndex++;
        return;
      }
      const nx = wdx / wdist, ny = wdy / wdist;
      const absDx = Math.abs(wdx), absDy = Math.abs(wdy);
      const newDir: Direction = absDx >= absDy ? (wdx > 0 ? 'right' : 'left') : (wdy > 0 ? 'front' : 'back');
      this.showDirection(newDir);
      const step = Math.min(this.speed * dt, wdist);
      this.x += nx * step;
      this.y += ny * step;
    }

    this.stateTimer -= delta;
    if (this.stateTimer <= 0) {
      this.x = this.targetX; this.y = this.targetY;
      this.setSittingPose(this.targetFacing, true);
    }
  }

  showDirection(dir: Direction) {
    if (this.animSprite) {
      if (this.currentDirection === dir && this.isCurrentDirectionAnimValid(dir)) return;
      this.currentDirection = dir;

      if (this.npcState === 'walking' || this.npcState === 'seeking_chair') {
        if (dir === 'left') {
          this.animSprite.setFlipX(true);
          this.playAnim('walk_right');
        } else if (dir === 'right') {
          this.animSprite.setFlipX(false);
          this.playAnim('walk_right');
        } else {
          this.animSprite.setFlipX(false);
          const walkMap: Record<string, string> = { front: 'walk_front', back: 'walk_back' };
          this.playAnim(walkMap[dir] || 'idle');
        }
      } else {
        this.animSprite.setFlipX(false);
        if (this.npcState === 'sitting') this.playSitAndHold(false);
        else if (this.npcState === 'special') this.playAnim('special');
        else this.playAnim('idle');
      }
      return;
    }
    if (this.currentDirection === dir) return;
    for (const [d, s] of this.sprites) s.setVisible(d === dir);
    this.currentDirection = dir;
  }

  private isCurrentDirectionAnimValid(dir: Direction): boolean {
    if (!this.animSprite) return true;
    if (this.npcState === 'walking' || this.npcState === 'seeking_chair') {
      if (dir === 'left' || dir === 'right') return this.currentAnim === 'walk_right';
      if (dir === 'front') return this.currentAnim === 'walk_front';
      if (dir === 'back') return this.currentAnim === 'walk_back';
    }
    if (this.npcState === 'sitting') return this.currentAnim === 'sit' || this.currentAnim === 'sit_hold';
    if (this.npcState === 'special') return this.currentAnim === 'special';
    return this.currentAnim === 'idle';
  }

  private showTooltip(text: string) {
    this.hideTooltip();
    const lines = text.split('\n');
    const t = this.scene.add.text(0, this.contentTopY - 16, lines.join('\n'), {
      fontSize: '11px', color: '#f5e6d3', fontFamily: '"Microsoft YaHei", sans-serif',
      backgroundColor: 'rgba(10,10,20,0.9)', padding: { x: 8, y: 5 },
      align: 'center', lineSpacing: 2,
      wordWrap: { width: 220, useAdvancedWrap: true },
    }).setOrigin(0.5, 1).setDepth(99999);
    const minLocalX = -this.x + t.displayWidth / 2 + 8;
    const maxLocalX = this.scene.scale.width - this.x - t.displayWidth / 2 - 8;
    t.setX(Phaser.Math.Clamp(0, minLocalX, maxLocalX));
    this.tooltip = this.scene.add.container(0, 0, [t]);
    this.add(this.tooltip);
  }

  private hideTooltip() { if (this.tooltip) { this.tooltip.destroy(); this.tooltip = null; } }
}
