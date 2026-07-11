import fs from 'node:fs';
import { openAlvaPaths } from '@openalva/alfs';
import type { HttpFetchImpl } from './sandbox.js';
import type { AsyncTracker } from './tracker.js';

/**
 * `@alva/pi`（alpi）最小子集：确定性 pipeline 里的固定 LLM 推理/工具循环。
 * 覆盖 Agent.ask() 单结果用法（Portfolio-Watch 的「一行叙事」场景）+
 * 可选 tools 循环。key 从环境变量或 ~/.openalva/config.json 读
 * （deepseek 优先、anthropic 兜底）；官方脚本的 getModel("openai", ...)
 * 请求会映射到本地已配置的 provider。HTTP 走沙箱同一 httpFetch
 * （宿主可注入/桥接，测试可 mock）。
 */

interface AlpiDeps {
  root: string;
  tracker: AsyncTracker;
  httpFetch: HttpFetchImpl;
  /** key 注入此集合 → logs/error/result 封套统一脱敏（同 secret-manager） */
  secretValues?: Set<string>;
}

interface AlpiTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (id: string, args: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string }[];
  }>;
}

interface AgentState {
  systemPrompt?: string;
  model?: { provider: string; name: string };
  tools?: AlpiTool[];
  thinkingLevel?: string;
}

interface ResolvedModel {
  provider: 'deepseek' | 'anthropic';
  name: string;
  apiKey: string;
}

const OPTIONAL = Symbol('alpi.optional');
const MAX_ROUNDS = 6;

export function createAlpiModule(deps: AlpiDeps): Record<string, unknown> {
  const Type = {
    Object(props: Record<string, Record<string, unknown>>): Record<string, unknown> {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, schema] of Object.entries(props)) {
        const { [OPTIONAL as unknown as string]: opt, ...rest } = schema as Record<
          string,
          unknown
        >;
        properties[key] = rest;
        if (!opt) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    },
    String: () => ({ type: 'string' }),
    Number: () => ({ type: 'number' }),
    Integer: () => ({ type: 'integer' }),
    Boolean: () => ({ type: 'boolean' }),
    Array: (items: Record<string, unknown>) => ({ type: 'array', items }),
    Optional: (schema: Record<string, unknown>) => ({
      ...schema,
      [OPTIONAL as unknown as string]: true,
    }),
  };

  function getModel(provider: string, name: string): { provider: string; name: string } {
    return { provider, name };
  }

  class Agent {
    private readonly state: AgentState;

    constructor(options?: { initialState?: AgentState }) {
      this.state = options?.initialState ?? {};
      // drain() 只等被追踪的异步操作——ask 必须入追踪面
      this.ask = deps.tracker.wrap(this.askInner.bind(this));
    }

    readonly ask: (prompt: string) => Promise<{
      message: { role: 'assistant'; content: { type: 'text'; text: string }[] };
      text: string;
    }>;

    private async askInner(prompt: string): Promise<{
      message: { role: 'assistant'; content: { type: 'text'; text: string }[] };
      text: string;
    }> {
      const model = resolveModel(deps.root, this.state.model);
      // provider 4xx 响应体可能回显（部分掩码的）key——进脱敏集兜底
      deps.secretValues?.add(model.apiKey);
      const text =
        model.provider === 'deepseek'
          ? await runDeepseekLoop(deps.httpFetch, model, this.state, prompt)
          : await runAnthropicLoop(deps.httpFetch, model, this.state, prompt);
      return { message: { role: 'assistant', content: [{ type: 'text', text }] }, text };
    }
  }

  return { Agent, Type, getModel };
}

function resolveModel(root: string, requested?: { provider: string; name: string }): ResolvedModel {
  const keys = loadKeys(root);
  // 明确点名 anthropic 且有 key 时尊重（含点名的模型名）；其余优先 deepseek
  if (requested?.provider === 'anthropic' && keys.anthropicApiKey) {
    return {
      provider: 'anthropic',
      name: requested.name || keys.anthropicModel,
      apiKey: keys.anthropicApiKey,
    };
  }
  if (keys.deepseekApiKey) {
    const name = requested?.provider === 'deepseek' ? requested.name : keys.deepseekModel;
    return { provider: 'deepseek', name, apiKey: keys.deepseekApiKey };
  }
  if (keys.anthropicApiKey) {
    return { provider: 'anthropic', name: keys.anthropicModel, apiKey: keys.anthropicApiKey };
  }
  throw new Error(
    'alpi requires a model API key: set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY or deepseekApiKey/anthropicApiKey in ~/.openalva/config.json',
  );
}

function loadKeys(root: string): {
  deepseekApiKey?: string;
  anthropicApiKey?: string;
  deepseekModel: string;
  anthropicModel: string;
} {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(openAlvaPaths(root).configFile, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // 无 config：只看环境变量
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    ...(process.env['DEEPSEEK_API_KEY'] ?? str(config['deepseekApiKey'])
      ? { deepseekApiKey: process.env['DEEPSEEK_API_KEY'] ?? str(config['deepseekApiKey']) }
      : {}),
    ...(process.env['ANTHROPIC_API_KEY'] ?? str(config['anthropicApiKey'])
      ? { anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? str(config['anthropicApiKey']) }
      : {}),
    deepseekModel:
      process.env['OPENALVA_DEEPSEEK_MODEL'] ?? str(config['deepseekModel']) ?? 'deepseek-chat',
    anthropicModel:
      process.env['OPENALVA_CLAUDE_MODEL'] ?? str(config['anthropicModel']) ?? 'claude-fable-5',
  };
}

function toolByName(state: AgentState, name: string): AlpiTool | undefined {
  return (state.tools ?? []).find((t) => t.name === name);
}

function toolResultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

async function runDeepseekLoop(
  httpFetch: HttpFetchImpl,
  model: ResolvedModel,
  state: AgentState,
  prompt: string,
): Promise<string> {
  interface DsMessage {
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  }
  const messages: DsMessage[] = [
    { role: 'system', content: state.systemPrompt ?? 'You are a helpful assistant.' },
    { role: 'user', content: prompt },
  ];
  const tools = (state.tools ?? []).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const resp = await httpFetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.name,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        max_tokens: 2_048,
      }),
    });
    if (!resp.ok) {
      throw new Error(`alpi deepseek call failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    }
    const json = (await resp.json()) as {
      choices?: { message?: DsMessage }[];
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error('alpi deepseek call returned no message');
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const tool = toolByName(state, call.function.name);
        if (!tool) throw new Error(`alpi model called unknown tool: ${call.function.name}`);
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        const result = await tool.execute(call.id, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(result) });
      }
      continue;
    }
    return typeof msg.content === 'string' ? msg.content : '';
  }
  throw new Error(`alpi hit the ${MAX_ROUNDS}-round tool loop limit without a final answer`);
}

async function runAnthropicLoop(
  httpFetch: HttpFetchImpl,
  model: ResolvedModel,
  state: AgentState,
  prompt: string,
): Promise<string> {
  type Block =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string };
  const messages: { role: 'user' | 'assistant'; content: string | Block[] }[] = [
    { role: 'user', content: prompt },
  ];
  const tools = (state.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }));

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const resp = await httpFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': model.apiKey,
      },
      body: JSON.stringify({
        model: model.name,
        max_tokens: 2_048,
        system: state.systemPrompt ?? 'You are a helpful assistant.',
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(
        `alpi anthropic call failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    const json = (await resp.json()) as { content?: Block[]; stop_reason?: string };
    const blocks = json.content ?? [];
    const toolUses = blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (toolUses.length > 0) {
      messages.push({ role: 'assistant', content: blocks });
      const results: Block[] = [];
      for (const use of toolUses) {
        const tool = toolByName(state, use.name);
        if (!tool) throw new Error(`alpi model called unknown tool: ${use.name}`);
        const result = await tool.execute(use.id, use.input);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: toolResultText(result) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    return blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  throw new Error(`alpi hit the ${MAX_ROUNDS}-round tool loop limit without a final answer`);
}
