import fs from 'node:fs/promises';
import path from 'node:path';
import { homeDir } from '@openalva/alfs';
import { lintPlaybookHtml, type LintResult } from './playbookLint.js';
import { captureScreenshot } from './screenshotService.js';

export interface PlaybookRelease {
  version: string;
  changelog: string;
  created_at: number;
  static_url: string;
  live_url: string;
}

export interface PlaybookJson {
  schema_version: 1;
  name: string;
  display_name: string;
  description: string;
  status: 'draft' | 'released';
  feeds: string[];
  metadata: { trading_pairs: string[] };
  parents: string[];
  draft: { created_at: number; updated_at: number };
  latest_release: string | null;
  releases: PlaybookRelease[];
}

export class ReleaseService {
  constructor(
    private readonly root: string,
    private readonly user: string,
    /** 本服务的对外地址（如 http://127.0.0.1:4700）；有值才做 release 截图 */
    private readonly baseUrl?: string,
  ) {}

  /** 对 draft 的 index.html 跑设计契约 lint（release 门禁同款规则）。 */
  async lint(name: string): Promise<LintResult> {
    const clean = cleanName(name);
    const html = await fs.readFile(path.join(this.playbookDir(clean), 'index.html'), 'utf8');
    return lintPlaybookHtml(html);
  }

  async createDraft(input: {
    name: string;
    displayName?: string;
    description?: string;
    feeds?: string[];
  }): Promise<{ playbook: PlaybookJson; paths: { dir: string; index: string; readme: string; json: string } }> {
    const name = cleanName(input.name);
    const dir = this.playbookDir(name);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'udf'), { recursive: true });
    const now = Date.now();
    const jsonFile = path.join(dir, 'playbook.json');
    let playbook: PlaybookJson;
    try {
      playbook = JSON.parse(await fs.readFile(jsonFile, 'utf8')) as PlaybookJson;
      playbook.draft.updated_at = now;
      if (input.displayName) playbook.display_name = input.displayName;
      if (input.description) playbook.description = input.description;
      if (input.feeds) playbook.feeds = input.feeds;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      playbook = {
        schema_version: 1,
        name,
        display_name: input.displayName ?? titleFromName(name),
        description: input.description ?? '',
        status: 'draft',
        feeds: input.feeds ?? [],
        metadata: { trading_pairs: [] },
        parents: [],
        draft: { created_at: now, updated_at: now },
        latest_release: null,
        releases: [],
      };
    }
    await writeJson(jsonFile, playbook);
    await writeIfMissing(path.join(dir, 'README.md'), `# ${playbook.display_name}\n`);
    return {
      playbook,
      paths: {
        dir: `~/playbooks/${name}`,
        index: `~/playbooks/${name}/index.html`,
        readme: `~/playbooks/${name}/README.md`,
        json: `~/playbooks/${name}/playbook.json`,
      },
    };
  }

  async publish(input: {
    name: string;
    version?: string;
    changelog?: string;
    /** true = 明知 lint 违规仍强行发布（登记在 release.changelog 之外，慎用） */
    force?: boolean;
  }): Promise<{
    playbook: PlaybookJson;
    release: PlaybookRelease;
    snapshotDir: string;
    screenshot: string | null;
  }> {
    const name = cleanName(input.name);
    const dir = this.playbookDir(name);
    const jsonFile = path.join(dir, 'playbook.json');
    const playbook = JSON.parse(await fs.readFile(jsonFile, 'utf8')) as PlaybookJson;
    const indexFile = path.join(dir, 'index.html');
    const index = await fs.readFile(indexFile, 'utf8');
    if (!index.trim()) throw new Error(`Cannot release empty index.html for ${name}`);

    // lint 门禁：设计契约核心规则不过不发（force 可跳过）
    const lint = lintPlaybookHtml(index);
    if (!lint.pass && !input.force) {
      const detail = lint.violations.map((v) => `[${v.rule}] ${v.message}`).join('\n');
      throw new Error(
        `Design lint failed for ${name} (${lint.violations.length} violations). Fix index.html or pass force=true.\n${detail}`,
      );
    }

    const version = input.version ?? nextVersion(playbook.releases);
    if (!/^v\d+$/.test(version)) throw new Error('version must look like v1, v2, ...');
    if (playbook.releases.some((r) => r.version === version)) {
      throw new Error(`Release ${version} already exists for ${name}`);
    }

    const snapshotDir = path.join(this.root, 'pb-static', this.user, name, version);
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.copyFile(indexFile, path.join(snapshotDir, 'index.html'));
    await copyIfExists(path.join(dir, 'README.md'), path.join(snapshotDir, 'README.md'));
    const release: PlaybookRelease = {
      version,
      changelog: input.changelog ?? 'Release created by OpenAlva.',
      created_at: Date.now(),
      static_url: `/pb-static/${this.user}/${name}/${version}/index.html`,
      live_url: `/u/${this.user}/playbooks/${name}`,
    };
    playbook.status = 'released';
    playbook.latest_release = version;
    playbook.releases.push(release);
    playbook.draft.updated_at = release.created_at;
    await writeJson(jsonFile, playbook);
    await writeJson(path.join(snapshotDir, 'playbook.json'), playbook);

    // best-effort 截图：本机没有 Chrome 或页面加载失败不阻塞发布
    let screenshot: string | null = null;
    if (this.baseUrl) {
      try {
        await captureScreenshot({
          url: `${this.baseUrl}${release.live_url}`,
          outFile: path.join(snapshotDir, 'screenshot.png'),
        });
        screenshot = `/pb-static/${this.user}/${name}/${version}/screenshot.png`;
      } catch (err) {
        // best-effort：无 Chrome/加载失败不阻塞发布，但要留下诊断线索
        console.warn(
          `[release] screenshot failed for ${name}@${version}: ${String((err as Error).message ?? err)}`,
        );
        screenshot = null;
      }
    }
    return { playbook, release, snapshotDir, screenshot };
  }

  /** Explore 门户数据源：所有已发布（有 latest_release）的 playbook。 */
  async listReleased(): Promise<
    {
      name: string;
      display_name: string;
      description: string;
      latest_release: string;
      live_url: string;
      screenshot_url: string | null;
      updated_at: number;
    }[]
  > {
    const playbooksDir = path.join(homeDir(this.user, this.root), 'playbooks');
    let entries: string[];
    try {
      entries = await fs.readdir(playbooksDir);
    } catch {
      return [];
    }
    const out: Awaited<ReturnType<ReleaseService['listReleased']>> = [];
    for (const entry of entries) {
      try {
        const playbook = JSON.parse(
          await fs.readFile(path.join(playbooksDir, entry, 'playbook.json'), 'utf8'),
        ) as PlaybookJson;
        if (!playbook.latest_release) continue;
        const shotFile = path.join(
          this.root,
          'pb-static',
          this.user,
          playbook.name,
          playbook.latest_release,
          'screenshot.png',
        );
        const hasShot = await fs.access(shotFile).then(
          () => true,
          () => false,
        );
        out.push({
          name: playbook.name,
          display_name: playbook.display_name,
          description: playbook.description,
          latest_release: playbook.latest_release,
          live_url: `/u/${this.user}/playbooks/${playbook.name}`,
          screenshot_url: hasShot
            ? `/pb-static/${this.user}/${playbook.name}/${playbook.latest_release}/screenshot.png`
            : null,
          updated_at: playbook.draft.updated_at,
        });
      } catch {
        // 非 playbook 目录或损坏的 json，跳过
      }
    }
    return out.sort((a, b) => b.updated_at - a.updated_at);
  }

  async latestSnapshot(name: string): Promise<string | null> {
    const clean = cleanName(name);
    const jsonFile = path.join(this.playbookDir(clean), 'playbook.json');
    const playbook = JSON.parse(await fs.readFile(jsonFile, 'utf8')) as PlaybookJson;
    if (!playbook.latest_release) return null;
    return path.join(this.root, 'pb-static', this.user, clean, playbook.latest_release, 'index.html');
  }

  private playbookDir(name: string): string {
    return path.join(homeDir(this.user, this.root), 'playbooks', name);
  }
}

function cleanName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(clean)) {
    throw new Error('playbook name must be 2-63 chars: lowercase letters, numbers, _ or -');
  }
  return clean;
}

function titleFromName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function nextVersion(releases: PlaybookRelease[]): string {
  return `v${releases.length + 1}`;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(file, content, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

async function copyIfExists(src: string, dst: string): Promise<void> {
  try {
    await fs.copyFile(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
