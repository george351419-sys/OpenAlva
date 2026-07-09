import fs from 'node:fs/promises';
import path from 'node:path';
import { homeDir, openAlvaPaths, resolveOpenAlvaRoot } from './paths.js';

const HOME_SUBDIRS = ['playbooks', 'feeds', 'memory'] as const;

export interface InitResult {
  root: string;
  user: string;
  createdHome: boolean;
}

/**
 * 幂等初始化运行时根：home/<user>/ 三个子目录、config.json（defaultUser）、
 * secrets.json（0600 空对象）。元数据库由 server 启动时建（它是 schema 的所有者）。
 */
export async function initOpenAlvaRoot(
  user: string,
  root: string = resolveOpenAlvaRoot(),
): Promise<InitResult> {
  const paths = openAlvaPaths(root);
  const userHome = homeDir(user, root);

  let createdHome = false;
  try {
    await fs.access(userHome);
  } catch {
    createdHome = true;
  }

  for (const sub of HOME_SUBDIRS) {
    await fs.mkdir(path.join(userHome, sub), { recursive: true });
  }

  await writeIfMissing(paths.configFile, JSON.stringify({ defaultUser: user }, null, 2) + '\n');
  await writeIfMissing(paths.secretsFile, '{}\n', 0o600);

  return { root, user, createdHome };
}

async function writeIfMissing(file: string, content: string, mode?: number): Promise<void> {
  try {
    await fs.writeFile(file, content, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}
