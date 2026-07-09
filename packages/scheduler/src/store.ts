import Database from 'better-sqlite3';

/**
 * 调度存储：cronjobs / cron_runs。语义对齐 alva deploy：
 * create/list/get/pause/resume/delete、run 历史与日志、连续失败计数。
 * 本包拥有这两张表的 schema。
 */

export interface CronJob {
  id: number;
  name: string;
  user: string;
  entry_path: string;
  cron: string;
  push_notify: number;
  max_heap_size_mb: number | null;
  status: 'active' | 'paused' | 'deleted';
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
}

export interface CronRun {
  id: number;
  cronjob_id: number;
  trigger: 'cron' | 'manual';
  status: 'completed' | 'failed';
  error: string | null;
  logs: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
}

export class SchedulerStore {
  readonly db: Database.Database;

  constructor(dbFile: string) {
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cronjobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        user TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        cron TEXT NOT NULL,
        push_notify INTEGER NOT NULL DEFAULT 0,
        max_heap_size_mb INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cronjob_id INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        logs TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs (cronjob_id, id DESC);
    `);
  }

  create(input: {
    name: string;
    user: string;
    entryPath: string;
    cron: string;
    pushNotify?: boolean;
    maxHeapSizeMb?: number;
  }): CronJob {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO cronjobs (name, user, entry_path, cron, push_notify, max_heap_size_mb, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.name,
        input.user,
        input.entryPath,
        input.cron,
        input.pushNotify ? 1 : 0,
        input.maxHeapSizeMb ?? null,
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): CronJob | undefined {
    return this.db.prepare(`SELECT * FROM cronjobs WHERE id = ?`).get(id) as CronJob | undefined;
  }

  list(user?: string): CronJob[] {
    const rows = user
      ? this.db.prepare(`SELECT * FROM cronjobs WHERE user = ? AND status != 'deleted'`).all(user)
      : this.db.prepare(`SELECT * FROM cronjobs WHERE status != 'deleted'`).all();
    return rows as CronJob[];
  }

  setStatus(id: number, status: 'active' | 'paused' | 'deleted'): CronJob | undefined {
    this.db
      .prepare(`UPDATE cronjobs SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
    return this.get(id);
  }

  recordRun(run: Omit<CronRun, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO cron_runs (cronjob_id, trigger, status, error, logs, started_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.cronjob_id,
        run.trigger,
        run.status,
        run.error,
        run.logs,
        run.started_at,
        run.finished_at,
        run.duration_ms,
      );
    if (run.status === 'failed') {
      this.db
        .prepare(
          `UPDATE cronjobs SET consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
        )
        .run(run.cronjob_id);
    } else {
      this.db
        .prepare(`UPDATE cronjobs SET consecutive_failures = 0 WHERE id = ?`)
        .run(run.cronjob_id);
    }
  }

  runs(cronjobId: number, limit = 20): CronRun[] {
    return this.db
      .prepare(`SELECT * FROM cron_runs WHERE cronjob_id = ? ORDER BY id DESC LIMIT ?`)
      .all(cronjobId, limit) as CronRun[];
  }

  close(): void {
    this.db.close();
  }
}
