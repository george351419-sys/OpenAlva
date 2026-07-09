import path from 'node:path';

/**
 * ALFS 虚拟路径 → 本地真实路径。
 * 支持两种写法（与 Alva 一致）：
 *   ~/feeds/x            → <root>/home/<user>/feeds/x
 *   /alva/home/u/feeds/x → <root>/home/u/feeds/x
 * 解析后强制落在 <root>/home/ 之内，防穿越。
 */
export function resolveAlfsPath(root: string, user: string, alfsPath: string): string {
  let rel: string;
  if (alfsPath.startsWith('~/')) {
    rel = path.join('home', user, alfsPath.slice(2));
  } else if (alfsPath === '~') {
    rel = path.join('home', user);
  } else if (alfsPath.startsWith('/alva/home/')) {
    rel = path.join('home', alfsPath.slice('/alva/home/'.length));
  } else {
    throw new Error(`Unsupported ALFS path (use ~/... or /alva/home/...): ${alfsPath}`);
  }
  const real = path.resolve(root, rel);
  const homeRoot = path.resolve(root, 'home') + path.sep;
  if (!real.startsWith(homeRoot)) {
    throw new Error(`ALFS path escapes home root: ${alfsPath}`);
  }
  return real;
}

/** 本地真实路径 → ALFS 绝对路径（/alva/home/...）。 */
export function toAlvaPath(root: string, realPath: string): string {
  const homeRoot = path.resolve(root, 'home');
  const real = path.resolve(realPath);
  if (!real.startsWith(homeRoot + path.sep)) {
    throw new Error(`Not under ALFS home root: ${realPath}`);
  }
  return '/alva/home/' + real.slice(homeRoot.length + 1).split(path.sep).join('/');
}

export interface VirtualQuery {
  /** 输出目录的真实路径（不含 @ 查询段） */
  baseReal: string;
  kind: 'last' | 'first' | 'range' | 'count';
  n?: number;
  from?: number;
  to?: number;
}

/**
 * 拆出虚拟查询段：.../data/<group>/<output>/@last/50 等。
 * 无 @ 段返回 null（普通文件路径）。
 */
export function parseVirtualQuery(realPath: string): VirtualQuery | null {
  const parts = realPath.split(path.sep);
  const at = parts.findIndex((p) => p.startsWith('@'));
  if (at === -1) return null;
  const baseReal = parts.slice(0, at).join(path.sep);
  const seg = parts[at]!;
  const rest = parts.slice(at + 1);

  if (seg === '@last' || seg === '@first') {
    const n = Number(rest[0] ?? 1);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${seg} count: ${rest[0]}`);
    return { baseReal, kind: seg === '@last' ? 'last' : 'first', n };
  }
  if (seg === '@count') {
    return { baseReal, kind: 'count' };
  }
  if (seg === '@range') {
    const spec = rest[0] ?? '';
    const m = /^(\d+)\.\.(\d+)$/.exec(spec);
    if (!m) throw new Error(`Invalid @range spec: ${spec}`);
    return { baseReal, kind: 'range', from: Number(m[1]), to: Number(m[2]) };
  }
  if (seg === '@kv' || seg === '@kv.json') return null; // kv 由 store 层处理，不是查询
  throw new Error(`Unknown virtual path segment: ${seg}`);
}
