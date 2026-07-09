import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Alfs, FeedStore, resolveAlfsPath } from '@openalva/alfs';
import { runFeed } from './runFeed.js';
import type { HttpFetchImpl, HttpResponse } from './sandbox.js';

/**
 * Phase 1 关键验收（DEV-PLAN §3）：参考实现 crypto-top5-watch 的 feed 脚本
 * 【原样】在 OpenAlva 运行时跑通，五组输出生成，@last/N 读取语义正确。
 * 数据源为合成 Arrays mock（真实 driver 属 Phase 2）。
 */

const FEED_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../逆向材料/参考实现/crypto-top5-watch/feed-src-index.js',
);

const USER = 'george351419';

// ── 合成 Arrays 数据 ──

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = (h * 16777619) ^ ch.charCodeAt(0);
  return h >>> 0;
}

interface Bar {
  time_open: string;
  time_close: string;
  price_open: number;
  price_high: number;
  price_low: number;
  price_close: number;
  volume: number;
}

/** 随机游走 K 线；ETH 在倒数第 3 根日线上制造 -12% 放量异动（触发事件）。 */
function genBars(symbol: string, startSec: number, endSec: number, interval: string): Bar[] {
  const step = interval === '1d' ? 86400 : 3600;
  const rand = lcg(seedOf(symbol + interval));
  const bars: Bar[] = [];
  let price = 100 + rand() * 100;
  const times: number[] = [];
  for (let t = Math.ceil(startSec / step) * step; t + step <= endSec; t += step) times.push(t);
  for (let i = 0; i < times.length; i += 1) {
    const spike = symbol === 'ETH' && interval === '1d' && i === times.length - 3;
    const ret = spike ? -0.12 : (rand() - 0.5) * 0.02;
    const open = price;
    price = price * (1 + ret);
    bars.push({
      time_open: new Date(times[i]! * 1000).toISOString(),
      time_close: new Date((times[i]! + step) * 1000).toISOString(),
      price_open: open,
      price_high: Math.max(open, price) * 1.005,
      price_low: Math.min(open, price) * 0.995,
      price_close: price,
      volume: spike ? 4000 : 1000,
    });
  }
  return bars;
}

function ok(data: unknown): HttpResponse {
  const body = JSON.stringify({ success: true, data, request_id: 'mock' });
  return {
    status: 200,
    ok: true,
    headers: {},
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

const mockArrays: HttpFetchImpl = async (url, init) => {
  const auth = init?.headers?.['Authorization'] ?? '';
  if (auth !== 'Bearer test-jwt') {
    return { status: 401, ok: false, headers: {}, text: async () => '{}', json: async () => ({}) };
  }
  const u = new URL(url);
  const q = u.searchParams;
  switch (u.pathname) {
    case '/api/v1/crypto/screener/metrics':
      return ok([
        { symbol: 'BTCUSDT', value: 2.2e12, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
        { symbol: 'ETHUSDT', value: 5.0e11, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
        { symbol: 'USDTUSDT', value: 1.6e11, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
        { symbol: 'BNBUSDT', value: 1.2e11, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
        { symbol: 'XRPUSDT', value: 1.1e11, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
        { symbol: 'SOLUSDT', value: 0.9e11, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
        { symbol: 'DOGEUSDT', value: 0.4e11, date: '2026-07-09', snapshot_time: '2026-07-09T00:00:00Z' },
      ]);
    case '/api/v1/crypto/detail':
      return ok([{ name: `${q.get('symbol')} Asset` }]);
    case '/api/v1/crypto/binance/spot/usdt/kline':
      return ok(
        genBars(
          q.get('symbol')!,
          Number(q.get('start_time')),
          Number(q.get('end_time')),
          q.get('interval')!,
        ),
      );
    case '/api/v1/crypto/funding-rate':
      return ok([
        { timestamp: Number(q.get('start_time')) + 3600, funding_rate: '0.0001' },
        { timestamp: Number(q.get('end_time')) - 3600, funding_rate: '0.0002' },
      ]);
    case '/api/v1/crypto/open-interest':
      return ok([
        { timestamp: Number(q.get('start_time')) + 3600, sum_open_interest_value: '900000000' },
        { timestamp: Number(q.get('end_time')) - 3600, sum_open_interest_value: '1000000000' },
      ]);
    case '/api/v1/crypto/exchange-flows':
      return ok([{ datetime: Number(q.get('end_time')) - 3600, netflow_total: '-1200' }]);
    case '/api/v1/stocks/market-news':
      return ok([]);
    default:
      throw new Error(`mockArrays: unexpected endpoint ${u.pathname}`);
  }
};

// ── 测试 ──

let root: string;
let alfs: Alfs;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-accept-'));
  alfs = new Alfs(root, USER);
  await fs.mkdir(path.join(root, 'home', USER), { recursive: true });
  await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ ARRAYS_JWT: 'test-jwt' }));
  const source = await fs.readFile(FEED_SOURCE, 'utf8');
  await alfs.writeFile('~/feeds/crypto-top5-watch/v1/src/index.js', source);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('Phase 1 验收：crypto-top5-watch 原样跑通', () => {
  it('feed 执行完成，五组输出与 @last 读取全部正确', async () => {
    const envelope = await runFeed({
      root,
      user: USER,
      entryPath: '~/feeds/crypto-top5-watch/v1/src/index.js',
      httpFetch: mockArrays,
      timeoutMs: 60_000,
    });

    expect(envelope.error).toBeNull();
    expect(envelope.status).toBe('completed');
    expect(envelope.stats.credits_used).toBe(0);

    // watch/assets：5 个非稳定币资产，展平平铺记录，rank 升序
    const assets = JSON.parse(
      await alfs.readFile('~/feeds/crypto-top5-watch/v1/data/watch/assets/@last/50'),
    );
    expect(assets).toHaveLength(5);
    expect(assets.map((a: { symbol: string }) => a.symbol)).toEqual([
      'BTC',
      'ETH',
      'BNB',
      'XRP',
      'SOL',
    ]);
    for (const a of assets) {
      expect(a.sigma_eps).toBeGreaterThan(0);
      expect(a.last_close).toBeGreaterThan(0);
      expect(typeof a.capability_notes).toBe('string');
    }

    // watch/overview：单条快照
    const overview = JSON.parse(
      await alfs.readFile('~/feeds/crypto-top5-watch/v1/data/watch/overview/@last/1'),
    );
    expect(overview).toHaveLength(1);
    expect(overview[0].as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(overview[0].universe_json)).toHaveLength(5);

    // watch/incidents：ETH 的 -12% 放量异动必须被捕捉
    const incidents = JSON.parse(
      await alfs.readFile('~/feeds/crypto-top5-watch/v1/data/watch/incidents/@last/200'),
    );
    const ethIncident = incidents.find((s: { symbol: string }) => s.symbol === 'ETH');
    expect(ethIncident).toBeDefined();
    expect(['P0', 'P1']).toContain(ethIncident.tier);
    expect(Math.abs(ethIncident.z_idio)).toBeGreaterThan(3);

    // watch/timeline：5 资产 × 10 天
    const timeline = JSON.parse(
      await alfs.readFile('~/feeds/crypto-top5-watch/v1/data/watch/timeline/@last/400'),
    );
    expect(timeline).toHaveLength(50);

    // notify/message：首轮运行 → SKIP 哨兵（不推送但推进 fanout 状态）
    const notify = JSON.parse(
      await alfs.readFile('~/feeds/crypto-top5-watch/v1/data/notify/message/@last/1'),
    );
    expect(notify[0].body).toContain('<|SKIP_NOTIFICATION|>');

    // @kv：alert_state 已写入（冷却与去重状态）
    const store = new FeedStore(resolveAlfsPath(root, USER, '~/feeds/crypto-top5-watch/v1'));
    const state = JSON.parse((await store.kvLoad('alert_state'))!);
    expect(state).toHaveProperty('seen');
    expect(state).toHaveProperty('cooldown');
  }, 60_000);

  it('第二次运行：固定语义下 ETH 异动进入冷却/已见状态，不重复推送', async () => {
    const first = await runFeed({
      root,
      user: USER,
      entryPath: '~/feeds/crypto-top5-watch/v1/src/index.js',
      httpFetch: mockArrays,
    });
    expect(first.status).toBe('completed');
    const second = await runFeed({
      root,
      user: USER,
      entryPath: '~/feeds/crypto-top5-watch/v1/src/index.js',
      httpFetch: mockArrays,
    });
    expect(second.status).toBe('completed');
    const notify = JSON.parse(
      await alfs.readFile('~/feeds/crypto-top5-watch/v1/data/notify/message/@last/1'),
    );
    // 信号已在首轮标记 seen → 第二轮同样 SKIP
    expect(notify[0].body).toContain('<|SKIP_NOTIFICATION|>');
  }, 60_000);
});
