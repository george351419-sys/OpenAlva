import path from 'node:path';
import { Cron } from 'croner';
import { Alfs } from '@openalva/alfs';
import { runFeed, type HttpFetchImpl } from '@openalva/feed-runtime';
import { defaultNotifier, type Notifier } from './notifier.js';
import type { CronJob, SchedulerStore } from './store.js';

export interface CronServiceOptions {
  refreshMs?: number;
  /** feed 的 net/http 实现（如 Arrays 路由 fetch）；缺省用 feed-runtime 默认 fetch */
  httpFetch?: HttpFetchImpl;
  /** 通知投递实现；缺省 macOS 系统通知 */
  notifier?: Notifier;
}

const SKIP_SENTINEL = '<|SKIP_NOTIFICATION|>';

/**
 * 调度服务：加载 active cronjobs 并按 cron 表达式执行 feed。
 * 每 refreshMs 与存储对账一次（新建/暂停/删除的任务在下个周期生效）——
 * 对应 Alva 的行为：feed 运行时自身不能触发重算，任务变更由外部驱动。
 */
export class CronService {
  private timers = new Map<number, Cron>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private running = new Set<number>();
  private readonly refreshMs: number;
  private readonly httpFetch?: HttpFetchImpl;
  private readonly notifier: Notifier;

  constructor(
    private readonly store: SchedulerStore,
    private readonly root: string,
    opts: CronServiceOptions = {},
  ) {
    this.refreshMs = opts.refreshMs ?? 60_000;
    if (opts.httpFetch) this.httpFetch = opts.httpFetch;
    this.notifier = opts.notifier ?? defaultNotifier;
  }

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
        ...(job.max_heap_size_mb ? { maxHeapSizeMb: job.max_heap_size_mb } : {}),
        ...(this.httpFetch ? { httpFetch: this.httpFetch } : {}),
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
      if (envelope.status === 'completed' && job.push_notify) {
        await this.fanoutNotifications(job);
      }
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

  /**
   * push_notify fanout：读 feed 的 notify/message @last 行，按记录 date
   * 去重（水位存 cronjobs.last_notify_date），`<|SKIP_NOTIFICATION|>` 与
   * 空 body 静默。投递失败不影响 run 记录。
   */
  private async fanoutNotifications(job: CronJob): Promise<void> {
    try {
      // 标准布局 <feed>/v1/src/index.js + <feed>/v1/data/：入口在 src/ 下时剥一层
      const entryDir = path.posix.dirname(job.entry_path);
      const feedRoot = entryDir.endsWith('/src') ? path.posix.dirname(entryDir) : entryDir;
      const raw = await new Alfs(this.root, job.user).readFile(
        `${feedRoot}/data/notify/message/@last/20`,
      );
      const rows = JSON.parse(raw) as { date?: number; title?: string; body?: string }[];
      const fresh = rows
        .filter(
          (r): r is { date: number; title?: string; body?: string } =>
            typeof r.date === 'number' && r.date > job.last_notify_date,
        )
        .sort((a, b) => a.date - b.date);
      if (fresh.length === 0) return;
      // 单次最多投 3 条防轰炸；被压缩的行要留痕，不能无声丢
      const dropped = Math.max(0, fresh.length - 3);
      if (dropped > 0) {
        console.warn(`[notify] job ${job.name}(#${job.id}) squashed ${dropped} older rows`);
        await this.notifier({
          title: job.name,
          body: `另有 ${dropped} 条较早告警被合并，请打开 playbook 查看完整时间线。`,
        });
      }
      for (const row of fresh.slice(-3)) {
        const body = (row.body ?? '').trim();
        if (!body || body.includes(SKIP_SENTINEL)) continue;
        await this.notifier({ title: row.title ?? job.name, body });
      }
      this.store.setLastNotifyDate(job.id, fresh[fresh.length - 1]!.date);
    } catch (err) {
      // feed 没有 notify sidecar（ENOENT）属正常；其他异常要留痕
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[notify] fanout failed for job ${job.name}(#${job.id}): ${String((err as Error).message ?? err)}`,
        );
      }
    }
  }
}
