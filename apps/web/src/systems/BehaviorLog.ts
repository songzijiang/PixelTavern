import type { NPCTimeline, NPCAction, ActionRecord, PlanSegment } from '../types';
import { SEGMENT_LENGTH, PREFETCH_AHEAD } from '../utils/Config';

/**
 * 行为日志调度器 v2。
 * - 队列化计划段，支持预取缓冲
 * - 全局 tick 只增不减
 * - 支持暂停/恢复
 */
export class BehaviorLog {
  private segments: PlanSegment[] = [];
  private globalTick = 0;
  private tickTimer = 0;
  private paused = false;
  private log: ActionRecord[] = [];
  private currentSegmentIdx = -1;
  private currentTopic = '';

  // ==== 队列管理 ====

  /** 追加未来计划段 */
  appendPlan(startTick: number, plan: NPCTimeline[], topic: string): void {
    // 去重：同 startTick 不重复加
    if (this.segments.some(s => s.startTick === startTick)) return;

    this.segments.push({ startTick, plan });
    this.segments.sort((a, b) => a.startTick - b.startTick);
    this.currentTopic = topic;

    // 如果是第一段，自动激活
    if (this.currentSegmentIdx < 0) {
      this.currentSegmentIdx = 0;
    }
  }

  /** 当前 globalTick 之后是否没有计划覆盖 */
  needsPrefetch(): boolean {
    if (this.segments.length === 0) return true;

    const lastSeg = this.segments[this.segments.length - 1];
    const coveredUntil = lastSeg.startTick + SEGMENT_LENGTH;

    // 只剩不到 PREFETCH_AHEAD 秒的缓冲 → 需要预取
    return (coveredUntil - this.globalTick) <= PREFETCH_AHEAD;
  }

  /** 查询下一个需要预取的段起点（用于 LLM 请求） */
  nextPrefetchStart(): number {
    if (this.segments.length === 0) return 0;
    const lastSeg = this.segments[this.segments.length - 1];
    return lastSeg.startTick + SEGMENT_LENGTH;
  }

  /** 指定 tick 是否有计划覆盖 */
  hasBufferFor(tick: number): boolean {
    return this.segments.some(
      s => tick >= s.startTick && tick < s.startTick + SEGMENT_LENGTH
    );
  }

  // ==== 运行控制 ====

  get isPaused(): boolean { return this.paused; }
  get currentTick(): number { return this.globalTick; }
  get topic(): string { return this.currentTopic; }
  get segmentCount(): number { return this.segments.length; }
  get bufferedUntil(): number {
    if (this.segments.length === 0) return -1;
    const last = this.segments[this.segments.length - 1];
    return last.startTick + SEGMENT_LENGTH;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  /** 从持久化记录恢复全局 tick（页面刷新后调用） */
  restoreTick(tick: number): void {
    // 允许回退 tick（切换历史轮次时需要），但清空已消费的旧计划段
    if (tick < this.globalTick) {
      this.segments = [];
    }
    this.globalTick = tick;
    this.tickTimer = 0;
  }

  /** 清空所有未消费的计划段（停止时调用），但保留 globalTick 和日志 */
  clearSegments(): void {
    this.segments = [];
    this.currentSegmentIdx = -1;
  }

  // ==== 主更新 ====

  /**
   * 每帧调用。暂停时返回空。
   * 每秒推进一个 tick，自动切换段。
   */
  update(delta: number): NPCAction[] {
    if (this.paused) return [];

    this.tickTimer += delta;
    if (this.tickTimer < 1000) return [];

    if (!this.hasBufferFor(this.globalTick + 1)) {
      this.paused = true;
      this.tickTimer = 0;
      return [];
    }

    this.tickTimer -= 1000;
    this.globalTick++;

    // 自动切换段
    this.advanceSegment();

    // 取出当前秒的动作
    const actions = this.getActionsAt(this.globalTick);

    // 记录日志
    for (const a of actions) {
      this.log.push({
        tick: this.globalTick,
        sec: a.sec,
        npc: (a as any).npc ?? '',
        action: a.action,
        duration_sec: a.duration_sec,
        line: a.line,
        to: a.to,
        x: a.x,
        y: a.y,
        emote: a.emote,
        timestamp: Date.now(),
      });
    }

    return actions;
  }

  // ==== 内部 ====

  /** 切换到覆盖当前 globalTick 的段 */
  private advanceSegment(): void {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (
        this.globalTick >= seg.startTick &&
        this.globalTick < seg.startTick + SEGMENT_LENGTH
      ) {
        this.currentSegmentIdx = i;
        return;
      }
    }
    // 没有段覆盖当前 tick → 保持当前段索引不变
    // NPC 将保持 idle（getActionsAt 返回空）
  }

  /** 获取指定全局秒数的所有动作 */
  private getActionsAt(globalSec: number): NPCAction[] {
    const seg = this.segments[this.currentSegmentIdx];
    if (!seg) return [];

    const relativeSec = globalSec - seg.startTick;
    if (relativeSec < 0 || relativeSec >= SEGMENT_LENGTH) return [];

    const result: NPCAction[] = [];
    for (const tl of seg.plan) {
      for (const a of tl.actions) {
        if (a.sec === relativeSec) {
          result.push({ ...a, npc: tl.npc } as any);
        }
      }
    }
    return result;
  }

  /** 获取近期对话记录（用于传给后端 LLM） */
  getRecentDialogues(limit: number = 80): Array<{ sec: number; speaker: string; line: string; to?: string }> {
    const talks = this.log.filter(a => a.action === 'talk' && a.line);
    return talks.slice(-limit).map(a => ({
      sec: a.tick,
      speaker: a.npc,
      line: a.line!,
      to: a.to,
    }));
  }

  // ==== 日志 ====
  // 动作日志已迁移到 WorldRecord，此处仅保留内部分发所需的 push

  getLog(): ActionRecord[] { return this.log; }
}
