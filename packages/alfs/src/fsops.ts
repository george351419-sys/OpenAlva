import fs from 'node:fs/promises';
import path from 'node:path';
import { parseVirtualQuery, resolveAlfsPath } from './alfspath.js';
import { isInsideSynthMount, TsOutput } from './tsstore.js';

export interface StatResult {
  exists: boolean;
  isDir: boolean;
  size: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/**
 * ALFS 门面：jagent `alfs` 模块与 CLI `fs` 动词共用的实现。
 * - 路径接受 `~/...` 与 `/alva/home/...`。
 * - 读路径支持虚拟查询段（@last/N、@range、@count），返回 JSON 字符串，
 *   分组行展平（对齐线上 REST 实证行为——crypto-top5-watch 前端按平铺记录消费）。
 * - data/ 合成挂载内禁止 writeFile（只能经 Feed SDK ts append 写入）。
 * - grant/revoke 单机版仅记账（grants.json），不做强制。
 */
export class Alfs {
  constructor(
    private readonly root: string,
    private readonly user: string,
  ) {}

  real(alfsPath: string): string {
    return resolveAlfsPath(this.root, this.user, alfsPath);
  }

  async readFile(alfsPath: string): Promise<string> {
    const real = this.real(alfsPath);
    const vq = parseVirtualQuery(real);
    if (vq) {
      const ts = new TsOutput(vq.baseReal);
      if (vq.kind === 'last') return JSON.stringify(await ts.last(vq.n));
      if (vq.kind === 'first') return JSON.stringify(await ts.first(vq.n));
      if (vq.kind === 'range') return JSON.stringify(await ts.range(vq.from!, vq.to));
      return JSON.stringify(await ts.count());
    }
    return fs.readFile(real, 'utf8');
  }

  async readFileBytes(alfsPath: string): Promise<string> {
    const buf = await fs.readFile(this.real(alfsPath));
    return buf.toString('base64');
  }

  async writeFile(alfsPath: string, content: string): Promise<void> {
    const real = this.real(alfsPath);
    if (parseVirtualQuery(real)) throw new Error('Cannot write to a virtual query path');
    if (await isInsideSynthMount(real)) {
      throw new Error(
        `Cannot writeFile inside a feed data mount (${alfsPath}); use the Feed SDK ts().append()`,
      );
    }
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.writeFile(real, content);
  }

  async stat(alfsPath: string): Promise<StatResult> {
    try {
      const st = await fs.stat(this.real(alfsPath));
      return { exists: true, isDir: st.isDirectory(), size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, isDir: false, size: 0 };
      }
      throw err;
    }
  }

  async readDir(alfsPath: string): Promise<DirEntry[]> {
    const real = this.real(alfsPath);
    const entries = await fs.readdir(real, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const e of entries) {
      if (e.name === '.synthmount') continue;
      const st = await fs.stat(path.join(real, e.name));
      out.push({ name: e.name, isDir: e.isDirectory(), size: st.size });
    }
    return out;
  }

  async mkdir(alfsPath: string): Promise<void> {
    await fs.mkdir(this.real(alfsPath), { recursive: true });
  }

  async remove(alfsPath: string): Promise<void> {
    await fs.rm(this.real(alfsPath), { force: true });
  }

  async removeAll(alfsPath: string): Promise<void> {
    await fs.rm(this.real(alfsPath), { recursive: true, force: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(this.real(oldPath), this.real(newPath));
  }

  async copy(src: string, dst: string): Promise<void> {
    await fs.cp(this.real(src), this.real(dst), { recursive: true });
  }

  // ── 权限：单机版记账不强制 ──
  private get grantsFile(): string {
    return path.join(this.root, 'grants.json');
  }

  async grantPermission(alfsPath: string, subject: string, permission: string): Promise<void> {
    const grants = await this.loadGrants();
    grants.push({ path: alfsPath, subject, permission, grantedAt: Date.now() });
    await fs.writeFile(this.grantsFile, JSON.stringify(grants, null, 2));
  }

  async revokePermission(alfsPath: string, subject: string, permission: string): Promise<void> {
    const grants = (await this.loadGrants()).filter(
      (g) => !(g.path === alfsPath && g.subject === subject && g.permission === permission),
    );
    await fs.writeFile(this.grantsFile, JSON.stringify(grants, null, 2));
  }

  async setPublicRead(alfsPath: string): Promise<void> {
    await this.grantPermission(alfsPath, 'special:user:*', 'read');
  }

  private async loadGrants(): Promise<
    { path: string; subject: string; permission: string; grantedAt: number }[]
  > {
    try {
      return JSON.parse(await fs.readFile(this.grantsFile, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
