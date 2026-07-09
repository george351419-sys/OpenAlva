/**
 * 异步操作追踪器。沙箱暴露的所有异步原语（http、alfs、kv、ts、feed.run）
 * 都经 track() 包装；脚本求值结束后 drain() 等待全部落定——这就是
 * 「整个 async IIFE 跑完才算 run 结束」的实现基础（feed 脚本无 timer 可用，
 * 因此所有挂起工作必然途经被追踪的原语）。
 */
export class AsyncTracker {
  private pending = 0;
  firstError: unknown = null;

  track<T>(p: Promise<T>): Promise<T> {
    this.pending += 1;
    return p.finally(() => {
      this.pending -= 1;
    });
  }

  wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return (...args: A) => this.track(fn(...args));
  }

  noteError(err: unknown): void {
    if (this.firstError === null) this.firstError = err;
  }

  /** 等待所有被追踪操作落定；连续 idleTicks 个宏任务无挂起即认为静默。 */
  async drain(idleTicks = 10): Promise<void> {
    let idle = 0;
    while (idle < idleTicks) {
      if (this.pending > 0) {
        idle = 0;
      } else {
        idle += 1;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
