import { FeedStore, resolveAlfsPath, TsOutput, type TsRecord } from '@openalva/alfs';
import type { AsyncTracker } from './tracker.js';

/**
 * `@alva/feed` 兼容实现（合同：alva-official-skill references/feed-sdk.md）。
 * 覆盖 Phase 1 验收所需 API 面：Feed(def/run/setChart/path)、feedPath、
 * makeDoc、字段助手、ctx.self.ts().append 与读取、ctx.kv、ctx.upstream。
 */

export interface FieldDef {
  name: string;
  type: string;
  description?: string;
  fields?: FieldDef[];
}

export const fieldHelpers = {
  num: (name: string, description?: string): FieldDef => ({ name, type: 'number', ...d(description) }),
  str: (name: string, description?: string): FieldDef => ({ name, type: 'string', ...d(description) }),
  bool: (name: string, description?: string): FieldDef => ({ name, type: 'boolean', ...d(description) }),
  obj: (name: string, fields: FieldDef[]): FieldDef => ({ name, type: 'object', fields }),
  arr: (name: string, fields: FieldDef[]): FieldDef => ({ name, type: 'array', fields }),
  fld: (name: string, type: string, description?: string): FieldDef => ({ name, type, ...d(description) }),
};

function d(description?: string): { description?: string } {
  return description === undefined ? {} : { description };
}

export function makeDoc(
  name: string,
  description: string,
  fields: FieldDef[],
  ref?: unknown,
): Record<string, unknown> {
  return { name, description, fields, ...(ref !== undefined ? { ref } : {}) };
}

interface FeedConfig {
  path: string;
  name?: string;
  description?: string;
  upstreams?: Record<string, string>;
}

interface FeedDeps {
  root: string;
  user: string;
  tracker: AsyncTracker;
}

class WritableTimeSeries {
  constructor(
    private readonly out: TsOutput,
    private readonly tracker: AsyncTracker,
  ) {}

  append(records: TsRecord[]): Promise<void> {
    return this.tracker.track(this.out.append(records));
  }
  last(n?: number, before?: number): Promise<TsRecord[]> {
    return this.tracker.track(this.out.last(n, before));
  }
  first(n?: number, after?: number): Promise<TsRecord[]> {
    return this.tracker.track(this.out.first(n, after));
  }
  range(from: number, to?: number): Promise<TsRecord[]> {
    return this.tracker.track(this.out.range(from, to));
  }
  lastDate(): Promise<number | null> {
    return this.tracker.track(this.out.lastDate());
  }
  count(from?: number, to?: number): Promise<number> {
    return this.tracker.track(this.out.count(from, to));
  }
}

export function createFeedModule(deps: FeedDeps): Record<string, unknown> {
  const { root, user, tracker } = deps;

  function feedPath(name: string, version = 'v1'): string {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`Invalid feed name: ${name}`);
    return `/alva/home/${user}/feeds/${name}/${version}`;
  }

  class Feed {
    readonly path: string;
    private readonly config: FeedConfig;
    private readonly store: FeedStore;
    private readonly defs = new Map<string, Record<string, Record<string, unknown>>>();
    private chart: unknown = null;

    constructor(config: FeedConfig) {
      if (!config || typeof config.path !== 'string') {
        throw new Error('new Feed({path}) requires a path (use feedPath())');
      }
      this.config = config;
      this.path = config.path;
      this.store = new FeedStore(resolveAlfsPath(root, user, config.path));
    }

    def(groupName: string, outputs: Record<string, Record<string, unknown>>): void {
      if (groupName === 'data') {
        throw new Error('Group name "data" is not allowed (data/data/ nesting)');
      }
      this.defs.set(groupName, outputs);
    }

    setChart(chartConfig: unknown): void {
      this.chart = chartConfig;
    }

    run(callback: (ctx: FeedContext) => Promise<void>): Promise<void> {
      return tracker.track(this.runInner(callback));
    }

    private async runInner(callback: (ctx: FeedContext) => Promise<void>): Promise<void> {
      await this.store.ensureMount();
      for (const [group, outputs] of this.defs) {
        for (const [output, doc] of Object.entries(outputs)) {
          await this.store.ts(group, output).setTypedoc(doc);
        }
      }
      const ctx = this.buildContext();
      await callback(ctx);
      void this.chart; // chart 配置暂只保留在内存；持久化随 Playbook 发布阶段实现
    }

    private buildContext(): FeedContext {
      const store = this.store;
      const upstreams: Record<string, UpstreamFeed> = {};
      for (const [local, upath] of Object.entries(this.config.upstreams ?? {})) {
        upstreams[local] = new UpstreamFeed(resolveUpstreamPath(upath, user), root, tracker);
      }
      return {
        self: {
          ts: (group: string, output: string) =>
            new WritableTimeSeries(store.ts(group, output), tracker),
        },
        upstream: upstreams,
        kv: {
          load: (key: string) => tracker.track(store.kvLoad(key)),
          put: (key: string, value: string) => tracker.track(store.kvPut(key, value)),
        },
      };
    }
  }

  return { Feed, feedPath, makeDoc, ...fieldHelpers };
}

interface FeedContext {
  self: { ts(group: string, output: string): WritableTimeSeries };
  upstream: Record<string, UpstreamFeed>;
  kv: {
    load(key: string): Promise<string | undefined>;
    put(key: string, value: string): Promise<void>;
  };
}

/** upstream 写法 "@alice/feeds/btc-prices/v1" → ALFS 绝对路径。 */
function resolveUpstreamPath(spec: string, selfUser: string): string {
  if (spec.startsWith('@')) {
    const [userPart, ...rest] = spec.slice(1).split('/');
    return `/alva/home/${userPart}/${rest.join('/')}`;
  }
  if (spec.startsWith('~/')) return `/alva/home/${selfUser}/${spec.slice(2)}`;
  return spec;
}

class UpstreamFeed {
  private readonly store: FeedStore;
  constructor(
    alfsPath: string,
    root: string,
    private readonly tracker: AsyncTracker,
  ) {
    const user = alfsPath.split('/')[3] ?? '';
    this.store = new FeedStore(resolveAlfsPath(root, user, alfsPath));
  }

  ts(group: string, output: string): WritableTimeSeries {
    // 读写类型同构，上游仅约定用于读取
    return new WritableTimeSeries(this.store.ts(group, output), this.tracker);
  }
}
