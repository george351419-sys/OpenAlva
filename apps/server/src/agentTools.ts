import fsp from 'node:fs/promises';
import path from 'node:path';
import { Alfs } from '@openalva/alfs';
import {
  ArraysViaAlvaSource,
  CATALOG_DIR,
  DataError,
  findEndpoint,
  loadCatalog,
  type DataSource,
} from '@openalva/data';
import { runFeed, type HttpFetchImpl } from '@openalva/feed-runtime';
import type { CronService, SchedulerStore } from '@openalva/scheduler';
import { PortfolioWatchSeeder } from './portfolioWatchSeed.js';
import { ReleaseService } from './releaseService.js';
import { captureScreenshot } from './screenshotService.js';
import { SkillDocs } from './skillDocs.js';

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
  /** feed 的 net/http 实现（Arrays 路由）；run 工具透传给 runFeed */
  feedHttpFetch?: HttpFetchImpl;
  /** 仓库根：skilldocs 从 skills/ 与逆向材料目录加载 SKILL.md */
  repoRoot?: string;
  /** 与 server 共享的 ReleaseService（带 baseUrl 时 release 会截图） */
  releases?: ReleaseService;
  /** 本服务对外地址；screenshot 工具依赖它把相对路径拼成完整本机 URL */
  baseUrl?: string;
}

export class AgentTools {
  private readonly alfs: Alfs;
  private readonly dataSource: DataSource;
  private readonly releases: ReleaseService;
  private readonly skillDocs: SkillDocs;
  private readonly portfolioWatchSeeder: PortfolioWatchSeeder;

  constructor(private readonly opts: AgentToolsOptions) {
    this.alfs = new Alfs(opts.root, opts.user);
    this.dataSource = opts.dataSource ?? new ArraysViaAlvaSource();
    this.releases = opts.releases ?? new ReleaseService(opts.root, opts.user);
    this.skillDocs = new SkillDocs(opts.repoRoot);
    this.portfolioWatchSeeder = new PortfolioWatchSeeder({
      root: opts.root,
      user: opts.user,
      schedulerStore: opts.schedulerStore,
      cronService: opts.cronService,
      releases: this.releases,
    });
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
      spec(
        'data.call',
        'Call a mirrored Data Skill endpoint. skill and endpoint must be EXACT names from skills.list / skills.get — never guess them. Read skills.doc for the endpoint first: it defines the required query params (wrong or extra params cause upstream 404s).',
        {
          type: 'object',
          required: ['skill', 'endpoint', 'params'],
          properties: {
            skill: { type: 'string' },
            endpoint: { type: 'string' },
            params: { type: 'object' },
          },
        },
      ),
      spec('skills.list', 'List mirrored Data Skills and endpoint counts.', {
        type: 'object',
        properties: {},
      }),
      spec(
        'skills.get',
        'Get one mirrored Data Skill summary, including its exact endpoint names.',
        {
          type: 'object',
          required: ['skill'],
          properties: { skill: { type: 'string' } },
        },
      ),
      spec(
        'skills.doc',
        'Read the mirrored parameter/response documentation for one Data Skill endpoint. ALWAYS read this before the first data.call to an endpoint — it defines required params, accepted values, and response fields.',
        {
          type: 'object',
          required: ['skill', 'endpoint'],
          properties: { skill: { type: 'string' }, endpoint: { type: 'string' } },
        },
      ),
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
      spec(
        'release.lint',
        'Run the design-contract lint on a draft playbook index.html (same gate release.playbook enforces). Fix all violations before releasing.',
        {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      ),
      spec(
        'release.playbook',
        'Publish a playbook index.html as an immutable local release snapshot. Runs the design lint first and refuses on violations (force=true overrides). Captures an Explore card screenshot when possible.',
        {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            changelog: { type: 'string' },
            force: { type: 'boolean' },
          },
        },
      ),
      spec(
        'screenshot',
        'Capture a PNG screenshot of a local page (live playbook URL or /artifacts/... URL) to visually verify rendering. Returns an image URL.',
        {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: 'Path on this server, e.g. /u/<user>/playbooks/<name>' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      ),
      spec(
        'skilldocs.list',
        'List platform methodology manuals (the alva platform skill and Portfolio-Watch-Skill). These are how-to guides for feeds/playbooks/strategies — NOT data endpoint docs (use skills.doc for those).',
        { type: 'object', properties: {} },
      ),
      spec(
        'skilldocs.read',
        'Read a methodology manual window (16k chars). Use offset to page through long files. file defaults to SKILL.md; reference files look like references/feed-sdk.md. For data endpoint parameter docs use skills.doc instead.',
        {
          type: 'object',
          required: ['skill'],
          properties: {
            skill: { type: 'string' },
            file: { type: 'string' },
            offset: { type: 'number' },
          },
        },
      ),
      spec(
        'artifact.publish',
        'Publish a one-off HTML artifact (e.g. a chart answer) and get a local URL that renders inline as an iframe card. Link /design-system/v1/design-system.css for styling.',
        {
          type: 'object',
          required: ['title', 'html'],
          properties: {
            title: { type: 'string' },
            html: { type: 'string' },
          },
        },
      ),
      spec(
        'seed.portfolioWatch',
        'Build the MVP seed Portfolio Watch playbook from Portfolio-Watch-Skill methodology: config feed, profile feed, watch feed, four-tab UI, UDF watchlist editor, cron deploys, notify sidecar, and release.',
        {
          type: 'object',
          properties: {
            playbookName: { type: 'string' },
            displayName: { type: 'string' },
            description: { type: 'string' },
            profileCron: { type: 'string' },
            watchCron: { type: 'string' },
            trigger: { type: 'boolean' },
            release: { type: 'boolean' },
            holdings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['symbol'],
                properties: {
                  symbol: { type: 'string' },
                  name: { type: 'string' },
                  sector: { type: 'string' },
                  weight: { type: 'number' },
                },
              },
            },
          },
        },
      ),
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
          ...(this.opts.feedHttpFetch ? { httpFetch: this.opts.feedHttpFetch } : {}),
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
      case 'skills.doc': {
        const skill = reqString(input, 'skill');
        // findEndpoint 顺带校验并把 path 形态归一为 file 名；错误信息会列出可用端点
        const endpoint = findEndpoint(loadCatalog(), skill, reqString(input, 'endpoint'));
        const docFile = path.join(CATALOG_DIR, 'docs', skill, `${endpoint.file}.md`);
        try {
          return { skill, endpoint: endpoint.file, doc: await fsp.readFile(docFile, 'utf8') };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // 少数端点镜像时未抓到 doc——这是「禁猜参」规则的唯一例外场景
          throw new Error(
            `No mirrored doc exists for ${skill}/${endpoint.file} (mirror gap). As an exception, call it with minimal params and read the error response.`,
            { cause: err },
          );
        }
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
      case 'release.lint':
        return this.releases.lint(reqString(input, 'name'));
      case 'release.playbook':
        return this.releases.publish({
          name: reqString(input, 'name'),
          ...(typeof input['version'] === 'string' ? { version: input['version'] } : {}),
          ...(typeof input['changelog'] === 'string' ? { changelog: input['changelog'] } : {}),
          ...(typeof input['force'] === 'boolean' ? { force: input['force'] } : {}),
        });
      case 'screenshot':
        return this.captureLocalScreenshot(input);
      case 'skilldocs.list':
        return { skills: this.skillDocs.list() };
      case 'skilldocs.read':
        return this.skillDocs.read(
          reqString(input, 'skill'),
          typeof input['file'] === 'string' ? input['file'] : undefined,
          optNumber(input, 'offset') ?? 0,
        );
      case 'artifact.publish':
        return this.publishArtifact(reqString(input, 'title'), reqString(input, 'html'));
      case 'seed.portfolioWatch':
        return this.portfolioWatchSeeder.seed({
          ...(typeof input['playbookName'] === 'string'
            ? { playbookName: input['playbookName'] }
            : {}),
          ...(typeof input['displayName'] === 'string' ? { displayName: input['displayName'] } : {}),
          ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
          ...(typeof input['profileCron'] === 'string' ? { profileCron: input['profileCron'] } : {}),
          ...(typeof input['watchCron'] === 'string' ? { watchCron: input['watchCron'] } : {}),
          ...(typeof input['trigger'] === 'boolean' ? { trigger: input['trigger'] } : {}),
          ...(typeof input['release'] === 'boolean' ? { release: input['release'] } : {}),
          ...(Array.isArray(input['holdings']) ? { holdings: input['holdings'] } : {}),
        });
      default:
        return this.executeDeploy(name, input);
    }
  }

  /** 截屏本机页面到 <root>/artifacts/<uuid>.png；仅允许 127.0.0.1/localhost */
  private async captureLocalScreenshot(input: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this.opts.baseUrl;
    if (!baseUrl) {
      throw new Error('screenshot is unavailable: server was started without a baseUrl');
    }
    const rawUrl = reqString(input, 'url');
    const target = rawUrl.startsWith('http')
      ? rawUrl
      : `${baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    const hostname = new URL(target).hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      throw new Error('screenshot only supports local URLs on this server');
    }
    const id = crypto.randomUUID();
    const dir = path.join(this.opts.root, 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    await captureScreenshot({
      url: target,
      outFile: path.join(dir, `${id}.png`),
      ...(typeof input['width'] === 'number' ? { width: input['width'] } : {}),
      ...(typeof input['height'] === 'number' ? { height: input['height'] } : {}),
    });
    return { url: `/artifacts/${id}.png` };
  }

  /** 一次性 HTML artifact：存到 <root>/artifacts/<uuid>.html，经 /artifacts/:id 提供 */
  private async publishArtifact(
    title: string,
    html: string,
  ): Promise<{ id: string; title: string; url: string }> {
    const id = crypto.randomUUID();
    const dir = path.join(this.opts.root, 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.html`), html, 'utf8');
    return { id, title, url: `/artifacts/${id}` };
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
