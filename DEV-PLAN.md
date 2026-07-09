# OpenAlva - DEV Plan

> 版本：v1.0（2026-07-09）｜当前进度：**Phase 0 完成（commit f5325e5，2026-07-09），下一步 Phase 1**
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
- **git：Phase 0 第一件事就是 `git init` + 初始提交（当前项目还不是仓库）。**

## 1. 必须遵守的平台行为（从实战坑固化为测试）

实现 alfs/feed-runtime 时，以下语义必须与 Alva 一致，**每条都要有单测**：

1. `ts(group, doc).append(rows)`：同一 `date` 桶 ⇒ **整桶 REPLACE**；不同 `date` 共存；`@last/N` 返回 `date` 最大的 N 条。固定桶模式（如 `BUCKET_DEMO/BUCKET_LIVE` 两桶并存）必须可行。
2. `data/` 目录禁止任意 `writeFile`，只能经 ts append 写入。
3. `alfs.readFile` 返回字节 Promise（`JSON.parse(String(await ...))` 模式必须成立）；`alfs.remove(path)` 单参数。
4. feed 运行时**不能**触发 cron/重算后端；UI 动作写配置标志，下次调度生效；owner 可 `openalva deploy trigger --id`。
5. 通知 fanout 按记录 `date` 去重；notify 行用 `Date.now()` 而非业务 `as_of`。
6. 时间戳差异如实保留：美股 kline `time_close` Unix 秒、crypto ISO 字符串（适配器不做"贴心"归一，blueprint 依赖原样）。
7. 沙箱模块白名单：`net/http`（undici 包装，签名兼容 `http.fetch/get`）、`secret-manager`（`loadPlaintext`）、`@alva/feed`；超时/内存上限可配。

## 2. Phase 0 — 工程基座（0.5 天）

- [x] `git init`、`.gitignore`、pnpm workspaces 脚手架、TS/ESLint/vitest 配置、`pnpm check`（typecheck+lint+test）一键脚本。
- [x] vendor 设计资产：从 `逆向材料/alva-official-skill` 复制 design-system.css / design-tokens.css / design-contract.yaml 至 `vendor/design-system/`；server 静态挂载 `/design-system/v1/design-system.css`。
- [x] `~/.openalva/` 初始化器（home 树、db、secrets 文件）。
- **验收**：`pnpm install && pnpm check` 绿；`curl localhost:PORT/design-system/v1/design-system.css` 返回官方 bundle。✅ 2026-07-09 实测通过（6 测试全绿；/health 200；css/tokens 200 且为官方原件；~/.openalva 树生成）。

## 3. Phase 1 — ALFS + Feed 运行时 + 调度器（2-3 天，平台心脏）

- [ ] `packages/alfs`：路径解析（`~` 展开到 `home/<user>`）、read/write/readdir/stat/mkdir/remove、`@last/<N>` 读取、ts 桶存储（JSONL 分桶文件）、`@kv`、grant/revoke 存根（单机恒真）。§1 语义单测全绿。
- [ ] `packages/feed-runtime`：worker_threads 沙箱 + 模块白名单 + `@alva/feed` 实现（`Feed/feedPath/makeDoc/str/num/feed.def/ctx.self.ts().append/ctx.kv`），执行日志捕获（logs/result/stats 封套同 alva run）。
- [ ] 调度器：croner + SQLite run 记录；`deploy create/list/get/pause/resume/delete/trigger`；失败重试与连续失败计数。
- [ ] `packages/cli`：`openalva fs|run|deploy` 子命令（JSON 输出封套同 alva CLI）。
- **验收（关键）**：参考实现 `逆向材料/参考实现/crypto-top5-watch/feed-src-index.js` **原样**（仅数据源经 Phase 2 前的临时 mock provider）在 OpenAlva 跑通：`data/watch/*` 五组输出生成，`openalva fs read --path '.../watch/assets/@last/50'` 返回正确条数与最新桶。

## 4. Phase 2 — 数据层（1-2 天）

- [ ] 目录镜像脚本：`alva data-skills list/summary/endpoint` 全量拉取 → `packages/data/catalog/*.md`（含 19 skill 描述与端点 schema；记录 tier）。
- [ ] DataSource 适配器接口 + `arrays-via-alva` driver：模板化生成沙箱取数代码 → `alva run` 子进程 → logs JSON 解析 → `{success,data[],request_id}` 封套；错误分类（网络/鉴权/pro-gated→「数据源未配置」结构化错误）。
- [ ] 本地 secrets 库（加密存储，`secret-manager.loadPlaintext` 从这里读）。
- **验收**：三个 public 端点实测真数据（Binance BTC kline、stocks/kline AAPL、macro treasury）；pro 端点返回结构化未配置错误；Phase 1 的 crypto-top5-watch 换真实 driver 重跑成功。

## 5. Phase 3 — Agent 编排 + Chat 前端（3-4 天）

- [ ] server：会话存储、Claude API tool-use 循环（SSE 流式）、prompt 栈组装（安全→工具→工程→平台规则→prefill）；平台规则=官方 SKILL.md 的 OpenAlva 改写版（路由/ask-first/Content Legitimacy 保留）。
- [ ] 工具面注册（F2）：fs/run/deploy/release/data.call/screenshot/skills，schema 即 JSON Schema；blueprint 技能加载（`skills/` 目录：官方 7 个 blueprint + Portfolio-Watch-Skill）。
- [ ] web：Sidebar+Chat 页（Design-Brief §4.1/4.2）；工具执行折叠卡；chart artifact iframe 卡；模型选择器。
- **验收**：对话「BTC 最近 7 天表现如何」→ agent 经 data.call 取真数据、流式回答 + 一个符合设计规范的 chart artifact；对话「帮我建个 playbook」→ 走 ask-first gate 先确认。

## 6. Phase 4 — 发布流水线 + 门户（2-3 天）

- [ ] release：`playbook-draft`/`playbook`（playbook.json 兼容 schema、feeds 绑定校验、changelog）；release 快照复制到 `pb-static/<user>/<name>/<version>/`（不可变）；live 路由 `/u/<user>/playbooks/<name>`。
- [ ] 浏览器 SDK（`OpenAlva.Client().fs.read`，参数形态兼容 AlvaToolkit）；lint 门禁（移植 design-contract.yaml 核心规则：容器/滚动/字重/链接/overflow）；screenshot（Playwright）。
- [ ] Explore 门户 + 详情页（Design-Brief §4.3/4.4）；浏览数统计。
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
