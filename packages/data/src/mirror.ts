import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { CATALOG_DIR, CATALOG_FILE } from './catalog.js';
import type { Catalog, EndpointMeta, SkillMeta } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * 镜像脚本：用系统 `alva` CLI 拉取全部 Data Skill 的目录 + 端点元数据 + 端点文档，
 * 写入 packages/data/catalog/（catalog.json 索引 + docs/<skill>/<endpoint>.md）。
 * 产物入库——运行时不再依赖 alva CLI 或网络来了解「有哪些数据、怎么调」。
 * 仅目录知识来自 CLI；真实取数走 DataSource driver。
 */

const ARRAYS_BASE_URL = 'https://data-tools.prd.space.id';

async function alva(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync('alva', args, { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function unwrap<T>(res: unknown): T {
  if (res && typeof res === 'object' && 'data' in res) {
    return (res as { data: T }).data;
  }
  return res as T;
}

async function main(): Promise<void> {
  console.log('Mirroring Alva Data Skills catalog...');
  const listRes = (await alva(['data-skills', 'list', '--json'])) as { skills?: unknown } | unknown;
  const listData = unwrap<{ skills?: { name: string }[] } | { name: string }[]>(listRes);
  const skillsList = Array.isArray(listData) ? listData : (listData.skills ?? []);

  const skills: SkillMeta[] = [];
  for (const item of skillsList as { name: string }[]) {
    const name = item.name;
    process.stdout.write(`  ${name} ... `);
    const summary = unwrap<{
      description?: string;
      endpoint_metadata?: EndpointMeta[];
      metadata?: { endpoint_count?: number; pro_count?: number };
    }>(await alva(['data-skills', 'summary', name, '--json']));

    const endpoints = summary.endpoint_metadata ?? [];
    skills.push({
      name,
      description: summary.description ?? '',
      endpoint_count: summary.metadata?.endpoint_count ?? endpoints.length,
      pro_count: summary.metadata?.pro_count ?? endpoints.filter((e) => e.pro_required).length,
      endpoints,
    });

    // 逐端点抓文档（单端点失败容错——目录索引才是关键；有的 file 名如 "list"
    // 会撞 CLI 保留字，跳过并记录，不阻断整个镜像）
    let docOk = 0;
    for (const ep of endpoints) {
      try {
        const doc = unwrap<{ content?: string }>(
          await alva(['data-skills', 'endpoint', name, ep.file, '--json']),
        );
        const docDir = `${CATALOG_DIR}/docs/${name}`;
        await fs.mkdir(docDir, { recursive: true });
        await fs.writeFile(`${docDir}/${ep.file}.md`, doc.content ?? '', 'utf8');
        docOk += 1;
      } catch {
        console.warn(`\n    ! doc skipped for ${name}/${ep.file}`);
      }
    }
    console.log(`${endpoints.length} endpoints (${docOk} docs)`);
  }

  const catalog: Catalog = {
    mirrored_at: new Date().toISOString(),
    base_url: ARRAYS_BASE_URL,
    skills,
  };
  await fs.mkdir(CATALOG_DIR, { recursive: true });
  await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  const totalEndpoints = skills.reduce((n, s) => n + s.endpoints.length, 0);
  const publicEndpoints = skills.reduce(
    (n, s) => n + s.endpoints.filter((e) => !e.pro_required).length,
    0,
  );
  console.log(
    `\nMirrored ${skills.length} skills, ${totalEndpoints} endpoints (${publicEndpoints} public / ${
      totalEndpoints - publicEndpoints
    } pro-gated) → ${CATALOG_FILE}`,
  );
}

main().catch((err) => {
  console.error('Mirror failed:', err);
  process.exit(1);
});
