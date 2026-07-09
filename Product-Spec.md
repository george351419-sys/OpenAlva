# OpenAlva - Product Spec

> 版本：v1.0（2026-07-09）
> 事实来源：`逆向材料/Alva系统架构综合.md`（架构）、`逆向材料/alva-official-skill/`（官方 skill 全套文档）、`逆向材料/参考实现/crypto-top5-watch/`（真实 playbook 样本）、6 张 alva.ai 界面截图（2026-07-09）。
> 本 spec 面向 Claude Code 直接开发（Node/TS 本地系统），不适用 Google AI Studio Builder。

## 1. 产品概述

### 1.1 产品定位

OpenAlva 是 alva.ai 的开源单机复刻：投资者通过网页对话界面驱动 AI agent 构建**持续运行的金融工作流（Playbook）**——feed 数据管线定时刷新、HTML 仪表盘实时展示——并支持版本化发布与带血缘的 Remix。

**已锁定的三个关键决策：**

1. **单机自用优先，架构预留平台化**——数据模型、目录结构照搬 Alva 的多用户设计（`<ALFS_ROOT>/home/<user>/feeds`、`playbook.json`、release 版本化），后期平台化不重构。
2. **方案 B：自建 chat 前端 + Claude API agent 编排**——不是 Claude Code 套壳，是有自己界面的完整产品（作品向）。
3. **数据层「接口全抄、来源分层」**——19 个 Data Skills 的目录/schema 原样镜像；P0 经 `arrays-via-alva` 代理驱动取数（已实测可行、零 credit），P1 逐个替换本地原生源，pro-gated 留 stub。

### 1.2 目标用户

- **主要用户**：George 本人——同时是投资者（选股策略、加密监控）和 builder（要一个能给别人看的作品）。
- **使用场景**：
  1. 对话让 agent 建一个「美股 Top 20 监控」playbook，每小时刷新，浏览器随时打开看。
  2. 问一次性问题（"BTC 最近资金费率什么水平"），agent 直接取实时数据回答，不建任何持久物。
  3. 跑一个 MACD/RSI 策略回测，看 equity curve 和逐笔账。
  4. 把自己的某个 playbook Remix 成新变体（换标的、换阈值），血缘可溯。
  5. 在 Explore 门户浏览本地所有 playbook，像逛 alva.ai 一样。

### 1.3 核心价值

市面上没有可自部署的「对话 → 持久金融工作流」系统；Alva 本体闭源、免费层受限、账号不属于自己。OpenAlva 把这套架构攥在自己手里：数据源可替换、agent 模型可替换（Claude 替代其 GPT-5.5/Codex）、产物永远本地可用。

---

## 2. 功能需求

### 2.1 核心功能列表

#### F1：对话式 Agent（自建编排层）

- **描述**：网页 chat 界面 + 服务端 Claude API tool-use 循环。Agent 按 Alva 的任务路由规则工作：一次性问答直接取数回答；一次性图表出自包含 HTML chart 嵌入聊天；构建 playbook 走 ask-first gate（先确认再构建）；回测走 Altra-lite。
- **输入**：自然语言消息；`@` 引用上下文文件；`/` 触发 blueprint 技能。
- **输出**：流式 markdown 回复、代码块、chart artifact 卡片、playbook live 链接。
- **AI 能力**：Claude API（`claude-fable-5`，可切换）多轮 tool-use；系统 prompt 分层复刻 Alva 指令栈（安全 > 工具权限 > 工程规则 > 平台规则 > 会话 prefill），模板照搬 `alva-official-skill/skills/alva/SKILL.md` 的路由与 Content Legitimacy 规则（市场事实必须实时取数，禁止模型记忆作答）。

#### F2：Agent 工具面（与 alva CLI 动词对齐）

- **描述**：Agent 的工具集镜像 alva CLI 动词：`fs.read/write/readdir/grant`、`run`、`deploy.create/pause/resume`、`release.playbookDraft/playbook`、`data.call`、`screenshot`、`skills.list/get`。**对齐的目的：官方 32 份 blueprint/reference 文档几乎零改动复用。**
- **输入**：agent 的 tool call（JSON）。
- **输出**：工具执行结果（JSON envelope `{success, data}`，同 Alva）。
- **AI 能力**：无（纯执行层）；工具 schema 喂给 Claude tool-use。

#### F3：ALFS 本地文件系统

- **描述**：`~/.openalva/home/<user>/` 为根的持久文件树，目录结构逐字节兼容 Alva：`playbooks/<name>/{index.html, README.md, playbook.json, udf/}`、`feeds/<name>/v<major>/{feed.json, src/index.js, data/<group>/<output>/}`、`memory/`。
- **输入**：agent/系统的文件操作。
- **输出**：文件内容；数据读取支持 `@last/<N>` 语义（返回某输出流最新 N 条记录）。
- **AI 能力**：无。

#### F4：Feed 运行时

- **描述**：本地 Node 沙箱（worker + 模块白名单）执行 feed 脚本，实现 `@alva/feed` 兼容 API：`feed.def(group, {output: makeDoc(...)})`、`ctx.self.ts(group, output).append(rows)`、`@kv` 状态存储；沙箱内提供 `net/http`、`secret-manager`（读本地 secrets 库）。API 契约以 `alva-official-skill/references/feed-sdk.md`（916 行）为准。
- **输入**：feed 脚本路径 + 执行触发（手动 run / cron）。
- **输出**：追加写入 `data/<group>/<output>/` 的时序记录；执行日志。
- **AI 能力**：无。

#### F5：调度器（Deploy/Automation 等价物）

- **描述**：本地 cron 调度（croner），支持 create/list/pause/resume/delete、run 历史与日志、失败重试；对应 `alva deploy` + `alva automation publish` 的语义。
- **输入**：feed 入口路径 + cron 表达式。
- **输出**：定时执行记录、下次触发时间。
- **AI 能力**：无。

#### F6：Playbook 发布（Release 版本化）

- **描述**：draft → release 流程，`playbook.json` schema 兼容 Alva（draft/releases/feeds 绑定/changelog/metadata.trading_pairs）；每个 release 生成 index.html 不可变快照，由本地静态服务托管：`http://localhost:<port>/u/<user>/playbooks/<name>`（最新 release）与 `/pb-static/<user>/<name>/<version>/index.html`（版本快照）。发布前置检查：feed 数据管线存在且有产出、lint、截图验证。
- **输入**：playbook 名、display name、绑定 feeds、changelog。
- **输出**：live URL、release 记录。
- **AI 能力**：AI 生成 changelog/README 草稿（见 2.2）。

#### F7：Playbook 前端运行时（浏览器 SDK）

- **描述**：复刻 `@alva-ai/toolkit` 浏览器 bundle 的最小子集：`OpenAlva.Client().fs.read({path})` 供 playbook HTML 读 feed 数据（`<FEED_ROOT>/<group>/<output>/@last/<N>`）。单机版不做 viewer token，接口留参（`pbsvToken`、`?api_origin=`）以兼容后期平台化。
- **输入**：playbook HTML 内的 SDK 调用。
- **输出**：feed 数据 JSON。
- **AI 能力**：无。

#### F8：数据层（Data Skills 目录 + DataSource 适配器）

- **描述**：19 个 Data Skill 的目录、描述、endpoint schema 通过脚本从 `alva data-skills` 全量镜像为本地文档（agent 世界观与 Alva 一致）。取数走 DataSource 适配器：
  - **driver `arrays-via-alva`（P0）**：本地把取数代码经 `alva run` 发进 Alva 云沙箱执行（JWT 在沙箱 secrets），JSON 走 logs 返回。已实测：200、330ms、credits_used=0。仅覆盖 public 端点。
  - **driver `native-*`（P1）**：Binance/Hyperliquid 公开 API、yfinance、FRED、Polymarket、SEC EDGAR、RSS 逐个替换。
  - **pro-gated 端点**：接口存在，返回结构化错误「数据源未配置」。
- **输入**：skill 名 + endpoint + 参数。
- **输出**：统一 `{success, data[], request_id}` 封套（同 Arrays）。
- **AI 能力**：agent 按 skill 描述自主选择端点（描述文本已包含路由指引）。

#### F9：Altra-lite 回测引擎

- **描述**：按 `alva-official-skill/references/altra-trading.md`（1033 行）复刻 API 形态：`FeedAltra`（portfolioOptions/simOptions/perfOptions）、`dataGraph.registerOhlcv/registerFeature`（增量窗口计算防未来函数）、`setStrategy(strategyFn, {trigger: e.ohlcv(...), inputConfig, initialState})`、策略契约 `(ctx) => ({target: {instruction: {type:"allocate", weights}}, state, logs})`；产出 equity curve、逐笔账、Sharpe/Sortino/CAGR/回撤，写入 feed data 目录供 HTML 展示。
- **输入**：策略定义文件（constants/features/strategy/main 组织）。
- **输出**：回测结果时序数据。
- **AI 能力**：agent 根据用户口述规则生成策略代码。

#### F10：Remix（血缘复刻）

- **描述**：按 `remix-workflow.md` 复刻：读源 playbook.json/index.html/README/feed scripts/UDF → 在目标 namespace 重建全套文件（改数据路径）→ 重走 run 测试/部署/发布流水线 → 记录 parents 血缘。**不复制**：cron 实例、secrets、源 feed 生产数据。
- **输入**：源 playbook 标识 + 新名字 + 修改意图（对话表达）。
- **输出**：新 playbook（blood-line 记录在 playbook.json）。
- **AI 能力**：agent 执行整个 remix 对话流（理解"换成 ETH、阈值改 25"并改代码）。

#### F11：Explore 门户

- **描述**：本地 web 门户，照抄 alva.ai Explore 布局：featured hero 卡 + 分类 tabs（Asset Deepdive/Backtest/Smart Screener/Theme Tracker/AI Digest，即 blueprint 分类）+ 搜索 + 三列卡片网格（预览截图、标题、描述、作者、浏览数、remix 数）。单机版数据来自本地 playbook 库。
- **输入**：浏览/筛选/搜索。
- **输出**：playbook 列表与详情跳转。
- **AI 能力**：无（预览截图由发布流程的 screenshot 步骤生成）。

### 2.2 AI 增强功能

| 增强点 | 原始功能 | AI 增强方式 | 触发时机 |
|---|---|---|---|
| AI 生成 README/changelog | F6 发布 | 从 feed schema + HTML 结构自动起草，用户确认 | release 前 |
| AI 起名 | F6 发布 | 根据 playbook 内容建议 name/display_name | draft 创建时 |
| AI 策略代码生成 | F9 回测 | 口述规则 → Altra-lite 策略文件 | 对话中 |
| AI Remix 改写 | F10 | "换标的/改阈值/加指标"直接改代码并自测 | remix 对话 |
| AI 数据源路由 | F8 | agent 按 skill 描述选端点，失败自动换备选 | 每次取数 |

---

## 3. 用户流程

### 3.1 主流程：对话构建 Playbook

1. **发起**：用户在 Chat 输入"帮我建一个 BTC+美股 Top10 监控，每小时刷新"。
   - 系统响应：agent 走 ask-first gate——先给一次性的实时数据答案，再问"要做成持久 playbook 吗？"（Build intent 明确时直接确认范围）。
2. **确认**：用户说"要"。
   - 系统响应：agent 选 blueprint（screener/thesis 等），生成 feed 脚本 → `run` 测试 → 展示样例数据。
   - 界面状态：聊天流中出现工具执行卡片（折叠详情），左栏 Playbooks 列表出现新条目（draft 态）。
3. **构建界面**：agent 按 design-tokens 生成 index.html，本地渲染截图回贴聊天。
4. **部署与发布**：agent 建 cron → release → 返回 `http://localhost:<port>/u/george/playbooks/<name>`。
5. **日常使用**：用户直接打开 URL；数据由 cron 自动刷新，页面 SDK 读 `@last/N`。

### 3.2 Remix 流程

1. Explore 详情页点「Remix」→ 跳转 Chat 并预填上下文。
2. 用户口述修改点 → agent 重建文件树 → 重走测试/部署/发布 → 新 playbook 带 parents 血缘。

### 3.3 异常流程

- **feed 执行失败**：cron 记录失败原因；连续 3 次失败通知用户（门户红点 + 聊天提示）；playbook 页面展示"数据截至 <时间>"而不是空白。
- **数据源不可用**（Alva 账号失效/pro 端点）：DataSource 返回结构化错误；agent 明确告知"取不到"并建议替代源，禁止编造数据。
- **发布前置检查不过**（无数据管线/lint 失败）：拒绝 release，agent 返回具体失败项。

---

## 4. UI/UX 设计

以 6 张 alva.ai 截图为准（视觉基准），design tokens 直接采用 `alva-official-skill/references/design-tokens.css`。

### 4.1 整体布局

**布局类型**：两栏——深色固定 Sidebar（约 300px）+ 浅色主区（自适应）。

```
┌──────────┬────────────────────────────────────────┐
│ Logo  ⊞  │  [主区：Chat / Explore / Playbook 详情]  │
│ +New Chat│                                        │
│ ─────────│                                        │
│ Explore  │                                        │
│ Portfolio│                                        │
│ Skill    │                                        │
│ ─────────│                                        │
│ Playbooks│                                        │
│  · 列表   │                                        │
│ ─────────│                                        │
│ Chats    │                                        │
│  · 列表   │                                        │
│ ─────────│                                        │
│ 用户头像  │                                        │
└──────────┴────────────────────────────────────────┘
```

- **Sidebar**（深色 #1a1d24 系）：Logo + 折叠钮；「+ New Chat」全宽按钮；主导航（Explore/Portfolio/Alva Skill→OpenAlva 对应 Explore/Skills，Portfolio 二期）；Playbooks 区（图标+名称列表，More 展开）；Chats 区（历史会话）；底部用户头像+用户名（点开账户菜单）。
- **主区**（浅色）：按路由切换 Chat / Explore / Playbook 详情。

### 4.2 页面详细设计

#### 页面 1：Chat

- **顶栏**：会话标题（可下拉改名）＋右侧分享/导出图标。
- **消息流**：居中最大宽度约 1200px；assistant 消息渲染 markdown＋代码块（浅灰底、等宽字体）；工具执行以折叠卡片呈现；chart artifact 内嵌 iframe 卡片；playbook 完成时展示 live URL 卡片。
- **输入区**（底部固定，圆角大输入框）：placeholder「Ask OpenAlva anything. @ for context, / for skills」；左下「+」（附件）与技能按钮；右下**模型选择器下拉**（claude-fable-5 / claude-opus-4-8 / claude-sonnet-4-6）＋圆形发送按钮。
- **交互**：流式输出；工具执行时显示状态行（"Ran 3 commands"，可展开）。

#### 页面 2：Explore

- **结构**（自上而下）：大标题「Explore」；featured hero 卡（作者头像+名、大标题、两行描述、右侧预览图、分类 tag、👁 浏览数、⤨ remix 数）；筛选行（左：Popular 排序下拉 + 分类 tabs：Asset Deepdive/Backtest/Smart Screener/Theme Tracker/AI Digest；右：搜索框）；**三列卡片网格**：预览截图（顶部，等比）、标题（约 20px 半粗）、两行截断描述、底行（作者头像+名 | 👁 数 ⤨ 数）。
- **交互**：卡片点击进详情；tab 切换筛选分类。

#### 页面 3：Playbook 详情

- **结构**：顶部信息栏（标题、作者、版本、changelog 入口、「Remix」主按钮、「Open」新窗口打开）＋主体 iframe 全宽嵌入 release HTML 快照；README 折叠区。
- **交互**：Remix 点击 → 新建会话并预填源 playbook 上下文。

#### 页面 4：Agent 工作区（二期）

- 照抄 Alva Channel 视图：顶部 agent 名与描述，tabs：**Chat / Tasks / Alerts / Memory / Files**；Chat tab 显示会话摘要卡（标题+一句话+Open chat 链接）。

#### 账户菜单（底部头像弹出）

- 用户名+套餐徽章、邮箱；Usage 卡（可用额度大数字，单机版显示 API 用量统计）；Settings / Log Out；（Creator Earnings、渠道绑定按钮仅平台化后启用）。

### 4.3 控件规范

- **输入框**：聊天输入铺满主区宽度（左右留白 24px），圆角 16px，浅边框，多行自适应。
- **按钮**：主按钮（发送/Remix/Connect）teal 青绿色实底、圆角 8-12px；次按钮白底细边框；「+ New Chat」深色区内白边框全宽。
- **下拉框**：模型选择器/排序器为无边框文字+chevron 样式，宽度自适应内容。
- **卡片**：白底、1px 浅边框、圆角 12px、hover 轻阴影。
- **颜色/间距 token**：一律取自 `design-tokens.css`，不得覆盖（`.playbook-container` max-width 2048px、水平 padding 28px 照搬）。

---

## 5. AI 能力配置（Claude API）

| 能力 | 用途 | 使用场景 |
|---|---|---|
| Claude tool-use 多轮循环 | Agent 编排（F1/F2） | 所有对话 |
| Streaming | 聊天流式输出 | 所有回复 |
| 长系统 prompt + prompt caching | 指令栈 + SKILL.md 平台规则常驻 | 每次会话 |
| 代码生成 | feed 脚本 / HTML / 策略文件 | 构建与 remix |
| 视觉理解（可选） | 截图验证发布的 playbook 渲染 | release 前检查 |

**配置说明**：
- 模型：默认 `claude-fable-5`，界面可切 `claude-opus-4-8` / `claude-sonnet-4-6`；API key 存本地 secrets 库（`ANTHROPIC_API_KEY`），绝不入库/入 git。
- 系统 prompt 组装顺序（复刻 Alva 指令栈）：安全规则 → 工具权限 → 工程规则 → OpenAlva 平台规则（SKILL.md 改写版）→ 会话 prefill（用户、时间、memory 摘要）。
- 工具 schema：F2 的工具面以 JSON Schema 注册；引用文档（blueprint/references）按需注入而非常驻。

---

## 6. 技术需求

### 6.1 技术栈与结构

- Monorepo（Node 20+ / TypeScript）：`apps/web`（React+Vite 前端）、`apps/server`（Fastify：REST + SSE、静态托管、agent 编排）、`packages/feed-runtime`（沙箱+feed SDK）、`packages/altra-lite`、`packages/data-skills`（目录镜像+适配器）、`packages/alfs`（文件系统层）。
- 元数据存 SQLite（playbook 索引、cron 记录、run 日志、用量账本）；文件真相在 ALFS 目录（`~/.openalva/home/`）。
- feed 沙箱：Node worker + 模块白名单（`net/http`→undici 包装、`secret-manager`→本地加密存储、`@alva/feed`→自实现）；超时与内存上限（对应 `--max-heap-size-mb`）。
- CLI（`openalva`）：镜像 alva CLI 动词子集，方便调试与后期开放。

### 6.2 性能要求

- 单机单用户：聊天流首 token < 3s；playbook 页面加载 < 1s（本地静态）；feed 执行超时默认 120s。

### 6.3 数据要求

- feed 数据 append-only、按 `<group>/<output>` 分目录存 JSONL，`@last/N` 读取；release HTML 快照不可变；secrets 本地加密（不明文落盘）；所有对外 API 调用记录用量账本（表结构含 `source/amount/sessionId/playbookId/feedId/createdAtMs`，兼容 Alva，计费逻辑二期）。

---

## 7. 优先级规划

### 7.1 第一期（MVP：核心闭环，可演示）

1. ALFS + feed 运行时 + 调度器（F3/F4/F5）
2. 数据层：skills 目录镜像脚本 + `arrays-via-alva` 驱动（F8-P0）
3. Agent 编排 + Chat 前端（F1/F2，含 ask-first 路由与一次性 chart artifact）
4. 发布流水线 + playbook 静态托管 + 浏览器 SDK（F6/F7）
5. Explore 门户基础版（F11，列表+详情+iframe）

**MVP 验收**：一句话对话 → 生成含真实数据的 playbook → cron 自动刷新 → localhost URL 可打开 → Explore 可见。

**种子内容与兼容性验收（已定）**：用用户自己的 **Portfolio-Watch-Skill v2.1.4**（`Portfolio-Watch-Skill/portfolio-watch/SKILL.md`，`builds_on: alva`）构建 2-3 个股票组合 watch playbook（如美股 Top10、半导体组合、crypto+股票混合）。**该 skill 在 OpenAlva 上能跑通核心构建流程（profile feed + watch feed + 四 tab 界面 + release），即证明平台层对 Alva 的忠实复刻。** 它依赖的平台原语即兼容清单：`@alva/feed`、FeedAltra 组合数学、Data Skills 取数、UDF（UI 内编辑持仓）、`notify/message` 推送、alpi（一行叙事）、release+screenshot。其中 UDF invoke、本地通知渠道、alpi（即一次小型 Claude 调用）因此从二期提前为 **P1 前段**；它用到的 pro-gated 端点（期权链、内部人交易）在 free 代理下自然降级——skill 的信号源本身是模块化可缺省的。

### 7.2 第二期

- Altra-lite 回测（F9）＋ backtest blueprint
- Remix 完整流程（F10）＋ Explore remix 计数
- native 数据驱动替换（Binance/yfinance/FRED/Polymarket）
- Agent 工作区 tabs（Tasks/Alerts/Memory/Files）、memory 系统、通知

### 7.3 未来规划

- 多用户与鉴权、viewer token、UDF+credit 计费、Portfolio（交易账户接入）、公网部署、skillhub 社区

---

## 8. 参考产品

- **alva.ai**：抄——信息架构、六层系统架构、ALFS/feed/release/remix 数据模型、blueprint 技能体系、界面布局与 design tokens。不抄——GPT-5.5/Codex 底座（换 Claude）、云端多租户沙箱（本地 worker）、credit 商业化（仅留账本表结构）、Discord/Telegram 渠道（后置）。
- **差异化**：可自部署、数据源可插拔、agent 模型可换、产物本地永久可用。

---

## 9. 待补充事项

- [x] ~~用户的头三个真实 playbook 清单~~ → 已定（2026-07-09）：用 Portfolio-Watch-Skill 构建若干股票组合 watch，见 §7.1 种子内容。
- [ ] OpenAlva 品牌视觉（logo/名称最终确认）
- [ ] Alva 账号失效前的数据驱动替换时间表（P1 触发条件）
- [ ] Portfolio-Watch-Skill 的 `AGENTS.md` 记录了存储/部署的实战坑，DEV-PLAN 阶段必读。
