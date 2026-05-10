import type { WorldState } from '../types';

/**
 * 世界运行控制器。
 * start 接收目标停止 tick（绝对值），每次 tick 调用递增计数器，
 * 到达目标停止 tick 后自动回到 idle。
 */
export class WorldRunner {
  private state: WorldState = 'idle';
  private targetStop = -1;  // -1 = 无限
  private elapsedTick = 0;

  get currentState(): WorldState { return this.state; }
  get isRunning(): boolean { return this.state === 'running'; }
  get isPaused(): boolean { return this.state === 'paused'; }
  get isIdle(): boolean { return this.state === 'idle'; }

  /** 目标停止 tick（绝对值），-1 = 无限 */
  get targetStopTick(): number { return this.targetStop; }

  /** 剩余 tick 数 */
  get remainingTicks(): number {
    if (this.targetStop < 0) return Infinity;
    return Math.max(0, this.targetStop - this.elapsedTick);
  }

  /** 启动：targetStop = currentTick + durationSec */
  start(targetStop: number): void {
    this.targetStop = targetStop;
    this.elapsedTick = 0;
    this.state = 'running';
  }

  pause(): void { if (this.state === 'running') this.state = 'paused'; }
  resume(): void { if (this.state === 'paused') this.state = 'running'; }
  stop(): void { this.state = 'idle'; }

  /** 每 tick 调用。返回 true 可继续，false 已到达目标。 */
  tick(): boolean {
    if (this.state !== 'running') return false;
    this.elapsedTick++;
    if (this.targetStop > 0 && this.elapsedTick >= this.targetStop) {
      this.state = 'idle';
      return false;
    }
    return true;
  }

  get elapsed(): number { return this.elapsedTick; }
}
