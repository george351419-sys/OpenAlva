import fs from 'node:fs/promises';
import { initOpenAlvaRoot, openAlvaPaths, resolveOpenAlvaRoot } from '@openalva/alfs';
import { buildApp } from './app.js';
import { openDatabase } from './db.js';

const PORT = Number(process.env['OPENALVA_PORT'] ?? 4700);

async function main(): Promise<void> {
  const root = resolveOpenAlvaRoot();
  const paths = openAlvaPaths(root);

  let defaultUser = 'george351419';
  // 模型 API key 支持两种填法：环境变量（优先）或 ~/.openalva/config.json。
  // config 示例：{"defaultUser":"...","anthropicApiKey":"sk-ant-...","deepseekApiKey":"sk-..."}
  let config: {
    defaultUser?: string;
    anthropicApiKey?: string;
    anthropicModel?: string;
    deepseekApiKey?: string;
    deepseekModel?: string;
  } = {};
  try {
    config = JSON.parse(await fs.readFile(paths.configFile, 'utf8')) as typeof config;
    if (config.defaultUser) defaultUser = config.defaultUser;
  } catch {
    // 首次启动，config 由 init 创建
  }

  await initOpenAlvaRoot(defaultUser, root);
  openDatabase(paths.dbFile);

  // 调度服务由 buildApp 内建并与 deploy.trigger 共享。
  const app = await buildApp({
    user: defaultUser,
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? config.anthropicApiKey,
    anthropicModel: process.env['OPENALVA_CLAUDE_MODEL'] ?? config.anthropicModel,
    deepseekApiKey: process.env['DEEPSEEK_API_KEY'] ?? config.deepseekApiKey,
    deepseekModel: process.env['OPENALVA_DEEPSEEK_MODEL'] ?? config.deepseekModel,
    baseUrl: `http://127.0.0.1:${PORT}`,
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`openalva-server listening on http://127.0.0.1:${PORT} (root: ${root})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
