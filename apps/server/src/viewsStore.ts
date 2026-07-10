import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** playbook 浏览数：/u/<user>/playbooks/<name> 每次成功打开 +1，Explore 卡片展示。 */
export class ViewsStore {
  readonly db: Database.Database;

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playbook_views (
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user, name)
      );
    `);
  }

  increment(user: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO playbook_views (user, name, views) VALUES (?, ?, 1)
         ON CONFLICT(user, name) DO UPDATE SET views = views + 1`,
      )
      .run(user, name);
  }

  get(user: string, name: string): number {
    const row = this.db
      .prepare(`SELECT views FROM playbook_views WHERE user = ? AND name = ?`)
      .get(user, name) as { views: number } | undefined;
    return row?.views ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
