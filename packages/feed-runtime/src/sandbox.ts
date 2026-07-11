import fs from 'node:fs';
import path from 'node:path';
import { Alfs } from '@openalva/alfs';
import { createAlpiModule } from './alpiModule.js';
import { createFeedModule } from './feedSdk.js';
import type { AsyncTracker } from './tracker.js';

/**
 * jagent 兼容沙箱模块表（合同：jagent-runtime.md §Built-in Modules）。
 * 白名单：@alva/feed、alfs、env、secret-manager、net/http。
 * 其余模块（@alva/algorithm、@arrays/*、@alva/alvaask…）明确报「暂未提供」，
 * 相对导入 Phase 1 暂不支持——报错文案要可诊断。
 */

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type HttpFetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface SandboxOptions {
  root: string;
  user: string;
  args?: unknown;
  tracker: AsyncTracker;
  httpFetch: HttpFetchImpl;
  log: (line: string) => void;
  /** 被读取过的 secret 值——runFeed 据此对 logs/封套脱敏 */
  secretValues?: Set<string>;
}

export function buildRequire(opts: SandboxOptions): (name: string) => unknown {
  const { root, user, tracker } = opts;
  const alfsFacade = new Alfs(root, user);

  const modules = new Map<string, unknown>();

  modules.set('@alva/feed', createFeedModule({ root, user, tracker }));

  // alpi：确定性 pipeline 内的固定 LLM 调用（一行叙事/TLDR 等）
  modules.set(
    '@alva/pi',
    createAlpiModule({
      root,
      tracker,
      httpFetch: opts.httpFetch,
      ...(opts.secretValues ? { secretValues: opts.secretValues } : {}),
    }),
  );

  modules.set('env', {
    userId: '1',
    callerUserId: undefined,
    username: user,
    args: opts.args ?? {},
  });

  modules.set('secret-manager', {
    loadPlaintext(name: string): string | null {
      // 与 Alva 同形：同步返回，缺失为 null。单机版从 <root>/secrets.json 读。
      try {
        const map = JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8'));
        const v = map[name];
        if (typeof v !== 'string') return null;
        opts.secretValues?.add(v);
        return v;
      } catch {
        return null;
      }
    },
  });

  modules.set('net/http', {
    fetch: tracker.wrap((url: string, init?: Parameters<HttpFetchImpl>[1]) =>
      opts.httpFetch(url, init),
    ),
  });

  modules.set('alfs', {
    readFile: tracker.wrap((p: string) => alfsFacade.readFile(p)),
    readFileBytes: tracker.wrap((p: string) => alfsFacade.readFileBytes(p)),
    writeFile: tracker.wrap((p: string, content: string) => alfsFacade.writeFile(p, content)),
    stat: tracker.wrap((p: string) => alfsFacade.stat(p)),
    readDir: tracker.wrap((p: string) => alfsFacade.readDir(p)),
    mkdir: tracker.wrap((p: string) => alfsFacade.mkdir(p)),
    remove: tracker.wrap((p: string) => alfsFacade.remove(p)),
    removeAll: tracker.wrap((p: string) => alfsFacade.removeAll(p)),
    rename: tracker.wrap((a: string, b: string) => alfsFacade.rename(a, b)),
    copy: tracker.wrap((a: string, b: string) => alfsFacade.copy(a, b)),
    grantPermission: tracker.wrap((p: string, s: string, perm: string) =>
      alfsFacade.grantPermission(p, s, perm),
    ),
    revokePermission: tracker.wrap((p: string, s: string, perm: string) =>
      alfsFacade.revokePermission(p, s, perm),
    ),
    setPublicRead: tracker.wrap((p: string) => alfsFacade.setPublicRead(p)),
    mountSynth: tracker.wrap(async (_p: string) => {
      // Feed SDK 自建挂载；独立 mountSynth 场景后续按需实现
    }),
  });

  return function sandboxRequire(name: string): unknown {
    if (modules.has(name)) return modules.get(name);
    if (name.startsWith('./') || name.startsWith('../')) {
      throw new Error(
        `Relative imports are not supported by the OpenAlva feed runtime yet: require("${name}")`,
      );
    }
    throw new Error(
      `Module not available in OpenAlva feed runtime: require("${name}"). ` +
        `Available: @alva/feed, @alva/pi, alfs, env, secret-manager, net/http`,
    );
  };
}
