import vm from 'node:vm';
import { Alfs } from '@openalva/alfs';
import { fetch as undiciFetch } from 'undici';
import { buildRequire, type HttpFetchImpl } from './sandbox.js';
import { AsyncTracker } from './tracker.js';

/**
 * 执行一个 feed / jagent 脚本，返回与 `alva run` 同形的执行封套：
 * { error, logs, result, stats: { credits_used, duration_ms }, status }
 *
 * 完成语义：脚本求值 + 所有被追踪异步操作静默（整个 async IIFE 跑完）。
 * 隔离说明：Phase 1 采用进程内 vm 上下文（模块白名单保真优先）；
 * 超时用 Promise.race 兜底，无法中断失控同步循环——DEV-PLAN 已记录，
 * 后续替换为子进程隔离时本 API 不变。
 */

export interface RunEnvelope {
  error: string | null;
  logs: string;
  result: string;
  stats: { credits_used: number; duration_ms: number };
  status: 'completed' | 'failed';
}

export interface RunFeedOptions {
  root: string;
  user: string;
  /** ALFS 路径（~/... 或 /alva/home/...）；与 code 二选一 */
  entryPath?: string;
  code?: string;
  args?: unknown;
  httpFetch?: HttpFetchImpl;
  timeoutMs?: number;
}

export const defaultHttpFetch: HttpFetchImpl = async (url, init) => {
  const resp = await undiciFetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const text = await resp.text();
  return {
    status: resp.status,
    ok: resp.ok,
    headers,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};

/**
 * 进程内全局串行化：同进程并发 runFeed 会带来 rows.json/@kv 竞态与
 * unhandledRejection 归因错乱（review P1-1/P1-2），Phase 1 直接排队执行。
 * 跨进程并发（CLI 与 server 同时跑）仍无锁，风险登记在 DEV-PLAN。
 */
let runQueue: Promise<unknown> = Promise.resolve();

export function runFeed(opts: RunFeedOptions): Promise<RunEnvelope> {
  const next = runQueue.then(() => runFeedInner(opts));
  runQueue = next.catch(() => undefined);
  return next;
}

async function runFeedInner(opts: RunFeedOptions): Promise<RunEnvelope> {
  const started = Date.now();
  const logs: string[] = [];
  const tracker = new AsyncTracker();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let code: string;
  try {
    if (opts.code !== undefined) {
      code = opts.code;
    } else if (opts.entryPath) {
      code = await new Alfs(opts.root, opts.user).readFile(opts.entryPath);
    } else {
      throw new Error('runFeed requires entryPath or code');
    }
  } catch (err) {
    return envelope(String((err as Error).message ?? err), logs, 'undefined', started, 'failed');
  }

  const secretValues = new Set<string>();
  const require = buildRequire({
    root: opts.root,
    user: opts.user,
    args: opts.args,
    tracker,
    httpFetch: opts.httpFetch ?? defaultHttpFetch,
    log: (line) => logs.push(line),
    secretValues,
  });

  const consoleShim = {
    log: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')),
    error: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')),
    warn: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')),
    info: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')),
  };

  const moduleShim = { exports: {} };
  // codeGeneration:false 封死 eval / new Function(string) 这类最常见的
  // 上下文逃逸路径（review P0-2 的缓解项）。vm 本身不是安全边界——
  // Phase 1 信任模型与剩余逃逸面已登记在 DEV-PLAN §1.7。
  const context = vm.createContext(
    {
      require,
      console: consoleShim,
      module: moduleShim,
      exports: moduleShim.exports,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );

  const onUnhandled = (reason: unknown): void => {
    tracker.noteError(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  let result: unknown;
  let error: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const script = new vm.Script(code, { filename: 'main.js' });
    result = script.runInContext(context);
    await Promise.race([
      tracker.drain(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Feed run timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } catch (err) {
    error = errMessage(err);
  } finally {
    if (timer) clearTimeout(timer); // review P0-1：不清理会吊住事件循环直到超时
    process.off('unhandledRejection', onUnhandled);
  }

  if (error === null && tracker.firstError !== null) {
    error = errMessage(tracker.firstError);
  }

  const redact = (text: string): string => {
    // review P1-3：feed 代码误 log secret 时不落盘、不进封套
    let out = text;
    for (const v of secretValues) {
      if (v.length >= 4) out = out.split(v).join('[REDACTED]');
    }
    return out;
  };
  const redactedLogs = logs.map(redact);
  return envelope(
    error === null ? null : redact(error),
    redactedLogs,
    redact(fmt(result)),
    started,
    error === null ? 'completed' : 'failed',
  );
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ''}`.trim();
  return String(err);
}

function envelope(
  error: string | null,
  logs: string[],
  result: string,
  started: number,
  status: 'completed' | 'failed',
): RunEnvelope {
  return {
    error,
    logs: logs.length ? logs.join('\n') + '\n' : '',
    result,
    stats: { credits_used: 0, duration_ms: Date.now() - started },
    status,
  };
}
