import type { AgentTools, ToolEnvelope, ToolSpec } from './agentTools.js';
import type { ChatMessage } from './chatStore.js';

export type AgentEventName = 'text_delta' | 'tool_start' | 'tool_result';
export type AgentEmit = (event: AgentEventName, data: unknown) => void;

export interface AgentResponse {
  content: string;
  metadata?: unknown;
}

export interface AgentRunnerOptions {
  tools: AgentTools;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  maxToolRounds?: number;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage?: unknown;
}

export class AgentRunner {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxToolRounds: number;

  constructor(private readonly opts: AgentRunnerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'claude-fable-5';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxToolRounds = opts.maxToolRounds ?? 8;
  }

  async run(input: { messages: ChatMessage[]; latestMessage: string; emit: AgentEmit }): Promise<AgentResponse> {
    if (!this.apiKey) {
      return runDeterministicAgent(input.latestMessage, this.opts.tools, input.emit);
    }
    return this.runClaude(input.messages, input.emit);
  }

  private async runClaude(messages: ChatMessage[], emit: AgentEmit): Promise<AgentResponse> {
    let apiMessages = toAnthropicMessages(messages);
    const toolNameMap = new Map<string, string>();
    const anthropicTools = this.opts.tools.specs().map((tool) => toAnthropicTool(tool, toolNameMap));
    const textParts: string[] = [];
    const toolCalls: { name: string; success: boolean }[] = [];

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const response = await this.createMessage({
        messages: apiMessages,
        tools: anthropicTools,
      });
      const assistantBlocks = response.content;
      apiMessages = [...apiMessages, { role: 'assistant', content: assistantBlocks }];

      const toolUses = assistantBlocks.filter(isToolUseBlock);
      for (const block of assistantBlocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
          emit('text_delta', { text: block.text });
        }
      }

      if (toolUses.length === 0) {
        const content = textParts.join('').trim();
        return {
          content: content || '我已完成这轮处理，但模型没有返回文本内容。',
          metadata: { route: 'claude-tool-use', model: this.model, rounds: round + 1, toolCalls },
        };
      }

      const toolResults: AnthropicToolResultBlock[] = [];
      for (const toolUse of toolUses) {
        const originalName = toolNameMap.get(toolUse.name) ?? toolUse.name;
        emit('tool_start', { id: toolUse.id, name: originalName, input: toolUse.input });
        const envelope = await this.opts.tools.execute(originalName, toolUse.input);
        emit('tool_result', { id: toolUse.id, name: originalName, envelope });
        toolCalls.push({ name: originalName, success: envelope.success });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(envelope),
          ...(envelope.success ? {} : { is_error: true }),
        });
      }
      apiMessages = [...apiMessages, { role: 'user', content: toolResults }];
    }

    return {
      content:
        textParts.join('').trim() ||
        '工具调用已执行，但 agent 达到最大回合数后仍未形成最终回答。',
      metadata: { route: 'claude-tool-use', model: this.model, max_rounds_hit: true, toolCalls },
    };
  }

  private async createMessage(input: {
    messages: AnthropicMessage[];
    tools: ReturnType<typeof toAnthropicTool>[];
  }): Promise<AnthropicResponse> {
    const resp = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': this.apiKey!,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt(),
        messages: input.messages,
        tools: input.tools,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Claude API failed (${resp.status}): ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as AnthropicResponse;
  }
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      out.push({ role: msg.role, content: msg.content });
    }
  }
  return out.length > 0 ? out : [{ role: 'user', content: '' }];
}

function toAnthropicTool(tool: ToolSpec, map: Map<string, string>): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  const safeName = tool.name.replaceAll('.', '__');
  map.set(safeName, tool.name);
  return { name: safeName, description: tool.description, input_schema: tool.input_schema };
}

function isToolUseBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use';
}

function systemPrompt(): string {
  return [
    'You are OpenAlva, a local-first financial workflow agent.',
    'Use tools for market facts, ALFS file operations, feed runs, deploy operations, and mirrored data skills.',
    'Never answer market prices, performance, or time-sensitive finance facts from memory. Use data.call or another relevant tool.',
    'If the user asks to build a persistent playbook, use ask-first behavior: confirm scope before writing a full playbook unless the scope is already explicit.',
    'Keep responses concise, concrete, and honest about missing data or unavailable pro-gated endpoints.',
  ].join('\n');
}

async function runDeterministicAgent(
  message: string,
  tools: AgentTools,
  emit: AgentEmit,
): Promise<AgentResponse> {
  const lower = message.toLowerCase();
  const wantsBuild = /playbook|监控|构建|创建|帮我建|build/.test(lower);
  if (wantsBuild) {
    return {
      content:
        '我可以把它做成持续运行的 playbook。先确认一下范围：需要哪些标的、刷新频率、以及页面里要展示价格、涨跌幅、成交量还是告警阈值？确认后我会生成 feed、运行测试，再发布本地 URL。',
      metadata: { route: 'ask-first-fallback' },
    };
  }

  if (/\bbtc\b|比特币/.test(lower)) {
    const toolCallId = crypto.randomUUID();
    const input = {
      skill: 'arrays-data-api-spot-market-price-and-volume',
      endpoint: 'binance-spot-usdt-kline',
      params: { symbol: 'BTC', interval: '1d', limit: 8 },
    };
    emit('tool_start', { id: toolCallId, name: 'data.call', input });
    const envelope = await tools.execute('data.call', input);
    emit('tool_result', { id: toolCallId, name: 'data.call', envelope });
    if (!envelope.success) {
      return {
        content: `我尝试通过 data.call 读取 BTC 行情，但数据源返回：${envelope.error?.message ?? 'unknown error'}。我不会用记忆补行情数据。`,
        metadata: { route: 'data-question-fallback', tool_error: envelope.error },
      };
    }
    const rows = dataRows(envelope);
    return {
      content: summarizeBtcRows(rows),
      metadata: { route: 'data-question-fallback', rows: rows.length },
    };
  }

  return {
    content:
      '我已收到。当前没有配置 Claude API key，所以我会用本地 fallback 处理；涉及实时市场事实时仍会走 data.call，涉及构建 playbook 时会先确认范围。',
    metadata: { route: 'plain-chat-fallback' },
  };
}

function dataRows(envelope: ToolEnvelope): Record<string, unknown>[] {
  const data = envelope.data;
  if (!data || typeof data !== 'object') return [];
  const maybe = data as { data?: unknown };
  if (!Array.isArray(maybe.data)) return [];
  return maybe.data.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && !Array.isArray(row),
  );
}

function summarizeBtcRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'data.call 没有返回 BTC 行情记录，因此我不能给出表现判断。';
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const firstClose = num(first['price_close'] ?? first['close']);
  const lastClose = num(last['price_close'] ?? last['close']);
  const asOf = String(last['time_close'] ?? last['date'] ?? last['timestamp'] ?? 'latest');
  if (firstClose === undefined || lastClose === undefined) {
    return `我通过 data.call 取到了 ${rows.length} 条 BTC 行情记录，最新时间为 ${asOf}。返回数据缺少可识别的 close 字段，所以暂不计算涨跌幅。`;
  }
  const pct = ((lastClose - firstClose) / firstClose) * 100;
  return `我通过 data.call 取到了 ${rows.length} 条 BTC 日线记录。最新收盘价约 ${round(lastClose)}，相对窗口起点 ${round(firstClose)} 的变化为 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%，最新时间为 ${asOf}。`;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function round(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
