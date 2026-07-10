import { Alfs } from '@openalva/alfs';
import { ArraysViaAlvaSource, DataError, loadCatalog, type DataSource } from '@openalva/data';
import { runFeed } from '@openalva/feed-runtime';
import type { CronService, SchedulerStore } from '@openalva/scheduler';
import { ReleaseService } from './releaseService.js';

export interface ToolEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentToolsOptions {
  root: string;
  user: string;
  dataSource?: DataSource;
  /**
   * 与常驻调度器共享同一 store/service 实例：deploy.trigger 才能命中
   * CronService 的同任务并发保护，且不再每次调用新开 SQLite 连接。
   */
  schedulerStore: SchedulerStore;
  cronService: CronService;
}

export class AgentTools {
  private readonly alfs: Alfs;
  private readonly dataSource: DataSource;
  private readonly releases: ReleaseService;

  constructor(private readonly opts: AgentToolsOptions) {
    this.alfs = new Alfs(opts.root, opts.user);
    this.dataSource = opts.dataSource ?? new ArraysViaAlvaSource();
    this.releases = new ReleaseService(opts.root, opts.user);
  }

  specs(): ToolSpec[] {
    return [
      spec('fs.read', 'Read an ALFS file or virtual feed query path.', {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      }),
      spec('fs.write', 'Write a normal ALFS file. Feed data mounts remain write-protected.', {
        type: 'object',
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      }),
      spec('fs.readdir', 'List an ALFS directory.', {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      }),
      spec('fs.stat', 'Return basic ALFS file metadata.', {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      }),
      spec('fs.mkdir', 'Create an ALFS directory recursively.', {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      }),
      spec('fs.grant', 'Record a single-machine ALFS grant stub.', {
        type: 'object',
        required: ['path', 'subject', 'permission'],
        properties: {
          path: { type: 'string' },
          subject: { type: 'string' },
          permission: { type: 'string' },
        },
      }),
      spec('run', 'Run a feed script from ALFS or inline code.', {
        type: 'object',
        properties: {
          entryPath: { type: 'string' },
          code: { type: 'string' },
          args: { type: 'object' },
          timeoutMs: { type: 'number' },
        },
      }),
      spec('deploy.create', 'Create a scheduled feed run.', {
        type: 'object',
        required: ['name', 'entryPath', 'cron'],
        properties: {
          name: { type: 'string' },
          entryPath: { type: 'string' },
          cron: { type: 'string' },
          pushNotify: { type: 'boolean' },
          maxHeapSizeMb: { type: 'number' },
        },
      }),
      spec('deploy.list', 'List scheduled feed runs for the current user.', {
        type: 'object',
        properties: {},
      }),
      spec('deploy.get', 'Get one scheduled feed run.', idSchema()),
      spec('deploy.pause', 'Pause one scheduled feed run.', idSchema()),
      spec('deploy.resume', 'Resume one scheduled feed run.', idSchema()),
      spec('deploy.delete', 'Mark one scheduled feed run deleted.', idSchema()),
      spec('deploy.trigger', 'Run one scheduled feed immediately.', idSchema()),
      spec('deploy.runs', 'List recent run history for a scheduled feed.', {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'number' }, limit: { type: 'number' } },
      }),
      spec('data.call', 'Call a mirrored Data Skill endpoint through the configured driver.', {
        type: 'object',
        required: ['skill', 'endpoint', 'params'],
        properties: {
          skill: { type: 'string' },
          endpoint: { type: 'string' },
          params: { type: 'object' },
        },
      }),
      spec('skills.list', 'List mirrored Data Skills and endpoint counts.', {
        type: 'object',
        properties: {},
      }),
      spec('skills.get', 'Get one mirrored Data Skill summary.', {
        type: 'object',
        required: ['skill'],
        properties: { skill: { type: 'string' } },
      }),
      spec('release.playbookDraft', 'Create or update a draft playbook directory and playbook.json.', {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          displayName: { type: 'string' },
          description: { type: 'string' },
          feeds: { type: 'array', items: { type: 'string' } },
        },
      }),
      spec('release.playbook', 'Publish a playbook index.html as an immutable local release snapshot.', {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          changelog: { type: 'string' },
        },
      }),
    ];
  }

  async execute(name: string, input: unknown): Promise<ToolEnvelope> {
    try {
      const data = await this.executeRaw(name, objectInput(input));
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: {
          code: err instanceof DataError ? err.code : 'TOOL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async executeRaw(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'fs.read':
        return { content: await this.alfs.readFile(reqString(input, 'path')) };
      case 'fs.write': {
        const path = reqString(input, 'path');
        const content = reqString(input, 'content');
        await this.alfs.writeFile(path, content);
        return { path, bytes: Buffer.byteLength(content) };
      }
      case 'fs.readdir':
        return { entries: await this.alfs.readDir(reqString(input, 'path')) };
      case 'fs.stat':
        return this.alfs.stat(reqString(input, 'path'));
      case 'fs.mkdir':
        await this.alfs.mkdir(reqString(input, 'path'));
        return { path: reqString(input, 'path') };
      case 'fs.grant':
        await this.alfs.grantPermission(
          reqString(input, 'path'),
          reqString(input, 'subject'),
          reqString(input, 'permission'),
        );
        return { granted: true };
      case 'run':
        return runFeed({
          root: this.opts.root,
          user: this.opts.user,
          ...(typeof input['entryPath'] === 'string' ? { entryPath: input['entryPath'] } : {}),
          ...(typeof input['code'] === 'string' ? { code: input['code'] } : {}),
          ...(input['args'] !== undefined ? { args: input['args'] } : {}),
          ...(typeof input['timeoutMs'] === 'number' ? { timeoutMs: input['timeoutMs'] } : {}),
        });
      case 'data.call':
        return this.dataSource.call({
          skill: reqString(input, 'skill'),
          endpoint: reqString(input, 'endpoint'),
          params: paramsInput(input['params']),
        });
      case 'skills.list': {
        const catalog = loadCatalog();
        return {
          skills: catalog.skills.map((s) => ({
            name: s.name,
            description: s.description,
            endpoint_count: s.endpoint_count,
            pro_count: s.pro_count,
          })),
        };
      }
      case 'skills.get': {
        const catalog = loadCatalog();
        const skill = reqString(input, 'skill');
        const found = catalog.skills.find((s) => s.name === skill);
        if (!found) throw new Error(`Unknown skill: ${skill}`);
        return found;
      }
      case 'release.playbookDraft':
        return this.releases.createDraft({
          name: reqString(input, 'name'),
          ...(typeof input['displayName'] === 'string' ? { displayName: input['displayName'] } : {}),
          ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
          ...(Array.isArray(input['feeds'])
            ? { feeds: input['feeds'].filter((v): v is string => typeof v === 'string') }
            : {}),
        });
      case 'release.playbook':
        return this.releases.publish({
          name: reqString(input, 'name'),
          ...(typeof input['version'] === 'string' ? { version: input['version'] } : {}),
          ...(typeof input['changelog'] === 'string' ? { changelog: input['changelog'] } : {}),
        });
      default:
        return this.executeDeploy(name, input);
    }
  }

  private async executeDeploy(name: string, input: Record<string, unknown>): Promise<unknown> {
    const store = this.opts.schedulerStore;
    switch (name) {
      case 'deploy.create':
        return store.create({
          name: reqString(input, 'name'),
          user: this.opts.user,
          entryPath: reqString(input, 'entryPath'),
          cron: reqString(input, 'cron'),
          ...(typeof input['pushNotify'] === 'boolean'
            ? { pushNotify: input['pushNotify'] }
            : {}),
          ...(typeof input['maxHeapSizeMb'] === 'number'
            ? { maxHeapSizeMb: input['maxHeapSizeMb'] }
            : {}),
        });
      case 'deploy.list':
        return { jobs: store.list(this.opts.user) };
      case 'deploy.get':
        return store.get(reqNumber(input, 'id')) ?? null;
      case 'deploy.pause':
        return store.setStatus(reqNumber(input, 'id'), 'paused') ?? null;
      case 'deploy.resume':
        return store.setStatus(reqNumber(input, 'id'), 'active') ?? null;
      case 'deploy.delete':
        return store.setStatus(reqNumber(input, 'id'), 'deleted') ?? null;
      case 'deploy.runs':
        return { runs: store.runs(reqNumber(input, 'id'), optNumber(input, 'limit') ?? 20) };
      case 'deploy.trigger': {
        const job = await this.opts.cronService.execute(reqNumber(input, 'id'), 'manual');
        return { job, latest_run: store.runs(reqNumber(input, 'id'), 1)[0] ?? null };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

function spec(name: string, description: string, input_schema: Record<string, unknown>): ToolSpec {
  return { name, description, input_schema };
}

function idSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'number' } },
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function paramsInput(input: unknown): Record<string, string | number | boolean | undefined> {
  const obj = objectInput(input);
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === undefined
    ) {
      out[key] = value;
    } else if (value !== null) {
      out[key] = String(value);
    }
  }
  return out;
}

function reqString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function reqNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} is required`);
  return value;
}

function optNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}
