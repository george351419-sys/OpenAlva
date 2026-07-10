import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from './repoRoot.js';

/**
 * 技能文档加载器（渐进披露）：agent 通过 skilldocs.list / skilldocs.read
 * 按需读取官方 alva skill（SKILL.md + references/）与 Portfolio-Watch-Skill，
 * 而不是把全部手册塞进 system prompt。
 */

export interface SkillDocEntry {
  skill: string;
  description: string;
  files: string[];
}

export interface SkillDocWindow {
  skill: string;
  file: string;
  size: number;
  offset: number;
  content: string;
  truncated: boolean;
}

const WINDOW_CHARS = 16_000;
const DOC_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.css', '.txt']);

export class SkillDocs {
  /** skill 名 → skill 目录（含 SKILL.md） */
  private readonly dirs = new Map<string, string>();

  constructor(repoRoot?: string) {
    const rr = repoRoot ?? findRepoRoot();
    const roots = [
      path.join(rr, 'skills'),
      path.join(rr, '逆向材料', 'alva-official-skill', 'skills'),
      path.join(rr, 'Portfolio-Watch-Skill'),
    ];
    for (const root of roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        if (!this.dirs.has(entry.name)) this.dirs.set(entry.name, dir);
      }
    }
  }

  list(): SkillDocEntry[] {
    return [...this.dirs.entries()].map(([skill, dir]) => ({
      skill,
      description: readDescription(path.join(dir, 'SKILL.md')),
      files: listDocFiles(dir),
    }));
  }

  read(skill: string, file = 'SKILL.md', offset = 0): SkillDocWindow {
    const dir = this.dirs.get(skill);
    if (!dir) {
      throw new Error(`Unknown skill doc: ${skill}. Use skilldocs.list to see available skills.`);
    }
    const resolved = path.resolve(dir, file);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      throw new Error(`file must stay inside the skill directory: ${file}`);
    }
    const full = fs.readFileSync(resolved, 'utf8');
    const start = Math.max(0, Math.floor(offset));
    const content = full.slice(start, start + WINDOW_CHARS);
    return {
      skill,
      file,
      size: full.length,
      offset: start,
      content,
      truncated: start + content.length < full.length,
    };
  }
}

function readDescription(skillMd: string): string {
  let text: string;
  try {
    text = fs.readFileSync(skillMd, 'utf8');
  } catch {
    return '';
  }
  // frontmatter 的 description: >- 折叠块
  const folded = /description:\s*>-?\s*\n((?:[ \t]+\S.*\n)+)/.exec(text);
  if (folded?.[1]) {
    return folded[1].replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  const inline = /description:\s*(.+)/.exec(text);
  if (inline?.[1]) return inline[1].trim().slice(0, 400);
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading?.[1]?.trim() ?? '';
}

function listDocFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return out.sort();
}
