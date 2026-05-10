/** 简易事件总线，替代 (window as any) 全局耦合。 */

type Handler = (...args: any[]) => void;

class EventBus {
  private listeners = new Map<string, Handler[]>();

  on(event: string, handler: Handler): () => void {
    const arr = this.listeners.get(event) || [];
    arr.push(handler);
    this.listeners.set(event, arr);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler): void {
    const arr = this.listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  emit(event: string, ...args: any[]): void {
    const arr = this.listeners.get(event);
    if (arr) {
      for (const h of arr) h(...args);
    }
  }
}

export const bus = new EventBus();
