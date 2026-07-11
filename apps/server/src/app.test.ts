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
    const stored = messages.json<{
      messages: { role: string; tool_name: string | null; content: string }[];
    }>().messages;
    // 工具执行历史落库为 role=tool，刷新后 UI/模型都能看到
    expect(stored.map((m) => m.role)).toEqual(['user', 'tool', 'assistant']);
    expect(stored[1]!.tool_name).toBe('data.call');
    expect(JSON.parse(stored[1]!.content)).toMatchObject({
      envelope: { success: true },
    });

    await app.close();
  });

  it('runs a streaming Claude tool-use loop when an API key is configured', async () => {
    const source = new StubDataSource([{ time_close: 2, price_close: 110 }]);
    const fetchCalls: { stream?: boolean }[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      fetchCalls.push(JSON.parse(String(init?.body)) as { stream?: boolean });
      if (fetchCalls.length === 1) {
        return sseMessageResponse(
          [
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
          'tool_use',
        );
      }
      return sseMessageResponse([{ type: 'text', text: 'BTC 最新价约 110。' }], 'end_turn');
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
    expect(fetchCalls[0]!.stream).toBe(true); // 真流式：请求必须带 stream:true
    expect(source.calls).toHaveLength(1);

    await app.close();
  });

  it('invokes playbook UDFs through /api/udf/call with owner permissions', async () => {
    const app = await buildApp({ root: tmpDir, user: 'george' });
    await app.inject({
      method: 'POST',
      url: '/api/tools/release.playbookDraft',
      payload: { name: 'udf-demo' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tools/fs.write',
      payload: {
        path: '~/playbooks/udf-demo/udf/save.js',
        content: `
          const alfs = require("alfs");
          const env = require("env");
          (async () => {
            await alfs.writeFile(
              "/alva/home/" + env.username + "/memory/udf-args.json",
              JSON.stringify(env.args),
            );
          })();
        `,
      },
    });

    const call = await app.inject({
      method: 'POST',
      url: '/api/udf/call',
      payload: { playbook: 'udf-demo', udf: 'save', args: { action: 'add', symbol: 'NVDA' } },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json()).toMatchObject({ status: 'completed' });

    const saved = await app.inject({
      method: 'POST',
      url: '/api/tools/fs.read',
      payload: { path: '~/memory/udf-args.json' },
    });
    expect(JSON.parse(saved.json<{ data: { content: string } }>().data.content)).toEqual({
      action: 'add',
      symbol: 'NVDA',
    });

    // 名称校验：路径注入面直接 400
    const bad = await app.inject({
      method: 'POST',
      url: '/api/udf/call',
      payload: { playbook: '../escape', udf: 'save', args: {} },
    });
    expect(bad.statusCode).toBe(400);

    // 浏览器 SDK 暴露 window.openalva.udf.call
    const sdk = await app.inject({ method: 'GET', url: '/openalva/v1/client.js' });
    expect(sdk.body).toContain('openalva.udf');

    await app.close();
  }, 30_000);

  it('lists available models based on configured keys', async () => {
    const both = await buildApp({
      root: tmpDir,
      user: 'george',
      anthropicApiKey: 'a-key',
      deepseekApiKey: 'd-key',
    });
    const res = await both.inject({ method: 'GET', url: '/api/models' });
    expect(res.json()).toEqual({
      models: [
        { id: 'claude-fable-5', provider: 'anthropic', default: true },
        { id: 'deepseek-chat', provider: 'deepseek', default: false },
      ],
    });
    await both.close();

    const none = await buildApp({ root: tmpDir, user: 'george' });
    const fallback = await none.inject({ method: 'GET', url: '/api/models' });
    expect(fallback.json()).toEqual({
      models: [{ id: 'local-fallback', provider: 'local', default: true }],
    });
    await none.close();
  });

  it('runs a streaming DeepSeek tool-use loop when selected via the model field', async () => {
    const source = new StubDataSource([{ time_close: 2, price_close: 110 }]);
    const urls: string[] = [];
    const bodies: { model?: string; stream?: boolean }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)) as { model?: string; stream?: boolean });
      if (bodies.length === 1) {
        return deepseekSseResponse(
          [
            { content: '我先取数据。' },
            {
              toolCall: {
                id: 'call_1',
                name: 'data__call',
                args: {
                  skill: 'arrays-data-api-spot-market-price-and-volume',
                  endpoint: 'binance-spot-usdt-kline',
                  params: { symbol: 'BTC', interval: '1d', limit: 3 },
                },
              },
            },
          ],
          'tool_calls',
        );
      }
      return deepseekSseResponse([{ content: 'BTC 最新价约 110。' }], 'stop');
    };
    const app = await buildApp({
      root: tmpDir,
      user: 'george',
      dataSource: source,
      anthropicApiKey: 'a-key',
      deepseekApiKey: 'd-key',
      fetchImpl: fakeFetch,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      payload: { title: 'DeepSeek' },
    });
    const sessionId = created.json<{ session: { id: string } }>().session.id;
    const stream = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/stream`,
      payload: { message: 'BTC 最新情况？', model: 'deepseek-chat' },
    });

    expect(stream.statusCode).toBe(200);
    expect(urls[0]).toContain('api.deepseek.com/chat/completions');
    expect(bodies[0]!.model).toBe('deepseek-chat');
    expect(bodies[0]!.stream).toBe(true);
    expect(stream.body).toContain('event: text_delta');
    expect(stream.body).toContain('"name":"data.call"');
    expect(stream.body).toContain('BTC 最新价约 110。');
    expect(bodies).toHaveLength(2);
    expect(source.calls).toHaveLength(1);

    await app.close();
  });

  it('serves skill docs and publishes inline artifacts', async () => {
    const app = await buildApp({ root: tmpDir, user: 'george' });

    const list = await app.inject({ method: 'POST', url: '/api/tools/skilldocs.list', payload: {} });
    const skills = list.json<{ data: { skills: { skill: string }[] } }>().data.skills;
    expect(skills.map((s) => s.skill)).toEqual(
      expect.arrayContaining(['alva', 'portfolio-watch']),
    );

    const read = await app.inject({
      method: 'POST',
      url: '/api/tools/skilldocs.read',
      payload: { skill: 'alva' },
    });
    const doc = read.json<{ data: { content: string; size: number; truncated: boolean } }>().data;
    expect(doc.content).toContain('Alva');
    expect(doc.size).toBeGreaterThan(0);

    // 数据端点参数文档：data.call 前必读，防猜参 404
    const endpointDoc = await app.inject({
      method: 'POST',
      url: '/api/tools/skills.doc',
      payload: { skill: 'arrays-data-api-stock-screener', endpoint: 'basic-info-screener' },
    });
    const docData = endpointDoc.json<{ data: { doc: string; endpoint: string } }>().data;
    expect(docData.endpoint).toBe('basic-info-screener');
    expect(docData.doc).toContain('screener');

    const escape = await app.inject({
      method: 'POST',
      url: '/api/tools/skilldocs.read',
      payload: { skill: 'alva', file: '../../../etc/hosts' },
    });
    expect(escape.json()).toMatchObject({ success: false });

    const published = await app.inject({
      method: 'POST',
      url: '/api/tools/artifact.publish',
      payload: { title: 'BTC chart', html: '<html><body>chart!</body></html>' },
    });
    const artifact = published.json<{ data: { url: string; title: string } }>().data;
    expect(artifact.title).toBe('BTC chart');
    const page = await app.inject({ method: 'GET', url: artifact.url });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('chart!');
    // 模型生成的 HTML 必须降权：opaque origin，脚本打不到 /api/tools/*
    expect(page.headers['content-security-policy']).toBe('sandbox allow-scripts');

    await app.close();
  });

  it('reports Claude API failures over SSE instead of hanging the stream', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'boom from api' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const app = await buildApp({
      root: tmpDir,
      user: 'george',
      anthropicApiKey: 'test-key',
      anthropicModel: 'claude-test',
      fetchImpl: fakeFetch,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      payload: { title: 'Error path' },
    });
    const sessionId = created.json<{ session: { id: string } }>().session.id;
    const stream = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/stream`,
      payload: { message: '随便聊聊' },
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('event: error');
    expect(stream.body).toContain('boom from api');
    expect(stream.body).toContain('"ok":false');

    const messages = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
    });
    const roles = messages.json<{ messages: { role: string; content: string }[] }>().messages;
    expect(roles.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(roles[1]!.content).toContain('本轮处理失败');

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

    // 先写一个违反设计契约的 index.html：release 必须被 lint 门禁拦下
    await app.inject({
      method: 'POST',
      url: '/api/tools/fs.write',
      payload: {
        path: '~/playbooks/btc-watch/index.html',
        content:
          '<!doctype html><html><body style="font-weight:700"><main>BTC Watch</main><a href="https://x.test">out</a></body></html>',
      },
    });
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/tools/release.playbook',
      payload: { name: 'btc-watch' },
    });
    expect(blocked.json()).toMatchObject({ success: false });
    expect(blocked.json<{ error: { message: string } }>().error.message).toContain(
      'Design lint failed',
    );

    const lintReport = await app.inject({
      method: 'POST',
      url: '/api/tools/release.lint',
      payload: { name: 'btc-watch' },
    });
    const lintData = lintReport.json<{
      data: { pass: boolean; violations: { rule: string }[] };
    }>().data;
    expect(lintData.pass).toBe(false);
    expect(lintData.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(['required-container', 'required-stylesheets', 'links', 'typography']),
    );

    // 改成契约合规的 index.html 后可以发布
    await app.inject({
      method: 'POST',
      url: '/api/tools/fs.write',
      payload: {
        path: '~/playbooks/btc-watch/index.html',
        content: compliantPlaybookHtml('BTC Watch'),
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

    // force=true 可跳过 lint 门禁（写回违规页再强发一版验证）
    await app.inject({
      method: 'POST',
      url: '/api/tools/fs.write',
      payload: {
        path: '~/playbooks/btc-watch/index.html',
        content: '<!doctype html><html><body><main>bad</main></body></html>',
      },
    });
    const forced = await app.inject({
      method: 'POST',
      url: '/api/tools/release.playbook',
      payload: { name: 'btc-watch', force: true },
    });
    expect(forced.json()).toMatchObject({ success: true, data: { release: { version: 'v2' } } });

    // 再开一次 live 页 → 浏览数累计到 Explore；截图请求（带标记头）与
    // 详情页 iframe 预览（?preview=1）都不计数
    await app.inject({ method: 'GET', url: '/u/george/playbooks/btc-watch' });
    await app.inject({
      method: 'GET',
      url: '/u/george/playbooks/btc-watch',
      headers: { 'x-openalva-screenshot': '1' },
    });
    await app.inject({ method: 'GET', url: '/u/george/playbooks/btc-watch?preview=1' });
    // 非法 playbook 名 → 404 而非 500
    const badName = await app.inject({ method: 'GET', url: '/u/george/playbooks/UP PER' });
    expect(badName.statusCode).toBe(404);
    const explore = await app.inject({ method: 'GET', url: '/api/explore' });
    expect(explore.statusCode).toBe(200);
    expect(explore.json()).toMatchObject({
      playbooks: [
        {
          name: 'btc-watch',
          display_name: 'BTC Watch',
          latest_release: 'v2', // force 发布的第二版
          live_url: '/u/george/playbooks/btc-watch',
          screenshot_url: null, // 测试环境无 baseUrl，不截图
          views: 2, // 两次真实浏览；带截图头的那次不计数
        },
      ],
    });

    // Explore 详情
    const detail = await app.inject({ method: 'GET', url: '/api/explore/btc-watch' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      name: 'btc-watch',
      latest_release: 'v2',
      views: 2,
      releases: [{ version: 'v2' }, { version: 'v1' }],
    });
    const missing = await app.inject({ method: 'GET', url: '/api/explore/nope' });
    expect(missing.statusCode).toBe(404);

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

/** 满足 design-contract 核心规则的最小 playbook HTML。 */
function compliantPlaybookHtml(title: string): string {
  return [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/design-system/v1/design-system.css">',
    '<style>html{-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;text-rendering: optimizeLegibility;}</style>',
    '</head><body>',
    `<div class="playbook-container">${title}</div>`,
    '</body></html>',
  ].join('');
}

type FakeBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

type DeepseekFakePart =
  | { content: string; toolCall?: never }
  | { toolCall: { id: string; name: string; args: Record<string, unknown> }; content?: never };

/** 构造 DeepSeek（OpenAI 兼容）chat/completions 流式假响应。 */
function deepseekSseResponse(parts: DeepseekFakePart[], finishReason: string): Response {
  const chunks: unknown[] = [];
  for (const part of parts) {
    if (part.content !== undefined) {
      chunks.push({ choices: [{ delta: { content: part.content } }] });
    } else {
      // 模拟 OpenAI 协议：首块带 id/name，参数按增量分片
      const args = JSON.stringify(part.toolCall.args);
      chunks.push({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: part.toolCall.id,
                  function: { name: part.toolCall.name, arguments: '' },
                },
              ],
            },
          },
        ],
      });
      const mid = Math.floor(args.length / 2);
      for (const slice of [args.slice(0, mid), args.slice(mid)]) {
        chunks.push({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: slice } }] } }],
        });
      }
    }
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: finishReason }] });
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

/** 构造 Anthropic Messages API 流式（SSE）假响应，形状同真实 stream:true 返回。 */
function sseMessageResponse(blocks: FakeBlock[], stopReason: string): Response {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      });
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      });
    } else {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}
