import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsOutput } from '@openalva/alfs';
import { runFeed } from './runFeed.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-rf-'));
  await fs.mkdir(path.join(root, 'home', 'alice'), { recursive: true });
  await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ MY_KEY: 'sk-supersecret-123' }));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('runFeed 修复回归（review P0/P1）', () => {
  it('P0-1：快速脚本立即返回，不等超时定时器', async () => {
    const t0 = Date.now();
    const env = await runFeed({ root, user: 'alice', code: '1 + 1', timeoutMs: 30_000 });
    expect(env.status).toBe('completed');
    expect(env.result).toBe('2');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('P0-2 缓解：沙箱内直接 eval / new Function 被封（纵深防御）', async () => {
    // 直接字符串代码生成被 codeGeneration:false 拦下
    for (const code of ['eval("1+1")', 'new Function("return 1")()']) {
      const env = await runFeed({ root, user: 'alice', code });
      expect(env.status).toBe('failed');
      expect(String(env.error)).toMatch(/code generation|EvalError/i);
    }
    // 已知未封：经宿主对象原型链够到宿主 Function 构造器仍可逃逸——
    // vm 非安全边界，Phase 1 明确接受（DEV-PLAN §1.7 信任模型），
    // 根治靠 Phase 3 子进程隔离。此处记录真实行为以防回归时误判。
    const escape = await runFeed({
      root,
      user: 'alice',
      code: 'this.constructor.constructor("return 1")()',
    });
    expect(escape.status).toBe('completed');
  });

  it('P1-2：同进程并发 runFeed 串行执行，错误互不串扰', async () => {
    const [ok, bad] = await Promise.all([
      runFeed({ root, user: 'alice', code: 'console.log("A"); 1' }),
      runFeed({
        root,
        user: 'alice',
        code: '(async () => { throw new Error("B-fail"); })();',
      }),
    ]);
    expect(ok.status).toBe('completed');
    expect(ok.error).toBeNull();
    expect(bad.status).toBe('failed');
    expect(String(bad.error)).toContain('B-fail');
  });

  it('P1-3：secret 值不进 logs/error/result（脱敏为 [REDACTED]）', async () => {
    const env = await runFeed({
      root,
      user: 'alice',
      code: `
        const secret = require("secret-manager");
        const k = secret.loadPlaintext("MY_KEY");
        console.log("key is", k);
        k;
      `,
    });
    expect(env.status).toBe('completed');
    expect(env.logs).not.toContain('sk-supersecret-123');
    expect(env.logs).toContain('[REDACTED]');
    expect(env.result).toBe('[REDACTED]');
  });

  it('超时脚本以 failed 封套返回', async () => {
    // 永远挂起的 tracked 操作：http 永不 resolve
    const env = await runFeed({
      root,
      user: 'alice',
      code: 'const http = require("net/http"); http.fetch("https://x.invalid/hang");',
      httpFetch: () => new Promise(() => {}),
      timeoutMs: 500,
    });
    expect(env.status).toBe('failed');
    expect(String(env.error)).toContain('timed out');
  }, 5_000);
});

describe('tsstore 并发写保护（review P1-1）', () => {
  it('并发 append 不丢写', async () => {
    const out = new TsOutput(path.join(root, 'home', 'alice', 'feeds', 'c', 'v1', 'data', 'm', 'x'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => out.append([{ date: 1000 + i, v: i }])),
    );
    expect(await out.count()).toBe(20);
  });
});
