import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Alfs } from '@openalva/alfs';
import { CronService } from './service.js';
import { SchedulerStore } from './store.js';

const OK_FEED = `
const { Feed, feedPath, makeDoc, num } = require("@alva/feed");
const feed = new Feed({ path: feedPath("tick") });
feed.def("m", { x: makeDoc("X", "tick", [num("v")]) });
(async () => {
  await feed.run(async (ctx) => {
    await ctx.self.ts("m", "x").append([{ date: Date.now(), v: 42 }]);
  });
})();
`;

const BAD_FEED = `throw new Error("boom");`;

let root: string;
let store: SchedulerStore;
let service: CronService;
let alfs: Alfs;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-sched-'));
  store = new SchedulerStore(path.join(root, 'openalva.db'));
  service = new CronService(store, root);
  alfs = new Alfs(root, 'alice');
  await alfs.writeFile('~/feeds/tick/v1/src/index.js', OK_FEED);
  await alfs.writeFile('~/feeds/bad/v1/src/index.js', BAD_FEED);
});

afterEach(async () => {
  service.stop();
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('deploy 存储与手动 trigger', () => {
  it('create/list/pause/resume/delete 生命周期', () => {
    const job = store.create({
      name: 'tick',
      user: 'alice',
      entryPath: '~/feeds/tick/v1/src/index.js',
      cron: '0 * * * *',
      pushNotify: true,
    });
    expect(job.id).toBeGreaterThan(0);
    expect(store.list('alice')).toHaveLength(1);
    expect(store.setStatus(job.id, 'paused')!.status).toBe('paused');
    expect(store.setStatus(job.id, 'active')!.status).toBe('active');
    expect(store.setStatus(job.id, 'deleted')!.status).toBe('deleted');
    expect(store.list('alice')).toHaveLength(0);
  });

  it('manual trigger 执行 feed、记录 run、成功清零失败计数', async () => {
    const job = store.create({
      name: 'tick',
      user: 'alice',
      entryPath: '~/feeds/tick/v1/src/index.js',
      cron: '0 0 31 2 *', // 永不触发
    });
    await service.execute(job.id, 'manual');
    const runs = store.runs(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.trigger).toBe('manual');
    const rows = JSON.parse(await alfs.readFile('~/feeds/tick/v1/data/m/x/@last/1'));
    expect(rows[0].v).toBe(42);
    expect(store.get(job.id)!.consecutive_failures).toBe(0);
  });

  it('失败 run 记录错误并累计连续失败计数', async () => {
    const job = store.create({
      name: 'bad',
      user: 'alice',
      entryPath: '~/feeds/bad/v1/src/index.js',
      cron: '0 0 31 2 *',
    });
    await service.execute(job.id, 'manual');
    await service.execute(job.id, 'manual');
    const runs = store.runs(job.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error).toContain('boom');
    expect(store.get(job.id)!.consecutive_failures).toBe(2);
  });

  it('push_notify fanout：按 date 去重投递，SKIP 哨兵静默，水位推进', async () => {
    const notifyFeedSrc = (d: number, body: string): string => `
      const { Feed, feedPath, makeDoc, str } = require("@alva/feed");
      const feed = new Feed({ path: feedPath("alerts") });
      feed.def("notify", { message: makeDoc("Notification", "alerts", [str("title"), str("body")]) });
      (async () => {
        await feed.run(async (ctx) => {
          await ctx.self.ts("notify", "message").append([
            { date: ${d}, title: "Alert", body: ${JSON.stringify(body)} },
          ]);
        });
      })();
    `;
    const delivered: { title: string; body: string }[] = [];
    const svc = new CronService(store, root, {
      notifier: async (n) => {
        delivered.push(n);
      },
    });
    const job = store.create({
      name: 'alerts',
      user: 'alice',
      entryPath: '~/feeds/alerts/v1/src/index.js',
      cron: '0 0 31 2 *',
      pushNotify: true,
    });
    const runWith = async (d: number, body: string): Promise<void> => {
      await alfs.writeFile('~/feeds/alerts/v1/src/index.js', notifyFeedSrc(d, body));
      await svc.execute(job.id, 'manual');
    };

    // 第一次 run：投递一条真实告警
    await runWith(1000, 'ETH -3.2σ 异动');
    expect(delivered).toEqual([{ title: 'Alert', body: 'ETH -3.2σ 异动' }]);
    expect(store.get(job.id)!.last_notify_date).toBe(1000);

    // 同一条记录（同 date 桶 REPLACE 语义）再跑：不重复投递
    await runWith(1000, 'ETH -3.2σ 异动');
    expect(delivered).toHaveLength(1);

    // 静默运行：SKIP 哨兵不投递，但水位照常推进
    await runWith(2000, '<|SKIP_NOTIFICATION|> quiet');
    expect(delivered).toHaveLength(1);
    expect(store.get(job.id)!.last_notify_date).toBe(2000);

    // 新告警：正常投递
    await runWith(3000, 'BTC 突破位');
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.body).toBe('BTC 突破位');
  }, 60_000);

  it('reconcile 注册 active 任务、剔除暂停任务', () => {
    const job = store.create({
      name: 'tick',
      user: 'alice',
      entryPath: '~/feeds/tick/v1/src/index.js',
      cron: '0 * * * *',
    });
    service.reconcile();
    expect(service['timers'].size).toBe(1);
    store.setStatus(job.id, 'paused');
    service.reconcile();
    expect(service['timers'].size).toBe(0);
  });
});
