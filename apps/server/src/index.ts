import fs from 'node:fs/promises';
import { initOpenAlvaRoot, openAlvaPaths, resolveOpenAlvaRoot } from '@openalva/alfs';
import { buildApp } from './app.js';
import { openDatabase } from './db.js';

const PORT = Number(process.env['OPENALVA_PORT'] ?? 4700);

async function main(): Promise<void> {
  const root = resolveOpenAlvaRoot();
  const paths = openAlvaPaths(root);

  let defaultUser = 'george351419';
  try {
    const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8')) as {
      defaultUser?: string;
    };
    if (config.defaultUser) defaultUser = config.defaultUser;
  } catch {
    // 首次启动，config 由 init 创建
  }

  await initOpenAlvaRoot(defaultUser, root);
  openDatabase(paths.dbFile);

  const app = await buildApp();
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`openalva-server listening on http://127.0.0.1:${PORT} (root: ${root})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
