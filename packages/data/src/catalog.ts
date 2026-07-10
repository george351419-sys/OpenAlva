import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, EndpointMeta, SkillMeta } from './types.js';
import { DataError } from './types.js';

export const CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'catalog');
export const CATALOG_FILE = path.join(CATALOG_DIR, 'catalog.json');

let cached: Catalog | null = null;

export function loadCatalog(file: string = CATALOG_FILE): Catalog {
  // 模块级缓存仅对默认 catalog 生效；无失效机制（单机长驻场景可接受，
  // 镜像更新后需重启进程重载）。测试传自定义 file 时不走缓存，避免串扰。
  if (cached && file === CATALOG_FILE) return cached;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DataError(
        'SOURCE_UNAVAILABLE',
        `Data catalog not found at ${file}. Run \`pnpm --filter @openalva/data mirror\` to generate it.`,
      );
    }
    throw err;
  }
  const catalog = JSON.parse(raw) as Catalog;
  if (file === CATALOG_FILE) cached = catalog;
  return catalog;
}

export function findEndpoint(catalog: Catalog, skill: string, endpoint: string): EndpointMeta {
  const s = catalog.skills.find((x) => x.name === skill);
  if (!s) {
    throw new DataError('ENDPOINT_UNKNOWN', `Unknown data skill: ${skill}`);
  }
  // endpoint 可用 file 名或 path 匹配
  const e = s.endpoints.find((x) => x.file === endpoint || x.path === endpoint);
  if (!e) {
    throw new DataError(
      'ENDPOINT_UNKNOWN',
      `Unknown endpoint "${endpoint}" in skill ${skill} (have: ${s.endpoints
        .map((x) => x.file)
        .join(', ')})`,
    );
  }
  return e;
}

export function skillNames(catalog: Catalog): string[] {
  return catalog.skills.map((s) => s.name);
}

export function publicEndpoints(catalog: Catalog): EndpointMeta[] {
  return catalog.skills.flatMap((s: SkillMeta) => s.endpoints.filter((e) => !e.pro_required));
}
