import vm from 'node:vm';
import { Alfs } from '@openalva/alfs';
import { fetch as undiciFetch } from 'undici';
import { buildRequire, type HttpFetchImpl } from './sandbox.js';
import { AsyncTracker } from './tracker.js';

/**
 * vm 执行核心：在「当前进程」里跑一个 feed 脚本并返回 alva run 同形封套。
 * 本模块不做进程隔离——隔离由 runFeed（host）fork feedChild 承担；
 * 这里保留的 codeGeneration:false / 模块白名单是纵深防御的第二层。
 */

export interface RunEnvelope {
  error: string | null;
  logs: string;
  result: string;
  stats: { credits_used: number; duration_ms: number };
  status: 'completed' | 'failed';
}

export interface VmRunOptions {
  root: string;
  user: string;
  /** ALFS 路径（~/... 或 /alva/home/...）；与 code 二选一 */
  entryPath?: string;
  code?: string;
  args?: unknown;
  httpFetch: HttpFetchImpl;
  /** 每条日志产生时回调（已按当前已知 secret 脱敏）；供 host 在超时/崩溃时保留日志 */
  onLog?: (line: string) => void;
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

export async function executeFeedVm(opts: VmRunOptions): Promise<RunEnvelope> {
  const started = Date.now();
  const logs: string[] = [];
  const tracker = new AsyncTracker();

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
  const redact = (text: string): string => {
    // review P1-3：feed 代码误 log secret 时不落盘、不进封套
    let out = text;
    for (const v of secretValues) {
      if (v.length >= 4) out = out.split(v).join('[REDACTED]');
    }
    return out;
  };
  const pushLog = (line: string): void => {
    logs.push(line);
    // 实时回传按「此刻已知」的 secret 脱敏；之后加载的 secret 不可能出现在更早的行里
    opts.onLog?.(redact(line));
  };
  const require = buildRequire({
    root: opts.root,
    user: opts.user,
    args: opts.args,
    tracker,
    httpFetch: opts.httpFetch,
    log: pushLog,
    secretValues,
  });

  const consoleShim = {
    log: (...a: unknown[]) => pushLog(a.map(fmt).join(' ')),
    error: (...a: unknown[]) => pushLog(a.map(fmt).join(' ')),
    warn: (...a: unknown[]) => pushLog(a.map(fmt).join(' ')),
    info: (...a: unknown[]) => pushLog(a.map(fmt).join(' ')),
  };

  const moduleShim = { exports: {} };
  // codeGeneration:false 封死 eval / new Function(string) 这类直接的字符串
  // 代码生成（review P0-2 的缓解项）。经宿主对象原型链仍可够到本进程的
  // Function 构造器——但本进程是一次性沙箱子进程，逃逸面已被 fork 隔离收口。
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
  try {
    const script = new vm.Script(code, { filename: 'main.js' });
    result = script.runInContext(context);
    await tracker.drain();
  } catch (err) {
    error = errMessage(err);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  if (error === null && tracker.firstError !== null) {
    error = errMessage(tracker.firstError);
  }

  const redactedLogs = logs.map(redact);
  return envelope(
    error === null ? null : redact(error),
    redactedLogs,
    redact(fmt(result)),
    started,
    error === null ? 'completed' : 'failed',
  );
}

export function fmt(v: unknown): string {
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

export function envelope(
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
