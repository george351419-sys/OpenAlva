# OpenAlva - Design Brief

> 版本：v1.0（2026-07-09）
> 设计事实来源：① 官方设计系统原件 `逆向材料/alva-official-skill/skills/alva/references/`（design.md / design-tokens.css / css/design-system.css 2042 行 / design-components.md / design-widgets.md / design-contract.yaml）；② 6 张 alva.ai 真实界面截图（2026-07-09，Chat / Explore / Portfolio / Skill / Channel / 账户菜单）。
> **设计工件说明（fallback 记录）**：本项目无设计 MCP，不产出独立设计稿。上述官方 CSS 原件 + 截图即设计工件，本文件是其裁决规则。UI 变更须同步更新本文件。

## 1. 设计原则

1. **忠实复刻，不再创作**：OpenAlva 的视觉 = Alva 的视觉。所有颜色、间距、圆角、阴影一律 `var(--token)`，禁止硬编码 hex/rgba。有截图依据的照截图，无截图依据的按 token 体系推。
2. **两个设计域，两套约束**：
   - **Playbook 域**（iframe 内的 playbook HTML）：逐字采用官方设计系统，受 design linter 硬门禁（release 前必过）。
   - **宿主域**（Sidebar/Chat/Explore/详情页外壳）：复用同一套 token，布局按截图规范（§4）。
3. **资产本地化**：官方 CSS bundle 与字体不依赖 Alva CDN——构建时把 `design-system.css` 与 token 文件复制进本项目静态资源，playbook `<head>` 链接本地路径 `/design-system/v1/design-system.css`（保持与官方相同的引用形态，方便官方 blueprint 复用）。

## 2. Design Tokens（canonical）

Token 源文件：`design-tokens.css`（187 行），原样入库，不改值。速查：

| 类别 | Token | 值/说明 |
|---|---|---|
| 品牌主色 | `--main-m1` | `#49a3a6` 青绿（按钮/选中态/链接强调） |
| 涨/看多 | `--main-m3` | `#2a9b7d` |
| 跌/看空 | `--main-m4` | `#e05357` |
| 警示 | `--main-m5` | `#e6a91a` |
| 文本 | `--text-n9/n7/n5/n3/n2` | 黑色 alpha 0.9/0.7/0.5/0.3/0.2 |
| 页面底色 | `--b0-page` | `#ffffff`（**Light mode only**，暗色 token 已预留但禁用） |
| 侧边栏 | `--b0-sidebar` | `#2a2a38`；选中态 `--b0-sidebar-select` rgba(255,255,255,.05) |
| 卡片底 | `--grey-g01` | `#fafafa` |
| 边框 | `--line-l12` | 卡片默认；`--line-l3` 输入框/按钮；`--line-l9` hover/active |
| 间距 | `--spacing-xs/m/xl/xxl` | 8/16/24/28px（全刻度 2~56px） |
| 圆角 | `--radius-ct-s/l/xl` | 4/8/12px；按钮 `--radius-btn-m` 6px |
| 阴影 | `--shadow-xs/s/l` | 仅浮层（下拉/tooltip）可用 |
| 图表色 | `--chart-{orange1,green1,cyan1,blue1,purple1,...}-{main,1,2}` | 灰色系仅 ≥3 序列时用 |

## 3. 排版与全局规则

- **字体**：`"Delight", -apple-system, "OPPO Sans 4.0", BlinkMacSystemFont, sans-serif`。Delight TTF（Regular/Medium）下载入库本地伺服；**若授权不明则去掉 Delight 仅留系统栈**（待办，见 §7）。
- **字重铁律**：只允许 400/500；**≥24px 只允许 400**；600/700 禁止。
- **链接**：所有 `<a>` 必须 `target="_blank" rel="noopener noreferrer"`。
- **Playbook 页面滚动铁律**：`html { overflow: hidden }`，`<body>` 是唯一页级滚动容器；`.playbook-container` 等外层容器禁止 `overflow-y`；sticky 元素锚定 body 滚动上下文。滚动条全局隐藏。
- **`.playbook-container`**：`width:100%; margin:0 auto; padding: var(--spacing-s) var(--spacing-xxl) var(--spacing-xxxxl)`；≤768px 时 padding `--spacing-m`。
- **Hosted Shell 边界**：playbook iframe 内**不得**渲染应用级 chrome（标题/描述/更新时间/分享按钮由宿主详情页提供）；直接从第一个有用区块开始（tabs/KPI/图表/表格）。

## 4. 宿主域布局规范（依据截图）

### 4.1 全局框架

- 左侧 Sidebar 固定 300px、`--b0-sidebar` 深底、白字（文字用白色 alpha 系）；右侧主区 `--b0-page` 白底自适应。
- Sidebar 结构自上而下：Logo+折叠钮（高约 64px）→「+ New Chat」全宽白边框按钮 → 主导航（Explore / Portfolio / Skills，图标+文字，选中项 `--b0-sidebar-select` 圆角块）→ 分区标签「Playbooks」+ 条目列表（16px 圆形图标+名称，超出显示「⋯ More」）→ 分区「Chats」+ 历史会话 → 底部（升级横幅位，二期）→ 用户头像+用户名。

### 4.2 Chat 页

- 顶栏：会话标题居左（可下拉重命名），右侧分享/导出图标按钮。
- 消息流：居中，最大宽度 ~1200px；代码块 `--grey-g02` 底、等宽字体、圆角 `--radius-ct-l`；工具执行折叠卡片（状态行「Ran N commands」+ 可展开）；chart artifact 以内嵌 iframe 卡片呈现；路径/代码片段用 `--grey-g02` 行内底色。
- 输入区：底部悬浮大输入框（圆角 `--radius-ct-xl` 16px、`--line-l3` 边框、多行自适应）；左下「+」与技能图标按钮；右下模型选择器（无边框文字+chevron）+ 圆形发送按钮（`--main-m1` 底）。

### 4.3 Explore 页

- 大标题「Explore」（~40px，字重 400）。
- Featured hero 卡：全宽、白底、`--line-l12` 边框、圆角 `--radius-ct-xl`；左侧作者（头像 24px+名）、标题（~28px/400）、两行描述（`--text-n7`）、底行分类 tag（大写小字号 `--text-n5`）+ 👁 浏览数 + ⤨ remix 数；右侧预览图（约 40% 宽，圆角、边框）。
- 筛选行：左「Popular」排序下拉 + 分类 tab 胶囊（Asset Deepdive / Backtest / Smart Screener / Theme Tracker / AI Digest，`--grey-g02` 底、选中白底带边框）；右搜索框（圆角、放大镜图标）。
- 卡片网格：三列、间距 `--spacing-xl`；卡片=顶部预览截图（16:10 等比裁切）+ 标题（~20px/500）+ 两行截断描述（`--text-n7`）+ 底行（作者头像+名 | 👁 数 ⤨ 数，`--text-n5`）。hover 升 `--shadow-s`。

### 4.4 Playbook 详情页

- 顶部信息栏：标题+作者+版本号+changelog 入口；右侧「Remix」主按钮（`--main-m1` 实底、圆角 `--radius-btn-l`）+「Open」次按钮（白底 `--line-l3` 边框）。
- 主体：iframe 全宽嵌入 release HTML 快照；下方 README 折叠区。
- **2026-07-11 实现登记（fallback）**：一期已实现标题+作者+版本+浏览数、Open 次按钮、iframe 全宽嵌入（live URL 带 `?preview=1`，不计浏览数）、README `<details>` 折叠区、版本历史列表（changelog 入口的展开形态）。「Remix」主按钮随 Remix 流程留二期（Phase 6），届时补齐。

### 4.5 Agent 工作区（二期）与账户菜单

- 工作区 tabs：Chat / Tasks(N) / Alerts(N) / Memory / Files——下划线式 tab，选中 `--text-n9` + 2px 下划线。
- 账户菜单（头像弹出，白卡 `--shadow-l`）：用户名+套餐徽章（灰胶囊）+邮箱 → Usage 卡（`--grey-g01` 底：可用额度大数字 ~32px/400，右侧明细小字）→ 菜单项（图标+文字+chevron）→ 底部渠道图标按钮排。

## 5. 组件与部件（Playbook 域）

- 组件（Button/Tag/Dropdown/Tab/Table…）：以 `design-components.md`（1846 行）注册的 root class/变体/状态为准，样式由本地伺服的 design-system.css 提供，**不手写副本**。
- 数据部件（Metric Card / Chart Card / 表格/feed 列表…）：以 `design-widgets.md`（1507 行）为准；图表配色走 `--chart-*` 系。
- 一次性聊天图表 artifact：一个 Chart Card + 至多 1-2 个 KPI chip + source/as-of 注（含 `.alva-watermark` → 改为 `.openalva-watermark`）；禁止做成迷你 playbook。
- 交易策略型 playbook 整页结构：按 `design-playbook-trading-strategy.md`（901 行）。

## 6. 质量门禁

- 复刻官方 design linter：release 流水线内置 `openalva lint playbook <index.html>` 硬门禁，规则移植 `design-contract.yaml`（容器/滚动/排版/链接/组件注册检查）。lint 不过不得 release。
- 视觉验收：release 前截图（对照容器 padding、token 使用、无横向滚动）。

## 7. 待办与开放项

- [ ] Delight 字体授权确认；不明确则宿主域与 playbook 域统一退回系统字体栈。
- [ ] OpenAlva logo 与水印样式（暂用文字 logo，`--main-m1`）。
- [ ] 暗色主题：token 已预留（官方 dark 被禁用），跟随上游，暂不启用。
