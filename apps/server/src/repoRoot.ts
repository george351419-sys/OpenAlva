import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从当前文件向上找 pnpm-workspace.yaml 定位仓库根（vendor 资产的锚点）。 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found above ' + startDir);
    dir = parent;
  }
}
