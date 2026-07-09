import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Alfs, initOpenAlvaRoot, openAlvaPaths, resolveOpenAlvaRoot } from '@openalva/alfs';
import { runFeed } from '@openalva/feed-runtime';
import { CronService, SchedulerStore } from '@openalva/scheduler';

/**
 * openalva CLI 派发器。动词面对齐 alva CLI 子集：
 *   openalva fs <read|write|readdir|stat|mkdir|remove|grant>
 *   openalva run --entry-path <p> | --code <c> [--args <json>] [--timeout-ms <n>]
 *   openalva deploy <create|list|get|pause|resume|delete|trigger|runs>
 * 输出一律 JSON（成功为数据本身，与 alva CLI 一致）。
 */

export class CliUsageError extends Error {}

async function defaultUser(root: string): Promise<string> {
  try {
    const config = JSON.parse(
      await fs.readFile(openAlvaPaths(root).configFile, 'utf8'),
    ) as { defaultUser?: string };
    if (config.defaultUser) return config.defaultUser;
  } catch {
    // 未初始化 → 用系统用户名兜底并初始化
  }
  const user = process.env['USER'] ?? 'openalva';
  await initOpenAlvaRoot(user, root);
  return user;
}

export async function dispatch(argv: string[], rootOverride?: string): Promise<unknown> {
  const root = rootOverride ?? resolveOpenAlvaRoot();
  const [group, verb, ...rest] = argv;
  if (!group) throw new CliUsageError('Usage: openalva <fs|run|deploy> ...');
  const user = await defaultUser(root);

  if (group === 'fs') return dispatchFs(verb, rest, root, user);
  if (group === 'run') return dispatchRun([verb ?? '', ...rest].filter(Boolean), root, user);
  if (group === 'deploy') return dispatchDeploy(verb, rest, root, user);
  throw new CliUsageError(`Unknown command group: ${group}`);
}

async function dispatchFs(
  verb: string | undefined,
  rest: string[],
  root: string,
  user: string,
): Promise<unknown> {
  const alfs = new Alfs(root, user);
  const opt = (spec: Record<string, { type: 'string' | 'boolean' }>) =>
    parseArgs({ args: rest, options: spec, allowPositionals: false }).values as Record<
      string,
      string | boolean | undefined
    >;
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined;

  switch (verb) {
    case 'read': {
      const v = opt({ path: { type: 'string' } });
      const p = str(v['path']);
      if (!p) throw new CliUsageError('fs read requires --path');
      const content = await alfs.readFile(p);
      try {
        return JSON.parse(content); // 虚拟查询/JSON 文件 → 结构化输出
      } catch {
        return content;
      }
    }
    case 'write': {
      const v = opt({
        path: { type: 'string' },
        content: { type: 'string' },
        file: { type: 'string' },
        'mkdir-parents': { type: 'boolean' },
      });
      const p = str(v['path']);
      const inline = str(v['content']);
      const file = str(v['file']);
      if (!p || (inline === undefined && file === undefined)) {
        throw new CliUsageError('fs write requires --path and --content|--file');
      }
      const content = inline ?? (await fs.readFile(file!, 'utf8'));
      await alfs.writeFile(p, content);
      return { success: true, path: p, bytes: Buffer.byteLength(content) };
    }
    case 'readdir': {
      const v = opt({ path: { type: 'string' } });
      const p = str(v['path']);
      if (!p) throw new CliUsageError('fs readdir requires --path');
      return { entries: await alfs.readDir(p) };
    }
    case 'stat': {
      const v = opt({ path: { type: 'string' } });
      const p = str(v['path']);
      if (!p) throw new CliUsageError('fs stat requires --path');
      return alfs.stat(p);
    }
    case 'mkdir': {
      const v = opt({ path: { type: 'string' } });
      const p = str(v['path']);
      if (!p) throw new CliUsageError('fs mkdir requires --path');
      await alfs.mkdir(p);
      return { success: true };
    }
    case 'remove': {
      const v = opt({ path: { type: 'string' }, recursive: { type: 'boolean' } });
      const p = str(v['path']);
      if (!p) throw new CliUsageError('fs remove requires --path');
      if (v['recursive']) await alfs.removeAll(p);
      else await alfs.remove(p);
      return { success: true };
    }
    case 'grant': {
      const v = opt({
        path: { type: 'string' },
        subject: { type: 'string' },
        permission: { type: 'string' },
      });
      const p = str(v['path']);
      const subject = str(v['subject']);
      const permission = str(v['permission']);
      if (!p || !subject || !permission) {
        throw new CliUsageError('fs grant requires --path --subject --permission');
      }
      await alfs.grantPermission(p, subject, permission);
      return { success: true };
    }
    default:
      throw new CliUsageError(`Unknown fs verb: ${verb}`);
  }
}

async function dispatchRun(rest: string[], root: string, user: string): Promise<unknown> {
  const v = parseArgs({
    args: rest,
    options: {
      'entry-path': { type: 'string' },
      code: { type: 'string' },
      args: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
    allowPositionals: false,
  }).values;
  if (!v['entry-path'] && v.code === undefined) {
    throw new CliUsageError('run requires --entry-path or --code');
  }
  return runFeed({
    root,
    user,
    ...(v['entry-path'] ? { entryPath: v['entry-path'] } : {}),
    ...(v.code !== undefined ? { code: v.code } : {}),
    ...(v.args !== undefined ? { args: JSON.parse(v.args) } : {}),
    ...(v['timeout-ms'] !== undefined ? { timeoutMs: Number(v['timeout-ms']) } : {}),
  });
}

async function dispatchDeploy(
  verb: string | undefined,
  rest: string[],
  root: string,
  user: string,
): Promise<unknown> {
  const store = new SchedulerStore(openAlvaPaths(root).dbFile);
  try {
    const opt = (spec: Record<string, { type: 'string' | 'boolean' }>) =>
      parseArgs({ args: rest, options: spec, allowPositionals: false }).values as Record<
        string,
        string | boolean | undefined
      >;
    const str = (v: string | boolean | undefined): string | undefined =>
      typeof v === 'string' ? v : undefined;

    switch (verb) {
      case 'create': {
        const v = opt({
          name: { type: 'string' },
          path: { type: 'string' },
          cron: { type: 'string' },
          'push-notify': { type: 'boolean' },
          'max-heap-size-mb': { type: 'string' },
        });
        const name = str(v['name']);
        const entryPath = str(v['path']);
        const cron = str(v['cron']);
        if (!name || !entryPath || !cron) {
          throw new CliUsageError('deploy create requires --name --path --cron');
        }
        return store.create({
          name,
          user,
          entryPath,
          cron,
          ...(v['push-notify'] !== undefined ? { pushNotify: v['push-notify'] === true } : {}),
          ...(str(v['max-heap-size-mb']) !== undefined
            ? { maxHeapSizeMb: Number(str(v['max-heap-size-mb'])) }
            : {}),
        });
      }
      case 'list':
        return store.list(user);
      case 'get':
      case 'pause':
      case 'resume':
      case 'delete':
      case 'trigger':
      case 'runs': {
        const v = opt({ id: { type: 'string' }, limit: { type: 'string' } });
        const idStr = str(v['id']);
        if (!idStr) throw new CliUsageError(`deploy ${verb} requires --id`);
        const id = Number(idStr);
        if (verb === 'get') return store.get(id) ?? { error: 'not found' };
        if (verb === 'pause') return store.setStatus(id, 'paused');
        if (verb === 'resume') return store.setStatus(id, 'active');
        if (verb === 'delete') return store.setStatus(id, 'deleted');
        if (verb === 'runs') return store.runs(id, str(v['limit']) ? Number(str(v['limit'])) : 20);
        // trigger：立即执行一次并返回任务与最新 run
        const service = new CronService(store, root);
        const job = await service.execute(id, 'manual');
        return { job, latest_run: store.runs(id, 1)[0] ?? null };
      }
      default:
        throw new CliUsageError(`Unknown deploy verb: ${verb}`);
    }
  } finally {
    store.close();
  }
}
