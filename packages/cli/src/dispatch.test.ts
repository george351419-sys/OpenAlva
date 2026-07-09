import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initOpenAlvaRoot } from '@openalva/alfs';
import { dispatch } from './dispatch.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-cli-'));
  await initOpenAlvaRoot('alice', root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('openalva CLI 派发', () => {
  it('fs write/read/readdir/stat 闭环', async () => {
    await dispatch(
      ['fs', 'write', '--path', '~/playbooks/demo/README.md', '--content', '# hi'],
      root,
    );
    expect(await dispatch(['fs', 'read', '--path', '~/playbooks/demo/README.md'], root)).toBe(
      '# hi',
    );
    const dir = (await dispatch(['fs', 'readdir', '--path', '~/playbooks/demo'], root)) as {
      entries: { name: string }[];
    };
    expect(dir.entries.map((e) => e.name)).toEqual(['README.md']);
    const st = (await dispatch(
      ['fs', 'stat', '--path', '~/playbooks/demo/README.md'],
      root,
    )) as { exists: boolean };
    expect(st.exists).toBe(true);
  });

  it('run --code 返回 alva 同形封套；日志与错误如实上报', async () => {
    const okEnv = (await dispatch(
      ['run', '--code', 'console.log("hello"); 1 + 1'],
      root,
    )) as Record<string, unknown>;
    expect(okEnv['status']).toBe('completed');
    expect(okEnv['logs']).toBe('hello\n');
    expect(okEnv['result']).toBe('2');
    expect((okEnv['stats'] as { credits_used: number }).credits_used).toBe(0);

    const badEnv = (await dispatch(['run', '--code', 'return 1'], root)) as Record<
      string,
      unknown
    >;
    expect(badEnv['status']).toBe('failed'); // 顶层 return 非法，与 alva run 行为一致
    expect(String(badEnv['error'])).toContain('return');
  });

  it('deploy create → trigger → runs 端到端（feed 数据经 CLI fs read 可见）', async () => {
    const feedCode = `
const { Feed, feedPath, makeDoc, num } = require("@alva/feed");
const feed = new Feed({ path: feedPath("cli-demo") });
feed.def("m", { x: makeDoc("X", "d", [num("v")]) });
(async () => {
  await feed.run(async (ctx) => {
    await ctx.self.ts("m", "x").append([{ date: 1700000000000, v: 7 }]);
  });
})();
`;
    await dispatch(
      ['fs', 'write', '--path', '~/feeds/cli-demo/v1/src/index.js', '--content', feedCode],
      root,
    );
    const job = (await dispatch(
      ['deploy', 'create', '--name', 'cli-demo', '--path', '~/feeds/cli-demo/v1/src/index.js', '--cron', '0 0 31 2 *'],
      root,
    )) as { id: number; status: string };
    expect(job.status).toBe('active');

    const triggered = (await dispatch(
      ['deploy', 'trigger', '--id', String(job.id)],
      root,
    )) as { latest_run: { status: string } };
    expect(triggered.latest_run.status).toBe('completed');

    const rows = (await dispatch(
      ['fs', 'read', '--path', '~/feeds/cli-demo/v1/data/m/x/@last/10'],
      root,
    )) as { v: number }[];
    expect(rows[0]!.v).toBe(7);

    const runs = (await dispatch(['deploy', 'runs', '--id', String(job.id)], root)) as unknown[];
    expect(runs).toHaveLength(1);

    const paused = (await dispatch(['deploy', 'pause', '--id', String(job.id)], root)) as {
      status: string;
    };
    expect(paused.status).toBe('paused');
  });
});
