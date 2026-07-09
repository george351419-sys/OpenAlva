import os from 'node:os';
import path from 'node:path';

/**
 * 运行时根目录。所有持久状态（用户 home 树、secrets、元数据库）都在这下面，
 * 目录形态照搬 Alva 的 ALFS：<root>/home/<user>/{playbooks,feeds,memory}。
 * 测试与多实例通过 OPENALVA_ROOT 覆盖。
 */
export function resolveOpenAlvaRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['OPENALVA_ROOT'];
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.openalva');
}

export interface OpenAlvaPaths {
  root: string;
  homeRoot: string;
  configFile: string;
  secretsFile: string;
  dbFile: string;
}

export function openAlvaPaths(root: string = resolveOpenAlvaRoot()): OpenAlvaPaths {
  return {
    root,
    homeRoot: path.join(root, 'home'),
    configFile: path.join(root, 'config.json'),
    secretsFile: path.join(root, 'secrets.json'),
    dbFile: path.join(root, 'openalva.db'),
  };
}

export function homeDir(user: string, root: string = resolveOpenAlvaRoot()): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(user)) {
    throw new Error(`Invalid username: ${JSON.stringify(user)}`);
  }
  return path.join(root, 'home', user);
}
