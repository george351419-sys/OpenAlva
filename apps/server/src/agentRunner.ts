import Anthropic from '@anthropic-ai/sdk';
import type { AgentTools, ToolEnvelope, ToolSpec } from './agentTools.js';
import type { ChatMessage } from './chatStore.js';

export type AgentEventName = 'text_delta' | 'tool_start' | 'tool_result';
export type AgentEmit = (event: AgentEventName, data: unknown) => void;

export interface AgentResponse {
  content: string;
  metadata?: unknown;
}

export type ModelProvider = 'anthropic' | 'deepseek' | 'local';

export interface ModelInfo {
  id: string;
  provider: ModelProvider;
  default: boolean;
}

export interface AgentRunnerOptions {
  tools: AgentTools;
  anthropicApiKey?: string;
  anthropicModel?: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
  deepseekBaseUrl?: string;
  fetchImpl?: typeof fetch;
  maxToolRounds?: number;
  maxTokens?: number;
}

export interface AgentRunInput {
  messages: ChatMessage[];
  latestMessage: string;
  emit: AgentEmit;
  /** 用户在 UI 里选的模型 id；缺省/未知则用默认模型 */
  model?: string;
}

export class AgentRunner {
  private readonly anthropicClient?: Anthropic;
  private readonly anthropicModel: string;
  private readonly deepseekModel: string;
  private readonly deepseekBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxToolRounds: number;
  private readonly maxTokens: number;

  constructor(private readonly opts: AgentRunnerOptions) {
    this.anthropicModel = opts.anthropicModel ?? 'claude-fable-5';
    this.deepseekModel = opts.deepseekModel ?? 'deepseek-chat';
    this.deepseekBaseUrl = opts.deepseekBaseUrl ?? 'https://api.deepseek.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // 发现流程（skills.list/get/doc）会消耗不少回合，上限要给足
    this.maxToolRounds = opts.maxToolRounds ?? 24;
    this.maxTokens = opts.maxTokens ?? 16_384;
    if (opts.anthropicApiKey) {
      this.anthropicClient = new Anthropic({
        apiKey: opts.anthropicApiKey,
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      });
    }
  }

  /** 可用模型清单（依据已配置的 API key）；首个为默认。 */
  models(): ModelInfo[] {
    const out: ModelInfo[] = [];
    if (this.opts.anthropicApiKey) {
      out.push({ id: this.anthropicModel, provider: 'anthropic', default: false });
    }
    if (this.opts.deepseekApiKey) {
      out.push({ id: this.deepseekModel, provider: 'deepseek', default: false });
    }
    if (out.length === 0) {
      out.push({ id: 'local-fallback', provider: 'local', default: false });
    }
    out[0] = { ...out[0]!, default: true };
    return out;
  }

  async run(input: AgentRunInput): Promise<AgentResponse> {
    const models = this.models();
    const chosen = models.find((m) => m.id === input.model) ?? models[0]!;
    const response = await this.runWith(chosen, input);
    if (input.model && chosen.id !== input.model) {
      // 请求的模型不可用（如 key 被移除）时回落默认，并在 metadata 里留痕
      response.metadata = {
        ...(response.metadata as Record<string, unknown> | undefined),
        requested_model: input.model,
        fallback_model: chosen.id,
      };
    }
    return response;
  }

  private async runWith(chosen: ModelInfo, input: AgentRunInput): Promise<AgentResponse> {
    if (chosen.provider === 'anthropic' && this.anthropicClient) {
      return this.runClaude(this.anthropicClient, input.messages, input.emit);
    }
    if (chosen.provider === 'deepseek') {
      return this.runDeepseek(input.messages, input.emit);
    }
    return runDeterministicAgent(input.latestMessage, this.opts.tools, input.emit);
  }

  // ── Anthropic（官方 SDK，真流式） ────────────────────────────────────────

  private async runClaude(
    client: Anthropic,
    messages: ChatMessage[],
    emit: AgentEmit,
  ): Promise<AgentResponse> {
    let apiMessages = toAnthropicMessages(messages);
    const toolNameMap = new Map<string, string>();
    const anthropicTools = this.opts.tools.specs().map((tool) => toAnthropicTool(tool, toolNameMap));
    const textParts: string[] = [];
    const toolCalls: { name: string; success: boolean }[] = [];

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const stream = client.messages.stream({
        model: this.anthropicModel,
        max_tokens: this.maxTokens,
        system: systemPrompt(),
        messages: apiMessages,
        tools: anthropicTools,
      });
      stream.on('text', (delta) => {
        textParts.push(delta);
        emit('text_delta', { text: delta });
      });
      const message = await stream.finalMessage();
      apiMessages = [...apiMessages, { role: 'assistant', content: message.content }];

      if (message.stop_reason === 'max_tokens') {
        return truncatedResponse(textParts, emit, {
          route: 'claude-tool-use',
          model: this.anthropicModel,
          rounds: round + 1,
          toolCalls,
        });
      }

      const toolUses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        const content = textParts.join('').trim();
        return {
          content: content || '我已完成这轮处理，但模型没有返回文本内容。',
          metadata: {
            route: 'claude-tool-use',
            model: this.anthropicModel,
            rounds: round + 1,
            toolCalls,
          },
        };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const originalName = toolNameMap.get(toolUse.name) ?? toolUse.name;
        emit('tool_start', { id: toolUse.id, name: originalName, input: toolUse.input });
        const envelope = await this.opts.tools.execute(originalName, toolUse.input);
        emit('tool_result', { id: toolUse.id, name: originalName, input: toolUse.input, envelope });
        toolCalls.push({ name: originalName, success: envelope.success });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          // 上限防大文件 fs.read 之类的结果撑爆上下文
          content: truncate(JSON.stringify(envelope), 20_000),
          ...(envelope.success ? {} : { is_error: true }),
        });
      }
      apiMessages = [...apiMessages, { role: 'user', content: toolResults }];
    }

    return maxRoundsResponse(textParts, {
      route: 'claude-tool-use',
      model: this.anthropicModel,
      toolCalls,
    });
  }

  // ── DeepSeek（OpenAI 兼容 chat/completions，流式 + function tools） ─────

  private async runDeepseek(messages: ChatMessage[], emit: AgentEmit): Promise<AgentResponse> {
    const toolNameMap = new Map<string, string>();
    const dsTools = this.opts.tools.specs().map((tool) => toDeepseekTool(tool, toolNameMap));
    let apiMessages = toDeepseekMessages(messages);
    const textParts: string[] = [];
    const toolCalls: { name: string; success: boolean }[] = [];

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const turn = await this.deepseekStreamTurn(apiMessages, dsTools, (delta) => {
        textParts.push(delta);
        emit('text_delta', { text: delta });
      });

      apiMessages = [
        ...apiMessages,
        {
          role: 'assistant',
          content: turn.content || null,
          ...(turn.toolCalls.length > 0
            ? {
                tool_calls: turn.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
      ];

      if (turn.finishReason === 'length') {
        return truncatedResponse(textParts, emit, {
          route: 'deepseek-tool-use',
          model: this.deepseekModel,
          rounds: round + 1,
          toolCalls,
        });
      }

      if (turn.toolCalls.length === 0) {
        const content = textParts.join('').trim();
        return {
          content: content || '我已完成这轮处理，但模型没有返回文本内容。',
          metadata: {
            route: 'deepseek-tool-use',
            model: this.deepseekModel,
            rounds: round + 1,
            toolCalls,
          },
        };
      }

      for (const call of turn.toolCalls) {
        const originalName = toolNameMap.get(call.name) ?? call.name;
        const input = parseJsonObject(call.arguments);
        emit('tool_start', { id: call.id, name: originalName, input: input ?? call.arguments });
        // 参数 JSON 损坏（如流中断截断）时不以空参执行，把解析错误回给模型
        const envelope: ToolEnvelope =
          input === null
            ? {
                success: false,
                error: {
                  code: 'BAD_TOOL_ARGS',
                  message: `tool arguments were not valid JSON: ${truncate(call.arguments, 500)}`,
                },
              }
            : await this.opts.tools.execute(originalName, input);
        emit('tool_result', { id: call.id, name: originalName, input, envelope });
        toolCalls.push({ name: originalName, success: envelope.success });
        apiMessages = [
          ...apiMessages,
          {
            role: 'tool',
            tool_call_id: call.id,
            content: truncate(JSON.stringify(envelope), 20_000),
          },
        ];
      }
    }

    return maxRoundsResponse(textParts, {
      route: 'deepseek-tool-use',
      model: this.deepseekModel,
      toolCalls,
    });
  }

  private async deepseekStreamTurn(
    messages: DeepseekMessage[],
    tools: DeepseekTool[],
    onText: (delta: string) => void,
  ): Promise<{ content: string; toolCalls: AccumulatedToolCall[]; finishReason: string | null }> {
    const resp = await this.fetchImpl(`${this.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      // 上游挂死时不无限等待（覆盖连接+整个流读取）
      signal: AbortSignal.timeout(300_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: this.deepseekModel,
        messages: [{ role: 'system', content: systemPrompt() }, ...messages],
        tools,
        stream: true,
        // deepseek-chat 输出上限 8K
        max_tokens: Math.min(this.maxTokens, 8_192),
      }),
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`DeepSeek API failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    const contentParts: string[] = [];
    const calls = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;

    const handleLine = (line: string): void => {
      const payload = line.startsWith('data:') ? line.slice(5).trim() : null;
      if (!payload || payload === '[DONE]') return;
      let chunk: DeepseekChunk;
      try {
        chunk = JSON.parse(payload) as DeepseekChunk;
      } catch {
        return;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        contentParts.push(delta.content);
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const existing = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        calls.set(tc.index, existing);
      }
    };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    // 冲刷 decoder 与残留最后一行（流被中途截断时不丢已到达的数据）
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);

    return {
      content: contentParts.join(''),
      toolCalls: [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c], i) => ({ ...c, id: c.id || `call_${i}` })),
      finishReason,
    };
  }
}

// ── DeepSeek 协议类型（OpenAI 兼容子集） ──────────────────────────────────

interface DeepseekMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

interface DeepseekTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface DeepseekChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ── 共享工具函数 ──────────────────────────────────────────────────────────

function truncatedResponse(
  textParts: string[],
  emit: AgentEmit,
  metadata: Record<string, unknown>,
): AgentResponse {
  // 截断时 tool_use 输入可能不完整，不执行，直接如实报告
  const notice = '\n\n[本轮输出达到 max_tokens 上限被截断，以上内容可能不完整。]';
  emit('text_delta', { text: notice });
  return {
    content: textParts.join('') + notice,
    metadata: { ...metadata, truncated: true },
  };
}

function maxRoundsResponse(textParts: string[], metadata: Record<string, unknown>): AgentResponse {
  return {
    content:
      textParts.join('').trim() || '工具调用已执行，但 agent 达到最大回合数后仍未形成最终回答。',
    metadata: { ...metadata, max_rounds_hit: true },
  };
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (msg.content) out.push({ role: msg.role, content: msg.content });
    } else if (msg.role === 'tool') {
      // 历史工具执行以文本回放到上下文（连续同角色消息 API 会自动合并成一轮）
      out.push({
        role: 'user',
        content: `[之前的工具执行记录 ${msg.tool_name ?? ''}] ${truncate(msg.content, 2_000)}`,
      });
    }
  }
  return out.length > 0 ? out : [{ role: 'user', content: '(empty)' }];
}

function toDeepseekMessages(messages: ChatMessage[]): DeepseekMessage[] {
  const out: DeepseekMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (msg.content) out.push({ role: msg.role, content: msg.content });
    } else if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: `[之前的工具执行记录 ${msg.tool_name ?? ''}] ${truncate(msg.content, 2_000)}`,
      });
    }
  }
  return out.length > 0 ? out : [{ role: 'user', content: '(empty)' }];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return null;
}

function toAnthropicTool(tool: ToolSpec, map: Map<string, string>): Anthropic.Tool {
  // API 工具名只允许 [a-zA-Z0-9_-]，'.' 需映射
  const safeName = tool.name.replaceAll('.', '__');
  map.set(safeName, tool.name);
  return {
    name: safeName,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  };
}

function toDeepseekTool(tool: ToolSpec, map: Map<string, string>): DeepseekTool {
  const safeName = tool.name.replaceAll('.', '__');
  map.set(safeName, tool.name);
  return {
    type: 'function',
    function: {
      name: safeName,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/**
 * OpenAlva 平台规则（官方 alva SKILL.md 的本地改写精简版）。
 * 详细手册经 skilldocs.* 渐进加载，不塞进 system prompt。
 */
function systemPrompt(): string {
  return [
    'You are OpenAlva, a local-first agentic finance platform (a self-hosted replica of Alva).',
    'Mental model: you are not the data source — you build inspectable pipelines that fetch data, verify shape, compute, persist to ALFS, and render results.',
    '',
    'Request routing:',
    '1. Simple market/data question → data.call the mirrored Data Skill endpoint, answer with the as-of timestamp. Discovery pipeline is mandatory for endpoints you have not used in this conversation: skills.list → skills.get(skill) → skills.doc(skill, endpoint) → data.call. Never guess skill names, endpoint names, or query params — guessed params cause upstream 404s.',
    '2. Computation or transformation → write a feed script and execute it with the run tool.',
    '3. Persistent, refreshing artifact (watchlist, dashboard, screener) → feed + deploy (cron) + release as a playbook. ASK FIRST: before building a playbook, confirm scope (symbols, refresh cadence, displayed fields) unless the user already specified it explicitly.',
    '',
    'Hard rules:',
    '- Never answer market prices, performance, or any time-sensitive finance fact from memory. Always fetch via tools and state the data timestamp.',
    '- Content legitimacy: only produce finance content backed by actually-fetched data. Never fabricate numbers, backtest results, or promotional hype. Label assumptions clearly.',
    '- Pro-gated endpoints fail locally by design; degrade gracefully and say so.',
    '',
    'Platform semantics (must respect):',
    '- ALFS ts(group, doc).append(rows): rows sharing one date replace that whole bucket; different dates coexist; @last/N reads the newest N records.',
    '- data/ mounts are only writable through ts append, never plain fs.write.',
    '- Feeds cannot trigger their own recompute; UI actions write config flags read on the next scheduled run; the owner can deploy.trigger manually.',
    '- Playbook flow: release.playbookDraft → write ~/playbooks/<name>/index.html (link /design-system/v1/design-system.css and the browser SDK /openalva/v1/client.js; wrap content in <div class="playbook-container">) → release.lint and fix ALL violations → release.playbook (refuses on lint violations) → live at /u/<user>/playbooks/<name>. Verify the rendered page with the screenshot tool.',
    '- One-off charts or visual explainers: artifact.publish {title, html} returns a URL that renders inline as an iframe card — prefer this for chart answers.',
    '',
    'Deep procedures (Feed SDK, playbook creation, design rules, data-skill catalogs, operational pitfalls) live in skill docs. Call skilldocs.list to discover them and skilldocs.read (with offset paging) BEFORE building feeds, playbooks, or Altra strategies. Key references in the alva skill: references/feed-sdk.md, references/playbook-creation.md, references/design.md, references/data-skills.md, references/operational-pitfalls.md.',
    '',
    'Efficiency: you may request SEVERAL tool calls in one turn (parallel tool calls) — batch independent reads (multiple skills.doc, multiple data.call) instead of one per turn. Once an endpoint worked in this conversation, reuse it without re-reading docs.',
    '',
    'Keep responses concise, concrete, and honest about missing data.',
  ].join('\n');
}

// ── 本地 fallback（无任何 API key 时） ────────────────────────────────────

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
    emit('tool_result', { id: toolCallId, name: 'data.call', input, envelope });
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
      '我已收到。当前没有配置模型 API key（ANTHROPIC_API_KEY 或 DEEPSEEK_API_KEY），所以我会用本地 fallback 处理；涉及实时市场事实时仍会走 data.call，涉及构建 playbook 时会先确认范围。',
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
