import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDatabase, SCHEMA_VERSION } from './db.js';

describe('server app', () => {
  it('serves /health', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'openalva-server' });
    await app.close();
  });

  it('serves the vendored official design-system bundle at the Alva-compatible URL', async () => {
    const app = await buildApp();
    for (const file of ['design-system.css', 'design-tokens.css']) {
      const res = await app.inject({ method: 'GET', url: `/design-system/v1/${file}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('--main-m1'); // 品牌 token 必须来自官方原件
    }
    await app.close();
  });
});

describe('metadata db', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-db-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates meta table with schema_version, idempotently', () => {
    const file = path.join(tmpDir, 'openalva.db');
    const db1 = openDatabase(file);
    db1.close();
    const db2 = openDatabase(file);
    const row = db2.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe(String(SCHEMA_VERSION));
    db2.close();
  });
});
