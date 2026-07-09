import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

/**
 * 打开（必要时创建）元数据库。文件真相在 ALFS 目录，库里只放索引与日志类数据。
 * Phase 0 仅建 meta 表；后续 Phase 在此追加迁移。
 */
export function openDatabase(dbFile: string): Database.Database {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  }
  return db;
}
