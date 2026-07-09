import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Alfs } from './fsops.js';
import { FeedStore } from './tsstore.js';

let tmpRoot: string;
let feedBase: string;
let store: FeedStore;
let alfs: Alfs;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-ts-'));
  feedBase = path.join(tmpRoot, 'home', 'alice', 'feeds', 'demo', 'v1');
  store = new FeedStore(feedBase);
  await store.ensureMount();
  alfs = new Alfs(tmpRoot, 'alice');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('平台规约 §1.1 — ts append 语义', () => {
  it('同一批 append 内同 date 记录分组存储，读取时展平', async () => {
    const ts = store.ts('watch', 'assets');
    await ts.append([
      { date: 1000, symbol: 'BTC', v: 1 },
      { date: 1000, symbol: 'ETH', v: 2 },
      { date: 1000, symbol: 'SOL', v: 3 },
    ]);
    const rows = await ts.last(10);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['symbol'])).toEqual(['BTC', 'ETH', 'SOL']);
    expect(rows.every((r) => r.date === 1000)).toBe(true);
  });

  it('跨 run 同 date 再 append ⇒ 整行 REPLACE（固定桶模式成立）', async () => {
    const ts = store.ts('watch', 'assets');
    const BUCKET = 1700000000000;
    await ts.append([
      { date: BUCKET, symbol: 'BTC' },
      { date: BUCKET, symbol: 'ETH' },
    ]);
    // 第二次 run：同桶写入不同内容 → 完全替换，不累积
    await ts.append([
      { date: BUCKET, symbol: 'SOL' },
      { date: BUCKET, symbol: 'XRP' },
    ]);
    const rows = await ts.last(10);
    expect(rows.map((r) => r['symbol'])).toEqual(['SOL', 'XRP']);
  });

  it('双固定桶（Demo/Live）永久共存，@last/N 取 date 最大的行', async () => {
    const ts = store.ts('watch', 'overview');
    const BUCKET_DEMO = 1700000000000;
    const BUCKET_LIVE = 1700000001000;
    await ts.append([{ date: BUCKET_DEMO, mode: 'demo' }]);
    await ts.append([{ date: BUCKET_LIVE, mode: 'live' }]);
    const last1 = await ts.last(1);
    expect(last1).toHaveLength(1);
    expect(last1[0]!['mode']).toBe('live');
    const both = await ts.last(2);
    expect(both.map((r) => r['mode'])).toEqual(['demo', 'live']); // 时间正序
  });

  it('append 自动按 date 升序排序；缺 date 报错', async () => {
    const ts = store.ts('m', 'x');
    await ts.append([
      { date: 3000, v: 3 },
      { date: 1000, v: 1 },
      { date: 2000, v: 2 },
    ]);
    expect((await ts.last(10)).map((r) => r['v'])).toEqual([1, 2, 3]);
    await expect(ts.append([{ v: 1 } as never])).rejects.toThrow(/date/);
  });

  it('limit 按时间戳行数计，分组行展平后可超出 limit', async () => {
    const ts = store.ts('m', 'x');
    await ts.append([
      { date: 1000, v: 'a' },
      { date: 1000, v: 'b' },
    ]);
    await ts.append([{ date: 2000, v: 'c' }]);
    const rows = await ts.last(2); // 2 个时间戳行 → 3 条记录
    expect(rows.map((r) => r['v'])).toEqual(['a', 'b', 'c']);
  });
});

describe('平台规约 §1.2 — data/ 挂载禁止任意写', () => {
  it('writeFile 到 data 挂载内被拒绝；ts append 是唯一写入口', async () => {
    await expect(
      alfs.writeFile('~/feeds/demo/v1/data/watch/hack.json', '{}'),
    ).rejects.toThrow(/data mount/);
    // 挂载外正常写
    await alfs.writeFile('~/feeds/demo/v1/src/index.js', '// ok');
    expect(await alfs.readFile('~/feeds/demo/v1/src/index.js')).toBe('// ok');
  });
});

describe('平台规约 §1.3 — alfs 接口形态', () => {
  it('readFile 返回字符串（String(await ...) 模式成立）；remove 单参数', async () => {
    await alfs.writeFile('~/notes.txt', 'hello');
    const content = await alfs.readFile('~/notes.txt');
    expect(typeof content).toBe('string');
    expect(String(content)).toBe('hello');
    await alfs.remove('~/notes.txt');
    expect((await alfs.stat('~/notes.txt')).exists).toBe(false);
  });

  it('虚拟路径读取：@last/N 经 alfs.readFile 返回展平 JSON，时间正序', async () => {
    const ts = store.ts('watch', 'assets');
    await ts.append([
      { date: 1000, symbol: 'BTC' },
      { date: 1000, symbol: 'ETH' },
    ]);
    await ts.append([{ date: 2000, symbol: 'SOL' }]);
    const parsed = JSON.parse(await alfs.readFile('~/feeds/demo/v1/data/watch/assets/@last/50'));
    expect(parsed.map((r: { symbol: string }) => r.symbol)).toEqual(['BTC', 'ETH', 'SOL']);
    const count = JSON.parse(await alfs.readFile('~/feeds/demo/v1/data/watch/assets/@count'));
    expect(count).toBe(2); // 行数（时间戳数），非展平记录数
    const range = JSON.parse(
      await alfs.readFile('~/feeds/demo/v1/data/watch/assets/@range/1500..2500'),
    );
    expect(range).toHaveLength(1);
  });

  it('路径穿越与非法路径被拒绝', async () => {
    await expect(alfs.readFile('~/../../etc/passwd')).rejects.toThrow(/escapes|ENOENT/);
    await expect(alfs.readFile('/etc/passwd')).rejects.toThrow(/Unsupported ALFS path/);
  });
});

describe('@kv 状态存储', () => {
  it('put/load 字符串值；缺失返回 undefined；跨实例持久', async () => {
    expect(await store.kvLoad('alert_state')).toBeUndefined();
    await store.kvPut('alert_state', '{"seen":{}}');
    const store2 = new FeedStore(feedBase);
    expect(await store2.kvLoad('alert_state')).toBe('{"seen":{}}');
  });
});
