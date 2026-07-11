import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpFetchImpl, HttpResponse } from './sandbox.js';
import { runFeed } from './runFeed.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openalva-alpi-'));
  await fs.mkdir(path.join(root, 'home', 'alice'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ deepseekApiKey: 'test-ds-key' }),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function jsonResponse(body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return {
    status: 200,
    ok: true,
    headers: {},
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

describe('alpi（@alva/pi）沙箱模块', () => {
  it('Agent.ask 单结果：走配置的 deepseek key，返回文本', async () => {
    const bodies: { model?: string; messages?: { role: string }[] }[] = [];
    const httpFetch: HttpFetchImpl = async (url, init) => {
      expect(url).toContain('api.deepseek.com');
      expect(init?.headers?.['authorization']).toBe('Bearer test-ds-key');
      bodies.push(JSON.parse(init?.body ?? '{}') as (typeof bodies)[number]);
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: '一句话叙事OK' } }],
      });
    };
    const env = await runFeed({
      root,
      user: 'alice',
      code: `
        const { Agent, getModel } = require("@alva/pi");
        (async () => {
          const agent = new Agent({ initialState: {
            systemPrompt: "One concise line.",
            model: getModel("openai", "gpt-5.5"),
          }});
          const { text } = await agent.ask("summarize the day");
          console.log("narrative:", text);
        })();
      `,
      httpFetch,
    });
    expect(env.status).toBe('completed');
    expect(env.logs).toContain('narrative: 一句话叙事OK');
    // openai 请求被映射到本地配置的 deepseek 模型
    expect(bodies[0]!.model).toBe('deepseek-chat');
    expect(bodies[0]!.messages?.[0]).toMatchObject({ role: 'system' });
  }, 30_000);

  it('tools 循环：模型请求工具 → execute 执行 → 最终回答', async () => {
    let calls = 0;
    const httpFetch: HttpFetchImpl = async (_url, _init) => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'add', arguments: '{"a":1,"b":2}' },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'sum is 3' } }],
      });
    };
    const env = await runFeed({
      root,
      user: 'alice',
      code: `
        const { Agent, Type, getModel } = require("@alva/pi");
        (async () => {
          const agent = new Agent({ initialState: {
            systemPrompt: "Use tools.",
            model: getModel("openai", "gpt-5.5"),
            tools: [{
              name: "add",
              description: "Add two numbers.",
              parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
              execute: async (_id, { a, b }) => {
                console.log("tool-ran", a + b);
                return { content: [{ type: "text", text: String(a + b) }] };
              },
            }],
          }});
          const { text } = await agent.ask("add 1 and 2");
          console.log("final:", text);
        })();
      `,
      httpFetch,
    });
    expect(env.status).toBe('completed');
    expect(env.logs).toContain('tool-ran 3');
    expect(env.logs).toContain('final: sum is 3');
    expect(calls).toBe(2);
  }, 30_000);

  it.skipIf(!!process.env['DEEPSEEK_API_KEY'] || !!process.env['ANTHROPIC_API_KEY'])(
    '无 key 时 ask 报可诊断错误',
    async () => {
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({}));
      const env = await runFeed({
        root,
        user: 'alice',
        code: `
          const { Agent } = require("@alva/pi");
          (async () => { await new Agent().ask("hi"); })();
        `,
      });
      expect(env.status).toBe('failed');
      expect(String(env.error)).toContain('alpi requires a model API key');
    },
    30_000,
  );
});
