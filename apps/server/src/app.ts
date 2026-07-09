import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { findRepoRoot } from './repoRoot.js';

export interface BuildAppOptions {
  repoRoot?: string;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const app = Fastify({ logger: false });

  // 官方设计系统原件，URL 形态与 Alva CDN 一致（/design-system/v1/...），
  // 让官方 blueprint 里的 <link> 仅改域名即可复用。
  await app.register(fastifyStatic, {
    root: path.join(repoRoot, 'vendor', 'design-system'),
    prefix: '/design-system/v1/',
  });

  app.get('/health', async () => ({ ok: true, service: 'openalva-server' }));

  return app;
}
