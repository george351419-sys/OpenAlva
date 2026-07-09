import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initOpenAlvaRoot } from './init.js';
import { homeDir, resolveOpenAlvaRoot } from './paths.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('resolveOpenAlvaRoot', () => {
  it('defaults to ~/.openalva and honors OPENALVA_ROOT', () => {
    expect(resolveOpenAlvaRoot({})).toBe(path.join(os.homedir(), '.openalva'));
    expect(resolveOpenAlvaRoot({ OPENALVA_ROOT: tmpRoot })).toBe(tmpRoot);
  });
});

describe('homeDir', () => {
  it('builds home/<user> and rejects path-traversal usernames', () => {
    expect(homeDir('george351419', tmpRoot)).toBe(path.join(tmpRoot, 'home', 'george351419'));
    expect(() => homeDir('../evil', tmpRoot)).toThrow(/Invalid username/);
    expect(() => homeDir('', tmpRoot)).toThrow(/Invalid username/);
  });
});

describe('initOpenAlvaRoot', () => {
  it('creates home tree, config and 0600 secrets, idempotently', async () => {
    const first = await initOpenAlvaRoot('george351419', tmpRoot);
    expect(first.createdHome).toBe(true);

    for (const sub of ['playbooks', 'feeds', 'memory']) {
      const st = await fs.stat(path.join(tmpRoot, 'home', 'george351419', sub));
      expect(st.isDirectory()).toBe(true);
    }

    const config = JSON.parse(await fs.readFile(path.join(tmpRoot, 'config.json'), 'utf8'));
    expect(config.defaultUser).toBe('george351419');

    const secretsStat = await fs.stat(path.join(tmpRoot, 'secrets.json'));
    expect(secretsStat.mode & 0o777).toBe(0o600);

    // 第二次运行：不报错、不覆盖已有文件
    await fs.writeFile(path.join(tmpRoot, 'secrets.json'), '{"KEEP":"me"}\n', { mode: 0o600 });
    const second = await initOpenAlvaRoot('george351419', tmpRoot);
    expect(second.createdHome).toBe(false);
    expect(await fs.readFile(path.join(tmpRoot, 'secrets.json'), 'utf8')).toContain('KEEP');
  });
});
