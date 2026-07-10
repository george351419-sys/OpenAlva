import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { openAlvaPaths, resolveOpenAlvaRoot } from '@openalva/alfs';
import type { DataSource } from '@openalva/data';
import { AgentRunner } from './agentRunner.js';
import { AgentTools } from './agentTools.js';
import { ChatStore } from './chatStore.js';
import { findRepoRoot } from './repoRoot.js';
import { ReleaseService } from './releaseService.js';

export interface BuildAppOptions {
  repoRoot?: string;
  root?: string;
  user?: string;
  dataSource?: DataSource;
  anthropicApiKey?: string;
  anthropicModel?: string;
  fetchImpl?: typeof fetch;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const root = opts.root ?? resolveOpenAlvaRoot();
  const user = opts.user ?? 'george351419';
  const app = Fastify({ logger: false });
  const chatStore = new ChatStore(openAlvaPaths(root).dbFile);
  const tools = new AgentTools({ root, user, dataSource: opts.dataSource });
  const releases = new ReleaseService(root, user);
  const agent = new AgentRunner({
    tools,
    apiKey: opts.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'],
    model: opts.anthropicModel ?? process.env['OPENALVA_CLAUDE_MODEL'],
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
    if (!message) return reply.code(400).send({ error: 'message is required' });

    chatStore.addMessage({ sessionId: id, role: 'user', content: message });
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    const emit = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    emit('session', { id });
    const response = await agent.run({
      messages: chatStore.messages(id),
      latestMessage: message,
      emit: (event, data) => emit(event, data),
    });
    const assistantMessage = chatStore.addMessage({
      sessionId: id,
      role: 'assistant',
      content: response.content,
      metadata: response.metadata,
    });
    emit('message', assistantMessage);
    emit('done', { ok: true });
    reply.raw.end();
  });

  app.get('/u/:user/playbooks/:name', async (req, reply) => {
    const params = req.params as { user: string; name: string };
    if (params.user !== user) return reply.code(404).send({ error: 'not found' });
    const snapshot = await releases.latestSnapshot(params.name);
    if (!snapshot) return reply.code(404).send({ error: 'playbook has no release' });
    const html = await fsp.readFile(snapshot, 'utf8');
    return reply.type('text/html').send(html);
  });

  app.addHook('onClose', async () => {
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
