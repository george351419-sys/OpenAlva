import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HttpFetchImpl } from './sandbox.js';
import type { ChildToHost, HostToChild } from './ipc.js';
import { envelope, type RunEnvelope } from './vmRun.js';

export { defaultHttpFetch, type RunEnvelope } from './vmRun.js';

/**
 * 执行一个 feed / jagent 脚本，返回与 `alva run` 同形的执行封套：
 * { error, logs, result, stats: { credits_used, duration_ms }, status }
 *
 * 隔离：每次运行 fork 一个一次性 node 子进程（tsx loader）执行 vm 沙箱。
 * vm 逃逸（宿主原型链够到 Function 构造器）只到达可丢弃的子进程；
 * 失控同步循环由宿主超时 SIGKILL 中断；maxHeapSizeMb 经
 * --max-old-space-size 生效。自定义 httpFetch（如 Arrays 路由）经 IPC
 * 桥回宿主执行，函数不跨进程。
 */

export interface RunFeedOptions {
  root: string;
  user: string;
  /** ALFS 路径（~/... 或 /alva/home/...）；与 code 二选一 */
  entryPath?: string;
  code?: string;
  args?: unknown;
  httpFetch?: HttpFetchImpl;
  timeoutMs?: number;
  /** 子进程 V8 老生代上限（MB），对应 deploy 的 max_heap_size_mb */
  maxHeapSizeMb?: number;
}

/**
 * 进程内全局串行化：同进程并发 runFeed 会带来 rows.json/@kv 竞态（review
 * P1-1/P1-2），排队执行。跨进程并发（CLI 与 server 同时跑）仍无锁，
 * 风险登记在 DEV-PLAN。
 */
let runQueue: Promise<unknown> = Promise.resolve();

export function runFeed(opts: RunFeedOptions): Promise<RunEnvelope> {
  const next = runQueue.then(() => runFeedInChild(opts));
  runQueue = next.catch(() => undefined);
  return next;
}

function tsxImportSpecifier(): string {
  try {
    return import.meta.resolve('tsx');
  } catch {
    return 'tsx';
  }
}

async function runFeedInChild(opts: RunFeedOptions): Promise<RunEnvelope> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const childPath = fileURLToPath(new URL('./feedChild.ts', import.meta.url));
  const execArgv = ['--import', tsxImportSpecifier()];
  if (opts.maxHeapSizeMb !== undefined && opts.maxHeapSizeMb > 0) {
    execArgv.push(`--max-old-space-size=${Math.floor(opts.maxHeapSizeMb)}`);
  }

  let child: ChildProcess;
  try {
    child = fork(childPath, [], {
      execArgv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
  } catch (err) {
    return envelope(
      `Failed to spawn feed sandbox process: ${String((err as Error).message ?? err)}`,
      [],
      'undefined',
      started,
      'failed',
    );
  }

  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  return new Promise<RunEnvelope>((resolve) => {
    let settled = false;
    const childLogs: string[] = [];
    let runTimer: NodeJS.Timeout | undefined;
    // 启动守卫：tsx loader 挂死（不发 ready）也能兜底退出
    const readyGuard = setTimeout(
      () => fail('Feed sandbox failed to become ready within 30000ms'),
      30_000,
    );

    const finish = (env: RunEnvelope): void => {
      if (settled) return;
      settled = true;
      clearTimeout(readyGuard);
      if (runTimer) clearTimeout(runTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(env);
    };
    // 失败封套带上子进程已实时回传的（已脱敏）日志——超时/崩溃不再丢日志
    const fail = (message: string): void =>
      finish(envelope(message, childLogs, 'undefined', started, 'failed'));

    const sendToChild = (msg: HostToChild): void => {
      try {
        child.send(msg);
      } catch {
        // 子进程已退出（如超时被杀），丢弃即可
      }
    };

    child.on('message', (raw: ChildToHost) => {
      if (settled) return;
      if (raw.type === 'ready') {
        // 就绪后才发 run 并起算业务超时：timeoutMs 不含 fork/loader 启动开销
        clearTimeout(readyGuard);
        runTimer = setTimeout(() => fail(`Feed run timed out after ${timeoutMs}ms`), timeoutMs);
        sendToChild({
          type: 'run',
          root: opts.root,
          user: opts.user,
          ...(opts.entryPath !== undefined ? { entryPath: opts.entryPath } : {}),
          ...(opts.code !== undefined ? { code: opts.code } : {}),
          ...(opts.args !== undefined ? { args: opts.args } : {}),
          httpBridge: opts.httpFetch !== undefined,
        });
        return;
      }
      if (raw.type === 'log') {
        childLogs.push(raw.line);
        return;
      }
      if (raw.type === 'result') {
        finish(raw.envelope);
        return;
      }
      if (raw.type === 'http') {
        const httpFetch = opts.httpFetch;
        if (!httpFetch) {
          sendToChild({
            type: 'http-result',
            id: raw.id,
            ok: false,
            error: 'http bridge requested but host has no httpFetch',
          });
          return;
        }
        void (async () => {
          try {
            const resp = await httpFetch(raw.url, raw.init);
            const body = await resp.text();
            sendToChild({
              type: 'http-result',
              id: raw.id,
              ok: true,
              response: { status: resp.status, ok: resp.ok, headers: resp.headers, body },
            });
          } catch (err) {
            sendToChild({
              type: 'http-result',
              id: raw.id,
              ok: false,
              error: String((err as Error).message ?? err),
            });
          }
        })();
      }
    });

    child.on('error', (err) => fail(`Feed sandbox process error: ${err.message}`));

    child.on('exit', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      fail(
        `Feed sandbox exited before returning a result (code=${code}, signal=${signal})` +
          (stderr ? `\n${stderr.slice(0, 2000)}` : ''),
      );
    });
  });
}
