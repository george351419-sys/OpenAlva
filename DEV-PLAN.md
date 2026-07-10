# OpenAlva - DEV Plan

> 版本：v1.0（2026-07-09）｜当前进度：**Phase 3 Chat 主链路部分完成，Phase 4 最小发布面部分完成；下一步 screenshot/lint 门禁 + Explore 门户 + chart artifact**
> 上游文档：`Product-Spec.md`（功能与范围）、`Design-Brief.md`（视觉裁决）、`逆向材料/Alva系统架构综合.md`（平台行为）、`Portfolio-Watch-Skill/AGENTS.md` §5（实战坑）。
> 每个 Phase 内任务可独立验证；Phase 完成 = 验收命令通过 + 两阶段 review 通过 + 原子提交。

## 0. 技术栈与仓库结构（定案）

- pnpm workspaces monorepo，Node 20+，TypeScript strict，vitest，ESLint+Prettier。
- 结构：
  ```
  apps/server      Fastify：REST+SSE、agent 编排、静态托管（门户+playbook 快照+design-system）
  apps/web         React+Vite：Sidebar/Chat/Explore/详情
  packages/alfs    文件系统层（home 树、@last/N、ts 桶、@kv、grant 存根）
  packages/feed-runtime  worker 沙箱 + @alva/feed 兼容 SDK + secret-manager
  packages/data    Data Skills 目录镜像 + DataSource 适配器（arrays-via-alva / native-*）
  packages/altra-lite    回测引擎（Phase 6）
  packages/cli     openalva CLI（alva 动词子集）
  vendor/design-system   官方 css/tokens/contract 原件（不改）
  ```
- 元数据 SQLite（`~/.openalva/openalva.db`）：playbook 索引、cron 与 run 日志、会话、用量账本。文件真相在 `~/.openalva/home/<user>/`。
- **git：Phase 0 第一件事就是 `git init` + 初始提交。** 当前项目已是 git 仓库；后续每个完成单元需原子提交。

## 1. 必须遵守的平台行为（从实战坑固化为测试）

实现 alfs/feed-runtime 时，以下语义必须与 Alva 一致，**每条都要有单测**：

1. `ts(group, doc).append(rows)`：同一 `date` 桶 ⇒ **整桶 REPLACE**；不同 `date` 共存；`@last/N` 返回 `date` 最大的 N 条。固定桶模式（如 `BUCKET_DEMO/BUCKET_LIVE` 两桶并存）必须可行。
2. `data/` 目录禁止任意 `writeFile`，只能经 ts append 写入。
3. `alfs.readFile` 返回字节 Promise（`JSON.parse(String(await ...))` 模式必须成立）；`alfs.remove(path)` 单参数。
4. feed 运行时**不能**触发 cron/重算后端；UI 动作写配置标志，下次调度生效；owner 可 `openalva deploy trigger --id`。
5. 通知 fanout 按记录 `date` 去重；notify 行用 `Date.now()` 而非业务 `as_of`。
6. 时间戳差异如实保留：美股 kline `time_close` Unix 秒、crypto ISO 字符串（适配器不做"贴心"归一，blueprint 依赖原样）。
7. 沙箱模块白名单：`net/http`（undici 包装，签名兼容 `http.fetch/get`）、`secret-manager`（`loadPlaintext`）、`@alva/feed`；超时/内存上限可配。

**Phase 1 隔离信任决定（2026-07-10 审查后登记；同日已根治升级）**：feed 执行最初采用进程内 vm 上下文，2026-07-10 按计划升级为**一次性子进程隔离**（`runFeed` fork `feedChild` + tsx loader，API 不变）：vm 逃逸（`this.constructor.constructor(...)` 经宿主原型链够到 Function 构造器）只到达可丢弃的沙箱子进程而非 server 进程（有测试断言逃逸拿到的 pid ≠ 宿主 pid）；失控同步循环由宿主超时 SIGKILL 中断（有测试）；`maxHeapSizeMb` 经 `--max-old-space-size` 生效；自定义 httpFetch（Arrays 路由）经 IPC 桥回宿主执行。保留的纵深防御：子进程内 vm `codeGeneration:false`、模块白名单、secret 脱敏、同进程 runFeed 全局串行化。**仍开放的风险**：跨进程（CLI 与 server 同时写同一 feed）无锁——风险登记不变。~~已知口径偏差~~（2026-07-10 二轮修复已消除）：子进程日志经 IPC 实时回传（发送前按已知 secret 脱敏），超时/崩溃的失败封套现在保留已产生的 logs（有测试）；`timeoutMs` 改为从子进程 ready 信号起计，不含 fork/loader 启动开销（另有 30s 启动守卫兜底）。

## 2. Phase 0 — 工程基座（0.5 天）

- [x] `git init`、`.gitignore`、pnpm workspaces 脚手架、TS/ESLint/vitest 配置、`pnpm check`（typecheck+lint+test）一键脚本。
- [x] vendor 设计资产：从 `逆向材料/alva-official-skill` 复制 design-system.css / design-tokens.css / design-contract.yaml 至 `vendor/design-system/`；server 静态挂载 `/design-system/v1/design-system.css`。
- [x] `~/.openalva/` 初始化器（home 树、db、secrets 文件）。
- **验收**：`pnpm install && pnpm check` 绿；`curl localhost:PORT/design-system/v1/design-system.css` 返回官方 bundle。✅ 2026-07-09 实测通过（6 测试全绿；/health 200；css/tokens 200 且为官方原件；~/.openalva 树生成）。

## 3. Phase 1 — ALFS + Feed 运行时 + 调度器（2-3 天，平台心脏）

- [x] `packages/alfs`：路径解析（`~` 展开到 `home/<user>`）、read/write/readdir/stat/mkdir/remove、`@last/<N>` 读取、ts 桶存储（JSONL 分桶文件）、`@kv`、grant/revoke 存根（单机恒真）。§1 语义单测全绿。
- [x] `packages/feed-runtime`：进程内 vm 沙箱 + 模块白名单 + `@alva/feed` 实现（`Feed/feedPath/makeDoc/str/num/feed.def/ctx.self.ts().append/ctx.kv`），执行日志捕获（logs/result/stats 封套同 alva run）。worker_threads/子进程隔离已登记为后续加固项。
- [x] 调度器：croner + SQLite run 记录；`deploy create/list/get/pause/resume/delete/trigger`；连续失败计数。
- [x] `packages/cli`：`openalva fs|run|deploy` 子命令（JSON 输出封套同 alva CLI）。
- **验收（关键）**：✅ 参考实现 `逆向材料/参考实现/crypto-top5-watch/feed-src-index.js` 原样经合成 Arrays mock 跑通，生成 `data/watch/*` 五组输出；CLI `fs read` 可读 `@last/N`。

## 4. Phase 2 — 数据层（完成 2026-07-10）

- [x] 目录镜像脚本（`packages/data/src/mirror.ts`）：`alva data-skills list/summary/endpoint` 全量拉取 → `packages/data/catalog/`（catalog.json 索引 + docs/<skill>/<endpoint>.md）。**实测镜像：19 skills / 111 endpoints（59 public / 52 pro-gated）**。单端点文档失败容错（如 file 名 "list" 撞 CLI 保留字）。
- [x] DataSource 适配器接口 + `arrays-via-alva` driver（`packages/data/src/arraysViaAlva.ts`）：本地拼 URL、模板化生成取数代码 → `alva run` → 哨兵包裹的 logs → `{success,data[],request_id}`；错误分类 PRO_GATED/AUTH/UPSTREAM/PARSE/SOURCE_UNAVAILABLE。pro-gated 本地即拒，不发往返。
- [x] 路由型 httpFetch（`packages/data/src/arraysRouting.ts`）：拦截 feed 对 Arrays 主机的 `http.fetch`，透明转发到云沙箱（JWT 在那里），非 Arrays 请求走 fallback。**使参考实现 feed 无需改动即可本地跑真数据。**
- [x] 本地 secrets 库（`~/.openalva/secrets.json`，`secret-manager.loadPlaintext` 读）；init 播种 `ARRAYS_JWT` 占位。
- **验收**：✅ 2026-07-10 live 实测 —— public 端点（Binance BTC kline）经 arrays-via-alva 取到真数据零 credit；pro 端点（insider-transactions）本地 PRO_GATED 拒绝；**crypto-top5-watch 经路由驱动完整重跑成功（48.7s / 28 次云调用，真实行情 BTC@63230 ETH@1745 BNB@569 XRP@1 SOL@78）**。43 单测全绿。

**Arrays 鉴权约定（集成事实，已固化）**：Arrays JWT 只在 Alva 云沙箱 secrets 里，本地不持有。feed 会本地守卫 `secret.loadPlaintext("ARRAYS_JWT")` 后才发请求，故 init 播种占位值 `routed-via-alva` 让守卫通过；feed 设的 `Bearer <占位>` 被路由层丢弃，云端注入真 JWT。占位绝非真实凭证。风险仍在：链路挂在用户 Alva 账号（账号失效/免费策略变更即断供）→ Phase 6 的 native driver 是解绑方案。

## 5. Phase 3 — Agent 编排 + Chat 前端（3-4 天）

- [ ] server：会话存储、Claude API tool-use 循环（SSE 流式）、prompt 栈组装（安全→工具→工程→平台规则→prefill）；平台规则=官方 SKILL.md 的 OpenAlva 改写版（路由/ask-first/Content Legitimacy 保留）。
  - [x] 2026-07-10 部分完成：SQLite `chat_sessions/chat_messages`、Phase 3 工具注册/执行 JSON envelope、`/api/chat/sessions/*` SSE 骨架、BTC 数据问答的确定性 `data.call` 路由、playbook 构建 ask-first fallback。
  - [x] 2026-07-10 追加完成：`AgentRunner` 接入 Anthropic Messages API tool-use 回合（`ANTHROPIC_API_KEY` 存在时启用）、tool 名称安全映射（`.` → `__`）、`text_delta/tool_start/tool_result/message/done` SSE 事件；无 key 时保留本地 fallback。prompt 栈当前为精简 OpenAlva 平台规则，官方 SKILL.md 改写版仍待展开。
  - [x] 2026-07-10 修复轮：改用官方 `@anthropic-ai/sdk` 真流式（`stream:true`，逐 delta 下发 `text_delta`）、`max_tokens` 提至 16384 并显式处理 `stop_reason=max_tokens` 截断；SSE handler 增加错误处理（`error` 事件 + 失败也落库，不再挂死连接）；工具执行历史落库为 `role=tool` 消息（刷新可恢复工具卡、后续轮次回放给模型）；config `defaultUser` 透传 `buildApp`；调度器归 `buildApp` 所有，`deploy.trigger` 与 cron 共享 `CronService` 并发保护；`maxHeapSizeMb` 接通 runFeed；feed 沙箱升级为子进程隔离（见 §1）。
  - [x] 2026-07-10 二轮：**多模型驱动**——`AgentRunner` 拆 provider（anthropic / deepseek / local fallback），DeepSeek 走 OpenAI 兼容 `chat/completions` 流式 + function tools（key 填 `DEEPSEEK_API_KEY` 环境变量或 `~/.openalva/config.json` 的 `deepseekApiKey`，env 优先）；`GET /api/models` 列可用模型，stream 请求带 `model` 字段路由，前端模型选择器真实生效。**prompt 栈展开**：system prompt 改为官方 SKILL.md 的 OpenAlva 改写精简版（mental model / 三路 request routing / ask-first / content legitimacy / ALFS 语义 / playbook 流程），细节手册经新工具 `skilldocs.list`/`skilldocs.read`（16k 窗口分页）从官方 alva skill 与 Portfolio-Watch-Skill 按需加载。**Arrays 路由全面接线**：cron 定时、agent `run` 工具、CLI `run`/`deploy trigger` 统一经 `createArraysRoutingFetch`（经子进程 http IPC 桥回宿主执行）。**chart artifact**：`artifact.publish {title,html}` 工具 → `/artifacts/:id` 本地 URL → 前端 iframe 卡内嵌渲染。
- [ ] 工具面注册（F2）：fs/run/deploy/release/data.call/screenshot/skills，schema 即 JSON Schema；blueprint 技能加载（`skills/` 目录：官方 7 个 blueprint + Portfolio-Watch-Skill）。
  - [x] 2026-07-10 部分完成：`fs.read/write/readdir/stat/mkdir/grant`、`run`、`deploy.create/list/get/pause/resume/delete/trigger/runs`、`data.call`、`skills.list/get` 已注册。
  - [x] 2026-07-10 追加完成：`release.playbookDraft`、`release.playbook` 已注册并测试覆盖；`screenshot`、blueprint 技能加载待补。
- [ ] web：Sidebar+Chat 页（Design-Brief §4.1/4.2）；工具执行折叠卡；chart artifact iframe 卡；模型选择器。
  - [x] 2026-07-10 部分完成：新增 `apps/web` React+Vite；Sidebar + Chat 页、会话列表、消息流、POST SSE 解析、工具执行折叠卡、模型选择器静态控件；server 构建后可托管 `apps/web/dist`。chart artifact iframe 卡和真实模型切换待补。
- **验收**：对话「BTC 最近 7 天表现如何」→ agent 经 data.call 取真数据、流式回答 + 一个符合设计规范的 chart artifact；对话「帮我建个 playbook」→ 走 ask-first gate 先确认。
  - 2026-07-10 当前可验收子集：后端 SSE 能触发 `data.call` 并持久化消息（测试使用 StubDataSource）；Claude-style tool-use loop 已用 fake Anthropic response 覆盖；`pnpm build:web` 通过。真实 chart artifact 待补。

## 6. Phase 4 — 发布流水线 + 门户（2-3 天）

- [ ] release：`playbook-draft`/`playbook`（playbook.json 兼容 schema、feeds 绑定校验、changelog）；release 快照复制到 `pb-static/<user>/<name>/<version>/`（不可变）；live 路由 `/u/<user>/playbooks/<name>`。
  - [x] 2026-07-10 部分完成：新增 `ReleaseService`，支持创建/更新 draft playbook 目录与 `playbook.json`，发布 `index.html` 到 `pb-static/<user>/<name>/<version>/`，更新 `latest_release`，并提供 `/u/<user>/playbooks/<name>` live URL。feeds 产出校验、changelog AI 草稿、完整 schema 兼容仍待补。
- [ ] 浏览器 SDK（`OpenAlva.Client().fs.read`，参数形态兼容 AlvaToolkit）；lint 门禁（移植 design-contract.yaml 核心规则：容器/滚动/字重/链接/overflow）；screenshot（Playwright）。
  - [x] 2026-07-10 部分完成：`/openalva/v1/client.js` 提供最小 `OpenAlva.Client().fs.read({path})`，通过 `/api/tools/fs.read` 读取 ALFS。lint 门禁和 screenshot 待补。
  - [x] 2026-07-11 完成 lint 门禁：`playbookLint.ts` 移植 design-contract 全局核心规则（容器/样式表/滚动唯一容器/字重 400\|500/链接 target+rel/抗锯齿三声明/ECharts rAF），`release.lint` 工具 + `release.playbook` 强制拦截（`force=true` 可跳过）；组件级 registry 校验留待需要时再补。测试锁定违规拦截与合规放行。
  - [x] 2026-07-11 完成 screenshot：`playwright-core` + 本机 Chrome（channel:'chrome'，不下载 Chromium）。release 成功后 best-effort 截图到快照目录（无 Chrome/加载失败不阻塞发布）；`screenshot {url}` 工具供 agent 自检视觉产出（仅限本机 URL，PNG 经 /artifacts/:id.png 提供）。实测发布 demo playbook 生成 12KB 截图。
- [ ] Explore 门户 + 详情页（Design-Brief §4.3/4.4）；浏览数统计。
  - [x] 2026-07-10 部分完成：`GET /api/explore` 列出已发布 playbook（扫描 `~/playbooks/*/playbook.json` 有 `latest_release` 的），web 侧 Explore 页卡片网格（名称/描述/版本/live 链接）。
  - [x] 2026-07-11 追加：Explore 卡片带 release 截图（screenshot_url）与浏览数（`playbook_views` 表，live 页每次打开 +1，截图访问经 x-openalva-screenshot 头豁免计数）。仅剩详情页待补。
- **验收**：crypto-top5-watch 的 index.html（仅改 FEED_ROOT 与 SDK 名）本地发布 → URL 打开渲染真数据 → lint 通过 → Explore 出现卡片带截图。

## 7. Phase 5 — MVP 收口：Portfolio-Watch 种子内容（2-3 天）

- [ ] P1 前段三件套（spec §7.1 已定）：UDF 注册与 invoke（`window.openalva.udf.call`）、本地通知渠道（macOS 系统通知 + 可选 Telegram bot，二选一先 macOS）、alpi 等价原语（小型 Claude 调用，一行叙事）。
- [ ] 经 Chat 用 Portfolio-Watch-Skill 构建 2-3 个股票组合 watch（如：美股 Top10、半导体组合、crypto+股票混合）；pro-gated 信号源验证优雅降级。
- **验收 = Spec §7.1 MVP 验收**：一句话 → 真数据 playbook → cron 自刷 → URL 可开 → Explore 可见；且 Portfolio-Watch-Skill 核心构建流程（profile feed + watch feed + 多 tab 界面 + release + UDF 编辑持仓 + 一条真实通知）全部跑通。

## 8. Phase 6 — 二期（规划）

Altra-lite（altra-trading.md 1033 行 API 形态）→ Remix 完整流程与血缘 → native 数据驱动替换（Binance/yfinance/FRED/Polymarket）→ Agent 工作区 tabs（Tasks/Alerts/Memory/Files）+ memory 系统。

## 9. 流程纪律

- 每 Phase：开工前重读上游三文档相关章节；完成后 code-reviewer 两阶段审查（Stage 1 对 spec，Stage 2 质量）；修复后从 Stage 1 重审；过审才原子提交。
- 任何声称"完成"必须附本轮验收命令的真实输出。
- UI 变更同步更新 Design-Brief；范围变更先改 Product-Spec 再动代码。
- 风险登记：Alva 账号断供（P1 提前触发 native driver）、`alva run` 开始计费（同前）、Delight 字体授权（Design-Brief §7）。
