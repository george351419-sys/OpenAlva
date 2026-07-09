# Alva 系统架构综合（逆向工程事实汇总）

> 来源三方交叉验证：① Alva agent 自述（`系统说明`，2026-07-09 对话）；② 官方 `@alva-ai/toolkit` v0.15.0 SDK/CLI（README + 类型定义）；③ 用本机 alva CLI 对 `api-llm.prd.alva.ai` 的实测探测。
> 标注 [自述] 的信息只有 Alva 的口头说法，未经 API 验证。

## 1. 产品定位

Alva（alva.ai）：投资者通过自然语言对话构建**持续运行的金融工作流（Playbook）**，可发布为公开网页应用，其他用户可 **Remix**（复制逻辑、改参数、重新发布，保留血缘）。入口渠道包括网页、Discord、Telegram。

## 2. 总体架构（六层）

```
对话推理层 (LLM + 分层 prompt 栈)
  └─ 工具执行层 (shell / rg / apply_patch / Alva CLI / MCP)
       └─ Alva 平台层
            ├─ Arrays 数据层 (19 Data Skills + 250+ SDK 模块)
            ├─ jagent 云端 JS 沙箱 (alva run)
            ├─ ALFS 持久文件系统 (alva fs)
            ├─ Feed/Automation (alva deploy, cron 数据管线)
            ├─ Altra 回测/交易引擎
            ├─ 发布层 (release / playbook / UDF / remix)
            └─ Secrets Manager
  状态层: 会话 workspace(临时) + ALFS ~/memory/(持久)
  任务路由层: 问答 / 一次性图表 / Playbook / 回测 / Alert / 代码任务
```

### 2.1 对话推理层 [自述]

- 底座是通用 coding agent（工程层 prompt 自称 **Codex**），叠加 Alva 金融平台规则。
- 分层指令栈（优先级从高到低）：系统安全规则 > 工具/权限规则 > Codex 工程规则 > Alva 平台规则（AGENTS.md）> 会话 prefill（用户身份、memory、JWT 状态）> 用户消息。
- 十段功能性 prompt：顶层安全、工程代理、工具权限、Alva persona、金融工作流路由、数据真实性（市场事实必须实时验证，禁止用模型记忆）、memory 管理、一次性图表、Playbook 发布、沟通风格。
- 关键行为准则：先复用（查 trending/skillhub）再构建；持久 artifact 需用户明确确认；一次性画图只出自包含 HTML chart artifact，不建 playbook；回测强制走 Altra。

### 2.2 会话内工具 [自述，与 toolkit CLI 面吻合]

shell、读文件、apply_patch、rg、跑测试/起服务；`alva data-skills / fs / run / deploy / automation / release / screenshot / credits`；MCP 工具（发布聊天内 chart、上传文件、多选提问）；子代理（仅用户明确要求时）。

## 3. Playbook 实体构成（已确认）

**不是单个 HTML**，而是：前端 HTML + README + 一个或多个 feed 数据管线 + ALFS 数据输出 + release 元数据。

ALFS 目录结构（已确认，真实样本 crypto-top5-watch 存于 `逆向材料/参考实现/`）：

```
/alva/home/<username>/
  playbooks/<playbook-name>/
    index.html          # 前端，通过 SDK 读 feed 输出，禁止硬编码数据
    README.md
    playbook.json       # release 元数据（见下）
    udf/*.js            # 可选：创作者函数入口
  feeds/<feed-name>/
    feed.json
    v1/
      feed.json
      src/index.js      # 数据管线脚本（云端 cron 执行）
      data/
        @kv             # 虚拟 KV 状态存储
        <group>/<output>/...   # 按 feed.def 定义的分组输出
  memory/               # agent 长期记忆
```

**Feed SDK（`@alva/feed`）编程模型**（已从真实源码确认）：

```js
const { Feed, feedPath, makeDoc, str, num } = require("@alva/feed");
// 沙箱内可用模块还有 require("net/http")、require("secret-manager")
feed.def("watch", { overview: makeDoc("Overview", "...", [str("as_of"), ...]) });
await ctx.self.ts("watch", "overview").append([...]);   // 写数据 = 时间序列 append
```

**前端读数据**（不是裸 fetch，走 toolkit 浏览器 SDK）：

```js
const FEED_ROOT = "/alva/home/<owner>/feeds/<feed>/v1/data";
createAlvaClient().fs.read({ path: `${FEED_ROOT}/watch/assets/@last/50` });
```

数据路径格式：`/alva/home/<owner>/feeds/<feed>/v<major>/data/<group>/<output>/@last/<n>`（`@last/N` = 最新 N 条）。

**playbook.json 真实 schema**（样本 playbook_id 8472）：

```json
{
  "playbook_id": 8472, "owner_uid": "...", "type": "dashboard",
  "name": "crypto-top5-watch", "display_name": "...", "description": "...",
  "draft":    { "playbook_version_id": 42978, "feeds": [{ "feed_id": 14237, "feed_name": "...", "feed_major": 1 }] },
  "releases": [{ "version": "v1.0.0", "feeds": [...], "changelog": "...",
                 "layout_html": "https://<user>.playbook.alva.ai/<name>/v1.0.0/index.html" }],
  "readme_url": "/alva/home/<user>/playbooks/<name>/README.md"
}
```

- release 版本化的 HTML 托管在独立域 `<user>.playbook.alva.ai`（每个 release 一份不可变快照）。
- 发布页 URL：`https://alva.ai/u/<username>/playbooks/<name>`。

### 3.1 构建/发布流水线（blueprint 强制流程，命令链已确认）

```
确认构建意图（ask-first gate：默认先给文本答案，用户同意才构建）

alva fs write --path '~/feeds/<f>/v1/src/index.js' --file ./index.js --mkdir-parents
alva run --entry-path '~/feeds/<f>/v1/src/index.js'                    # 测试执行
alva fs grant --path '~/feeds/<f>' --subject "special:user:*" --permission read
alva deploy create --name <f> --path '~/feeds/<f>/v1/src/index.js' \
    --cron "0 * * * *" --push-notify --max-heap-size-mb 512            # 建 cron
alva automation publish --name <f> --version 1.0.0 --cronjob-id <id>   # 发布 automation
alva fs write --path '~/playbooks/<p>/index.html' ... （+ README.md）
alva release playbook-draft --name <p> --display-name "..." --feeds '[{"feed_id":N,"feed_major":1}]'
alva release playbook --name <p> --version v1.0.0 --feeds '[...]' --changelog "..." --readme-url "..."
→ lint / alva screenshot 截图验证 → live URL
```

注意 `alva automation publish` 未出现在 toolkit README 中——CLI 命令面比公开文档更大。

### 3.2 skillhub 模板机制（已实测）

- 模板命名空间 `<username>/<name>`，官方有 alva/*（backtest、screener、thesis、ai-digest、earnings、asset-deepdive、fintwit-roundtable）和 anthropic/*（dcf-model、comps-analysis、morning-note 等，基于 anthropics/financial-services）。
- 每个模板 = `blueprint.md`（给 agent 的构建说明书，1.7万~6.7万字节）+ 可选 `example/index.html`。
- blueprint 引用会话侧内部文档：`references/design-system.md`、`design-widgets.md`、`design-tokens.css`、`altra-trading.md`、`playbook-creation.md`、`remix-workflow.md`（skillhub 未公开，无法拉取）。
- 实例存档：`逆向材料/alva-backtest-blueprint.md`。

## 4. Arrays 数据层（已实测，19 个 Data Skills）

行情（美股/非美股票 kline、crypto spot/futures/perps、funding、OI、long-short、ETF）、股票基本面（三表、KPI、高管薪酬）、股票指标（估值倍数、技术指标、评级、darkpool）、事件（分红、拆股、财报日历、transcripts、IPO、M&A）、分析师预期（estimates、price targets、guidance）、所有权/资金流（机构、insider、国会交易）、期权（合约、Greeks、IV、option chain）、宏观（利率、CPI、GDP、外汇、商品、VIX）、链上（MVRV、NUPL、SOPR、exchange flow、token unlock 等 + 245 端点 passthrough）、新闻、社交（X 推文历史/搜索）、Polymarket、半导体价格（DRAM/NAND/DXI）。

- 端点分层：`public`（免费）/ `alternative`（多数 Pro）/ `unstructured`（新闻类，Pro）。
- 另有 SDK 模块（`alva sdk partitions`）：`feed_widgets`（news/YouTube/podcast/Reddit 声明式订阅流）、`unified_search`（Grok-X/Google/Brave/serper 搜索抓取）、`technical_indicator_calculation_helpers`（50+ 纯函数指标计算器）。
- Arrays 鉴权：独立 JWT，`alva configure` 时服务端自动签发，存入沙箱 secrets（`ARRAYS_JWT`）。

### 4.1 Arrays 直连与「Alva 数据代理」方案（2026-07-09 实测验证）

- Arrays 就是普通 REST：`https://data-tools.prd.space.id/api/v1/...`，`Authorization: Bearer <ARRAYS_JWT>`（文档另载 `X-API-Key` 方式）。响应封套 `{success, data[], request_id}`，K 线倒序（最新在前）。
- JWT 存在服务端沙箱 secrets，本地拿不到 → **`alva run` 沙箱可当数据网关**：本地把取数代码发进沙箱执行（`require("net/http")` + `secret.loadPlaintext("ARRAYS_JWT")`），JSON 走 logs 返回。实测 200 + 真实 BTC 日线，credits_used=0，330ms。
- `alva run` 语法约束：不允许顶层 return / 顶层 await，须用 async IIFE + console.log 输出。
- 免费层只覆盖 `public` 端点；pro-gated（alternative/unstructured）会拒绝。
- 端点规范可用 `alva data-skills list/summary/endpoint` 全量拉取 → 19 个 skill 的目录可**脚本化镜像**为本地文档，无需手抄。
- 架构结论：OpenAlva 数据层做成 DataSource 适配器，driver #1 = `arrays-via-alva`（代理，P0），driver #2+ = 本地原生源（yfinance/Binance/FRED 等，P1 替换），pro-gated 数据留 stub。风险：整条数据链挂在用户 Alva 账号上（key 失效/免费策略变更即断供），故适配器边界必须干净。

## 5. Altra 回测引擎（API 形态已确认）

**架构要点：Altra 不是独立服务，而是 feed 脚本内使用的库**（`@alva/feed` 的 `FeedAltraModule`），回测结果持久化到 feed 的 data 目录。最小策略定义（RSI 30/70，完整示例见 Alva 回复原文）：

```js
const { FeedAltraModule, createArraysOhlcvProvider, num } = require("@alva/feed");
const { FeedAltra, e } = FeedAltraModule;
const provider = createArraysOhlcvProvider({ jwt: ARRAYS_JWT });   // 数据源注入

const altra = new FeedAltra({
  path: "~/feeds/rsi-btc/v1", startDate,
  portfolioOptions: { initialCash: 100000, currency: "USDT" },
  simOptions: { simTick: "1d", feeRate: 0.001, slippage: 0.0005 },
  perfOptions: { timezone: "UTC", marketType: "crypto" },
}, provider);

const dg = altra.getDataGraph();
dg.registerOhlcv(SYMBOL, "1d");
dg.registerFeature({ name: "rsi14", inputConfig: {...}, fields: [num("rsi")],
  fn: (data, { fromExclusive, toInclusive }) => [...] });   // 增量窗口计算，防未来函数

altra.setStrategy(strategyFn, {
  trigger: { type: "events", expr: e.ohlcv(SYMBOL, "1d") },   // 事件触发表达式
  inputConfig: { ohlcvs: [...], features: [{ id: "rsi14", lookback: { count: 1 } }] },
  initialState: { lastSignal: null },
});
await altra.run(Date.now());
```

策略函数契约：`(ctx) => ({ target: { date, instruction: { type: "allocate", weights: [{symbol, weight}] }, meta }, state })`；`ctx` 含 `data.features`、`portfolio.positions`、`tick`、`state`。引擎负责：事件检测、前向收益、胜率/分位数、回撤、equity curve、逐笔 P&L、Sharpe/Sortino/CAGR、防未来函数。

另有 `alva trading` 命令组（实盘/模拟盘）：accounts / portfolio / orders / risk-rules / subscriptions（跟单）/ execute。

## 6. Remix 机制（已确认）

- 复制的是**逻辑与结构**，不是整个文件树：读源 playbook.json（latest release + feeds）、index.html、README、release 绑定的 feed scripts、可选 UDF 脚本与样例 feed 输出；在自己 namespace 下重建全套文件。
- **cron/automation 不继承**——必须用自己的 feed 走完整流水线（run 测试→grant→deploy→publish→release）。
- **secrets 绝不复制**；需要第三方 key 时用自己的 Secret Manager。
- 血缘：`alva remix --child-username --child-name --parents <json>`（支持多父级）。

## 7. UDF 与 Credit 计费（已确认）

- UDF：创作者用 `alva functions register` 注册（入口脚本必须是 ALFS 绝对路径 .js + params schema）；浏览者在 playbook iframe 内经 `window.alva.udf.call()` 调用（PBSV viewer token 机制，token 从 iframe URL 读取并剥离）。
- 计费模型：钱包余额 + 逐条消费记录 `{source, amount, sessionId, playbookId, feedId, createdAtMs}`。已观测 source=`ask`（会话问答）。UDF 按次计费，区分 owner/consumer：`{credits_used_total, credits_charged_owner, credits_charged_consumer}`，配 allowance 额度授权流程。Arrays 单次数据请求是否单独计费未证实；单价表未公开。
- Free 账号：发布的 playbook 强制公开；private/paid 可见性是 Pro 功能。实测 free 钱包余额 ~12703 credits。

## 8. 社区层（已实测）

trending feed（keyword/tags/sort/cursor 分页，返回 star 数、tags、live URL）、评论（create/pin/unpin）、通知偏好。

## 9. 尚存缺口（截至 2026-07-09 晚，主体已闭合）

原缺口 1-3（Altra schema、playbook.json 字段、feed 数据路径格式）已全部确认，见上文。剩余：

1. 设计规范文件内容（design-tokens.css 等，会话侧私有）→ 可从 `参考实现/crypto-top5-watch/index.html` 反推。
2. Arrays 数据请求级别的计费单价 → 平台方也未公开，对复刻不关键（OpenAlva 可自定计费规则）。
3. `@alva/feed` 库的完整 API 面 → 已有 def/append/ts/@kv/FeedAltra 主干，细节可在实现时按需补问。

补充（2026-07-09 晚第二轮）：Altra 完整多文件示例已存 `altra-strategy-example.md`（constants/features/strategy/main 组织、TIME 常量、simTick 细粒度模拟、logs 字段、双 symbol 体系 US_SPOT_*/BINANCE_SPOT_*）；playbook.json 还有 `metadata.trading_pairs`（含 fee_rate、icon）；前端 client 支持 pbsvToken + `?api_origin=` 注入。**Alva 内部文档在 `.claude/skills/alva/references/`——其 agent 层就是 Claude Code 式 skill 架构。**

## 10. 参考实现存档

`逆向材料/参考实现/crypto-top5-watch/`：用户自己账号里真实部署且已 release 的 playbook 全套源码（feed.json、v1-feed.json、feed-src-index.js 25.7KB、playbook.json、index.html 24KB、README.md），2026-07-09 经 `alva fs read` 拉取。这是 OpenAlva 端到端行为的对照基准。
