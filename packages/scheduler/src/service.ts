import { Cron } from 'croner';
import { runFeed } from '@openalva/feed-runtime';
import type { CronJob, SchedulerStore } from './store.js';

/**
 * 调度服务：加载 active cronjobs 并按 cron 表达式执行 feed。
 * 每 refreshMs 与存储对账一次（新建/暂停/删除的任务在下个周期生效）——
 * 对应 Alva 的行为：feed 运行时自身不能触发重算，任务变更由外部驱动。
 */
export class CronService {
  private timers = new Map<number, Cron>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private running = new Set<number>();

  constructor(
    private readonly store: SchedulerStore,
    private readonly root: string,
    private readonly refreshMs = 60_000,
  ) {}

  start(): void {
    this.reconcile();
    this.refreshTimer = setInterval(() => this.reconcile(), this.refreshMs);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
  }

  reconcile(): void {
    const jobs = this.store.list().filter((j) => j.status === 'active');
    const wanted = new Map(jobs.map((j) => [j.id, j]));
    for (const [id, timer] of this.timers) {
      if (!wanted.has(id)) {
        timer.stop();
        this.timers.delete(id);
      }
    }
    for (const job of jobs) {
      if (!this.timers.has(job.id)) {
        this.timers.set(
          job.id,
          new Cron(job.cron, () => void this.execute(job.id, 'cron')),
        );
      }
    }
  }

  /** 执行一个任务（cron 或手动 trigger）；同任务并发保护。 */
  async execute(id: number, trigger: 'cron' | 'manual'): Promise<CronJob | undefined> {
    const job = this.store.get(id);
    if (!job || job.status === 'deleted') return undefined;
    if (this.running.has(id)) return job;
    this.running.add(id);
    const started = Date.now();
    try {
      const envelope = await runFeed({
        root: this.root,
        user: job.user,
        entryPath: job.entry_path,
      });
      this.store.recordRun({
        cronjob_id: id,
        trigger,
        status: envelope.status,
        error: envelope.error,
        logs: envelope.logs,
        started_at: started,
        finished_at: Date.now(),
        duration_ms: envelope.stats.duration_ms,
      });
    } catch (err) {
      this.store.recordRun({
        cronjob_id: id,
        trigger,
        status: 'failed',
        error: String((err as Error).message ?? err),
        logs: '',
        started_at: started,
        finished_at: Date.now(),
        duration_ms: Date.now() - started,
      });
    } finally {
      this.running.delete(id);
    }
    return this.store.get(id);
  }
}
