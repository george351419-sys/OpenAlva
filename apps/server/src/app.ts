import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { openAlvaPaths, resolveOpenAlvaRoot } from '@openalva/alfs';
import { createArraysRoutingFetch, type DataSource } from '@openalva/data';
import { defaultHttpFetch, type HttpFetchImpl } from '@openalva/feed-runtime';
import { CronService, SchedulerStore } from '@openalva/scheduler';
import { AgentRunner } from './agentRunner.js';
import { AgentTools } from './agentTools.js';
import { ChatStore } from './chatStore.js';
import { findRepoRoot } from './repoRoot.js';
import { ReleaseService } from './releaseService.js';
import { ViewsStore } from './viewsStore.js';

export interface BuildAppOptions {
  repoRoot?: string;
  root?: string;
  user?: string;
  dataSource?: DataSource;
  anthropicApiKey?: string;
  anthropicModel?: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
  fetchImpl?: typeof fetch;
  /** feed 的 net/http 实现；缺省为 Arrays 路由 fetch（非 Arrays 请求走本地 fetch） */
  feedHttpFetch?: HttpFetchImpl;
  /** 本服务对外地址（如 http://127.0.0.1:4700）；有值 release 才做截图 */
  baseUrl?: string;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const root = opts.root ?? resolveOpenAlvaRoot();
  const user = opts.user ?? 'george351419';
  const app = Fastify({ logger: false });
  const chatStore = new ChatStore(openAlvaPaths(root).dbFile);
  // feed 的 http 面默认走 Arrays 路由：命中 Arrays 主机的请求经 alva 云沙箱
  // 执行（JWT 在那边），其余请求本地直连——cron 定时、agent run 工具一致。
  const feedHttpFetch =
    opts.feedHttpFetch ?? createArraysRoutingFetch({ fallback: defaultHttpFetch });
  // 调度器归 buildApp 所有：deploy.trigger 与 cron 执行共享同一 CronService，
  // 同任务并发保护（running set）才真正生效。
  const schedulerStore = new SchedulerStore(openAlvaPaths(root).dbFile);
  const cronService = new CronService(schedulerStore, root, { httpFetch: feedHttpFetch });
  cronService.start();
  const releases = new ReleaseService(root, user, opts.baseUrl);
  const views = new ViewsStore(openAlvaPaths(root).dbFile);
  const tools = new AgentTools({
    root,
    user,
    dataSource: opts.dataSource,
    schedulerStore,
    cronService,
    feedHttpFetch,
    repoRoot,
    releases,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
  const agent = new AgentRunner({
    tools,
    anthropicApiKey: opts.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'],
    anthropicModel: opts.anthropicModel ?? process.env['OPENALVA_CLAUDE_MODEL'],
    deepseekApiKey: opts.deepseekApiKey ?? process.env['DEEPSEEK_API_KEY'],
    deepseekModel: opts.deepseekModel ?? process.env['OPENALVA_DEEPSEEK_MODEL'],
    fetchImpl: opts.fetchImpl,
  });

  // 官方设计系统原件，URL 形态与 Alva CDN 一致（/design-system/v1/...），
  // 让官方 blueprint 里的 <link> 仅改域名即可复用。
  await app.register(fastifyStatic, {
    root: path.join(repoRoot, 'vendor', 'design-system'),
    prefix: '/design-system/v1/',
  });

  const pbStaticRoot = path.join(root, 'pb-static');
  await fsp.mkdir(pbStaticRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: pbStaticRoot,
    prefix: '/pb-static/',
    decorateReply: false,
  });

  app.get('/health', async () => ({ ok: true, service: 'openalva-server' }));
  app.get('/openalva/v1/client.js', async (_req, reply) =>
    reply.type('application/javascript').send(browserSdk()),
  );
  app.get('/api/tools', async () => ({ tools: tools.specs() }));
  app.get('/api/models', async () => ({ models: agent.models() }));
  app.get('/api/explore', async () => {
    const playbooks = await releases.listReleased();
    return {
      playbooks: playbooks.map((pb) => ({ ...pb, views: views.get(user, pb.name) })),
    };
  });

  app.get('/artifacts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}(\.png)?$/.test(id)) return reply.code(404).send({ error: 'not found' });
    try {
      if (id.endsWith('.png')) {
        const png = await fsp.readFile(path.join(root, 'artifacts', id));
        return reply.type('image/png').send(png);
      }
      const html = await fsp.readFile(path.join(root, 'artifacts', `${id}.html`), 'utf8');
      // 模型生成的 HTML 一律降权：即便被直接导航打开也处于 opaque origin，
      // 脚本无法打到无鉴权的 /api/tools/*
      return reply
        .type('text/html')
        .header('content-security-policy', 'sandbox allow-scripts')
        .send(html);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  app.post('/api/tools/:name', async (req) => {
    const name = (req.params as { name: string }).name;
    return tools.execute(name, req.body);
  });

  app.get('/api/chat/sessions', async () => ({ sessions: chatStore.listSessions(user) }));

  app.post('/api/chat/sessions', async (req) => {
    const body = objectBody(req.body);
    return { session: chatStore.createSession({ user, title: str(body['title']) }) };
  });

  app.get('/api/chat/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const session = chatStore.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return { session, messages: chatStore.messages(id) };
  });

  app.post('/api/chat/sessions/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const session = chatStore.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const body = objectBody(req.body);
    const message = str(body['message'])?.trim();
    const model = str(body['model']);
    if (!message) return reply.code(400).send({ error: 'message is required' });

    chatStore.addMessage({ sessionId: id, role: 'user', content: message });
    reply.hijack();
    // 客户端断连时 raw socket 会 emit 'error'，无监听会抛顶层
    reply.raw.on('error', () => undefined);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    const emit = (event: string, data: unknown): void => {
      // 客户端可能中途断连；对已关闭的 socket 不再写
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    emit('session', { id });
    try {
      const response = await agent.run({
        messages: chatStore.messages(id),
        latestMessage: message,
        ...(model ? { model } : {}),
        emit: (event, data) => {
          if (event === 'tool_result') {
            // 工具执行历史落库：刷新后 UI 可恢复工具卡，后续轮次模型可见
            const d = data as {
              id?: string;
              name?: string;
              input?: unknown;
              envelope?: unknown;
            };
            chatStore.addMessage({
              sessionId: id,
              role: 'tool',
              content: JSON.stringify({ input: d.input, envelope: d.envelope }),
              ...(typeof d.name === 'string' ? { toolName: d.name } : {}),
              ...(typeof d.id === 'string' ? { toolCallId: d.id } : {}),
            });
          }
          emit(event, data);
        },
      });
      const assistantMessage = chatStore.addMessage({
        sessionId: id,
        role: 'assistant',
        content: response.content,
        metadata: response.metadata,
      });
      emit('message', assistantMessage);
      emit('done', { ok: true });
    } catch (err) {
      // headers 已写出，只能经 SSE 报错；错误也落库，历史保持完整
      const messageText = err instanceof Error ? err.message : String(err);
      const assistantMessage = chatStore.addMessage({
        sessionId: id,
        role: 'assistant',
        content: `本轮处理失败：${messageText}`,
        metadata: { error: messageText },
      });
      emit('error', { message: messageText });
      emit('message', assistantMessage);
      emit('done', { ok: false });
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.get('/u/:user/playbooks/:name', async (req, reply) => {
    const params = req.params as { user: string; name: string };
    if (params.user !== user) return reply.code(404).send({ error: 'not found' });
    let snapshot: string | null = null;
    try {
      snapshot = await releases.latestSnapshot(params.name);
    } catch (err) {
      const notFound =
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err instanceof Error && err.message.includes('playbook name must be'));
      if (!notFound) throw err;
    }
    if (!snapshot) return reply.code(404).send({ error: 'playbook has no release' });
    const html = await fsp.readFile(snapshot, 'utf8');
    if (!req.headers['x-openalva-screenshot']) {
      views.increment(user, params.name.trim().toLowerCase());
    }
    return reply.type('text/html').send(html);
  });

  app.addHook('onClose', async () => {
    cronService.stop();
    schedulerStore.close();
    views.close();
    chatStore.close();
  });

  const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      decorateReply: false,
    });
    app.get('/', async (_req, reply) => {
      const html = await fsp.readFile(path.join(webDist, 'index.html'), 'utf8');
      return reply.type('text/html').send(html);
    });
  }

  return app;
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function browserSdk(): string {
  return `
(function () {
  class OpenAlvaClient {
    fs = {
      read: async ({ path }) => {
        const resp = await fetch("/api/tools/fs.read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path })
        });
        const envelope = await resp.json();
        if (!envelope.success) throw new Error(envelope.error && envelope.error.message || "OpenAlva fs.read failed");
        return envelope.data.content;
      }
    };
  }
  window.OpenAlva = { Client: OpenAlvaClient };
})();
`.trimStart();
}
