import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initOpenAlvaRoot } from '@openalva/alfs';
import type { DataCallInput, ArraysEnvelope, DataSource } from '@openalva/data';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDatabase, SCHEMA_VERSION } from './db.js';

describe('server app', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-server-'));
    await initOpenAlvaRoot('george', tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serves /health', async () => {
    const app = await buildApp({ root: tmpDir, user: 'george' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'openalva-server' });
    await app.close();
  });

  it('serves the vendored official design-system bundle at the Alva-compatible URL', async () => {
    const app = await buildApp({ root: tmpDir, user: 'george' });
    for (const file of ['design-system.css', 'design-tokens.css']) {
      const res = await app.inject({ method: 'GET', url: `/design-system/v1/${file}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('--main-m1'); // 品牌 token 必须来自官方原件
    }
    await app.close();
  });

  it('exposes Phase 3 tool specs and executes ALFS tools through JSON envelopes', async () => {
    const app = await buildApp({ root: tmpDir, user: 'george' });

    const specs = await app.inject({ method: 'GET', url: '/api/tools' });
    expect(specs.statusCode).toBe(200);
    expect(specs.json<{ tools: { name: string }[] }>().tools.map((t) => t.name)).toContain(
      'data.call',
    );

    const write = await app.inject({
      method: 'POST',
      url: '/api/tools/fs.write',
      payload: { path: '~/memory/hello.txt', content: 'hello alva' },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({ success: true });

    const read = await app.inject({
      method: 'POST',
      url: '/api/tools/fs.read',
      payload: { path: '~/memory/hello.txt' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ success: true, data: { content: 'hello alva' } });

    await app.close();
  });

  it('stores chat messages and streams a data-backed BTC answer', async () => {
    const source = new StubDataSource([
      { time_close: 1, price_close: 100 },
      { time_close: 2, price_close: 110 },
    ]);
    const app = await buildApp({ root: tmpDir, user: 'george', dataSource: source });

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      payload: { title: 'Market check' },
    });
    const sessionId = created.json<{ session: { id: string } }>().session.id;

    const stream = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/stream`,
      payload: { message: 'BTC 最近 7 天表现如何？' },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: tool_start');
    expect(stream.body).toContain('event: tool_result');
    expect(stream.body).toContain('变化为 +10.00%');
    expect(source.calls[0]).toMatchObject({
      skill: 'arrays-data-api-spot-market-price-and-volume',
      endpoint: 'binance-spot-usdt-kline',
    });

    const messages = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
    });
    expect(messages.json<{ messages: { role: string }[] }>().messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);

    await app.close();
  });

  it('runs a Claude-style tool-use loop when an API key is configured', async () => {
    const source = new StubDataSource([{ time_close: 2, price_close: 110 }]);
    const fetchCalls: unknown[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      fetchCalls.push(JSON.parse(String(init?.body)));
      if (fetchCalls.length === 1) {
        return jsonResponse({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: '我先取实时数据。' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'data__call',
              input: {
                skill: 'arrays-data-api-spot-market-price-and-volume',
                endpoint: 'binance-spot-usdt-kline',
                params: { symbol: 'BTC', interval: '1d', limit: 3 },
              },
            },
          ],
        });
      }
      return jsonResponse({
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'BTC 最新价约 110。' }],
      });
    };
    const app = await buildApp({
      root: tmpDir,
      user: 'george',
      dataSource: source,
      anthropicApiKey: 'test-key',
      anthropicModel: 'claude-test',
      fetchImpl: fakeFetch,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      payload: { title: 'Claude tool use' },
    });
    const sessionId = created.json<{ session: { id: string } }>().session.id;
    const stream = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/stream`,
      payload: { message: 'BTC 最新情况？' },
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('event: text_delta');
    expect(stream.body).toContain('event: tool_start');
    expect(stream.body).toContain('"name":"data.call"');
    expect(stream.body).toContain('BTC 最新价约 110。');
    expect(fetchCalls).toHaveLength(2);
    expect(source.calls).toHaveLength(1);

    await app.close();
  });

  it('publishes a playbook snapshot and serves live/static URLs plus browser SDK', async () => {
    const app = await buildApp({ root: tmpDir, user: 'george' });

    const draft = await app.inject({
      method: 'POST',
      url: '/api/tools/release.playbookDraft',
      payload: { name: 'btc-watch', displayName: 'BTC Watch' },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      success: true,
      data: { playbook: { name: 'btc-watch', status: 'draft' } },
    });

    await app.inject({
      method: 'POST',
      url: '/api/tools/fs.write',
      payload: {
        path: '~/playbooks/btc-watch/index.html',
        content: '<!doctype html><html><body><main>BTC Watch</main></body></html>',
      },
    });

    const published = await app.inject({
      method: 'POST',
      url: '/api/tools/release.playbook',
      payload: { name: 'btc-watch', changelog: 'Initial release' },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      success: true,
      data: {
        release: {
          version: 'v1',
          live_url: '/u/george/playbooks/btc-watch',
          static_url: '/pb-static/george/btc-watch/v1/index.html',
        },
      },
    });

    const live = await app.inject({ method: 'GET', url: '/u/george/playbooks/btc-watch' });
    expect(live.statusCode).toBe(200);
    expect(live.body).toContain('BTC Watch');

    const snapshot = await app.inject({
      method: 'GET',
      url: '/pb-static/george/btc-watch/v1/index.html',
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.body).toContain('BTC Watch');

    const sdk = await app.inject({ method: 'GET', url: '/openalva/v1/client.js' });
    expect(sdk.statusCode).toBe(200);
    expect(sdk.body).toContain('window.OpenAlva');

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

class StubDataSource implements DataSource {
  readonly name = 'stub';
  readonly calls: DataCallInput[] = [];

  constructor(private readonly rows: Record<string, unknown>[]) {}

  async call(input: DataCallInput): Promise<ArraysEnvelope> {
    this.calls.push(input);
    return { success: true, data: this.rows };
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
