import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 时序输出存储。语义对齐 Alva Feed SDK（feed-sdk.md + Portfolio-Watch AGENTS.md 实证）：
 * - 每条记录必须有 date（Unix 毫秒）。
 * - 同一次 append 内同 date 的多条记录 → 分组存储 {date, _grouped, items:[...]}。
 * - 跨 run 同 date 再次 append → 整行 REPLACE（ON CONFLICT DO UPDATE）。
 * - 读取按 date 升序（时间正序），limit 按时间戳行数计，分组行读取时展平，
 *   因此返回条数可能超过 limit。
 * - 存储文件 rows.json（原子写：tmp + rename）。
 */

export interface TsRecord {
  date: number;
  [field: string]: unknown;
}

interface StoredRow {
  date: number;
  _grouped?: boolean;
  items?: Record<string, unknown>[];
  [field: string]: unknown;
}

const ROWS_FILE = 'rows.json';
const TYPEDOC_FILE = 'typedoc.json';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

/**
 * 进程内按文件串行化「读-改-写」序列，防止并发 append/kvPut 丢写。
 * 跨进程并发仍无锁（风险登记在 DEV-PLAN §1.7）。
 */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

export class TsOutput {
  constructor(private readonly dir: string) {}

  private get rowsFile(): string {
    return path.join(this.dir, ROWS_FILE);
  }

  async setTypedoc(doc: unknown): Promise<void> {
    await writeJsonAtomic(path.join(this.dir, TYPEDOC_FILE), doc);
  }

  private async loadRows(): Promise<StoredRow[]> {
    return (await readJson<StoredRow[]>(this.rowsFile)) ?? [];
  }

  async append(records: TsRecord[]): Promise<void> {
    if (!Array.isArray(records)) throw new Error('append() expects an array of records');
    for (const r of records) {
      if (r === null || typeof r !== 'object' || !Number.isFinite(r.date)) {
        throw new Error('Each record must have a numeric `date` (Unix ms)');
      }
    }
    // 同批同 date 分组
    const byDate = new Map<number, Record<string, unknown>[]>();
    for (const r of records) {
      const list = byDate.get(r.date) ?? [];
      list.push(r);
      byDate.set(r.date, list);
    }
    await withFileLock(this.rowsFile, async () => {
      const rows = await this.loadRows();
      const rowByDate = new Map<number, StoredRow>(rows.map((row) => [row.date, row]));
      for (const [date, list] of byDate) {
        const row: StoredRow =
          list.length === 1
            ? ({ ...list[0], date } as StoredRow)
            : { date, _grouped: true, items: list.map((r) => stripDate(r)) };
        rowByDate.set(date, row); // 同 date ⇒ 整行 REPLACE
      }
      const next = [...rowByDate.values()].sort((a, b) => a.date - b.date);
      await writeJsonAtomic(this.rowsFile, next);
    });
  }

  /** 展平读取：分组行展开为逐条记录（带回 date），时间正序。 */
  async last(n = 1, before?: number): Promise<TsRecord[]> {
    let rows = await this.loadRows();
    if (before !== undefined) rows = rows.filter((r) => r.date < before);
    return flatten(rows.slice(-n));
  }

  async first(n = 1, after?: number): Promise<TsRecord[]> {
    let rows = await this.loadRows();
    if (after !== undefined) rows = rows.filter((r) => r.date > after);
    return flatten(rows.slice(0, n));
  }

  async range(from: number, to?: number): Promise<TsRecord[]> {
    const rows = await this.loadRows();
    return flatten(rows.filter((r) => r.date >= from && (to === undefined || r.date <= to)));
  }

  async lastDate(): Promise<number | null> {
    const rows = await this.loadRows();
    return rows.length ? rows[rows.length - 1]!.date : null;
  }

  async count(from?: number, to?: number): Promise<number> {
    const rows = await this.loadRows();
    return rows.filter(
      (r) => (from === undefined || r.date >= from) && (to === undefined || r.date <= to),
    ).length;
  }
}

function stripDate(r: Record<string, unknown>): Record<string, unknown> {
  const { date: _date, ...rest } = r;
  return rest;
}

function flatten(rows: StoredRow[]): TsRecord[] {
  const out: TsRecord[] = [];
  for (const row of rows) {
    if (row._grouped && Array.isArray(row.items)) {
      for (const item of row.items) out.push({ ...item, date: row.date });
    } else {
      const { _grouped: _g, items: _i, ...rest } = row;
      out.push(rest as TsRecord);
    }
  }
  return out;
}

const SYNTH_MARKER = '.synthmount';
const KV_FILE = '@kv.json';

/**
 * 一个 feed 版本目录（.../feeds/<name>/v<major>）的数据面：
 * data/ 合成挂载（标记文件防任意写）、分组输出、@kv。
 */
export class FeedStore {
  constructor(readonly baseDir: string) {}

  get dataDir(): string {
    return path.join(this.baseDir, 'data');
  }

  async ensureMount(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const marker = path.join(this.dataDir, SYNTH_MARKER);
    try {
      await fs.writeFile(marker, '', { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  ts(group: string, output: string): TsOutput {
    if (group === 'data') throw new Error('Group name "data" is not allowed (data/data/ nesting)');
    return new TsOutput(path.join(this.dataDir, group, output));
  }

  async kvLoad(key: string): Promise<string | undefined> {
    const map = (await readJson<Record<string, string>>(path.join(this.dataDir, KV_FILE))) ?? {};
    return map[key];
  }

  async kvPut(key: string, value: string): Promise<void> {
    const file = path.join(this.dataDir, KV_FILE);
    await withFileLock(file, async () => {
      const map = (await readJson<Record<string, string>>(file)) ?? {};
      map[key] = String(value);
      await writeJsonAtomic(file, map);
    });
  }
}

/** 判断 realPath 是否位于某个 data 合成挂载内（据此拒绝任意写入）。 */
export async function isInsideSynthMount(realPath: string): Promise<boolean> {
  let dir = path.dirname(path.resolve(realPath));
  for (;;) {
    try {
      await fs.access(path.join(dir, SYNTH_MARKER));
      return true;
    } catch {
      // 继续向上
    }
    // data 目录自身也算挂载内
    if (path.basename(dir) === 'data') {
      try {
        await fs.access(path.join(dir, SYNTH_MARKER));
        return true;
      } catch {
        // 无标记的普通 data 目录不算
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
