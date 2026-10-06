# dsh-session-monitor

DeepSeek Harness 的轻量**会话状态悬浮面板**：实时列出各会话、用颜色区分状态、必要时系统通知，可一键**外置为 OS 级置顶小窗**（不随 DSH 主窗口最小化而隐藏），点击行直达对应会话对话。

> A lightweight session-status HUD for DeepSeek Harness: live session list with color-coded states, system notifications when a session finishes or needs you, an optional always-on-top detached window that survives minimizing the app, and one-click jump to a session's conversation.

## 功能

| 功能 | 行为 |
| --- | --- |
| 会话列表 | 右上角悬浮卡列出会话（标题 / 状态点 / 状态文字 / 数量）。**默认只显示活跃会话**：运行中、待处理、已完成未读；点「全部」显示全部（含空闲/新会话），选择会被记住 |
| 颜色状态 | 🔵 运行中（品牌蓝**脉冲动画**：实心点 + 扩散光环）· 🟡 待处理（琥珀，等你审批/交互）· 🟢 已完成（绿，未读完成态约 45 秒后转灰）· ⚪ 空闲 / 新会话（灰） |
| 实时更新 | 订阅 Host 的 session 列表与统一状态流（Gateway control stream 推送，非轮询）；DSH 最小化时 renderer 不休眠，事件继续到达并推送进外置窗 |
| 通知 | 仅在**窗口不可见/未聚焦**时触发：某会话从运行中→完成、或出现待处理交互；每会话每类 60 秒冷却；系统通知不可用时回退应用内 Toast。铃铛按钮开关，记忆选择 |
| 外置独立窗 | 「外置」按钮按环境逐级回退：① Document Picture-in-Picture（OS 级置顶，web profile / Chrome 系可用）→ ② `window.open` 普通独立弹窗（桌面壳里 PiP 不可用时的退路：独立 OS 窗口、最小化不消失，但不置顶）→ ③ 应用内悬浮面板。外置窗内点击行同样跳转会话 |
| 点击跳转 | 点击行（应用内或外置窗）→ `uiWorkspace.openSession(id)` 选中该会话并展示对话，同时尝试把 DSH 主窗口提到前台 |
| 其他 | 面板可拖动（位置记忆）、可收起；纯 client 插件，host 半边为空载体 |

## 原理

```
lib/index.js    宿主半边：空 apply 载体（与官方 ui-open-in-app 同一模式）
lib/client.js   浏览器半边：面板 + PiP 外置窗 + 通知
locale/*.json   插件元信息（标题/简介）
cordis.patch.yml 把本包作为一行 insert 进 profile
```

- 数据来自官方 Client 服务：`ctx.sessions.list`（`SessionSummary`：`displayTitle/running/blank/updatedAt`）与可选的 `ctx.uiSession.sessionStatus`（`running/pendingInteraction/completionUnread`，sidebar 行同款状态源；缺失时用列表 running 字段 + 本地完成检测兜底）。
- UI 挂在官方扩展点 `shell.overlay`（Frame-wide floating layer），只注册、不替换任何官方组件。
- 状态点用官方原语 `StateDot`（done/warning/ongoing/error/idle），提示用 `Toast`，配色全部走 `--dsw-alias-*` 主题 token，深/浅色与换肤自动跟随。
- 外置窗走浏览器标准 API `documentPictureInPicture`（Chrome/Edge 116+；DSH 桌面版为本地 `127.0.0.1` 安全上下文）。小窗文档由主页面直接渲染与驱动，点击行走主页面域内的处理器，因此不需要任何 host 侧 HTTP 端点。
- host 半边只做一件事：注册回环探测路由 `GET /dsh-session-monitor/probe`，当两种浏览器级外置窗都失败时，报告宿主进程是否 Electron 主进程（决定能否做原生置顶窗）。

## 安装

从 GitHub 一键安装（其他机器/其他 profile）：

```sh
dsh plugin --profile desktop add "github:liugangnhm/dsh-session-monitor#main"
```

本地开发用 link 方式（改动即时生效，HMR 热更新）：

桌面版 profile 由 Electron 应用独占管理，请用设置里的**插件管理**安装本地路径（或命令行）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "$(Resolve-Path .)"
```

安装后**完全退出并重启 DSH**（新插件条目需要启动时的 client-modules 扫描才能进页面）；之后改代码走 HMR 热更新。

## 使用

- 面板默认在右上角；拖动标题栏移动，按钮依次为：通知开关 / 视图过滤（活跃 ⇄ 全部）/ 外置（收回）/ 收起（展开）。「活跃」视图只保留运行中、待处理、已完成未读的会话；空闲会话 45 秒未读窗口过后也会自动从默认视图消失。
- 外置窗：点「外置」弹出置顶小窗；最小化或切走 DSH，小窗照常置顶显示；点某行跳转到该会话。
- 想只看运行中的会话：待处理（黄）与运行中（蓝）永远排在最前。

## 兼容性与已知限制

- 依赖的公开契约：`shell.overlay`、`ctx.sessions.list`、`ctx.uiWorkspace.openSession`、`StateDot/Toast`、`documentPictureInPicture`（可选增强）。
- **外置窗在桌面壳里的现状**：Document PiP 在 DSH 桌面壳内会以 `Internal error: no window` 失败（浏览器半边运行在沙箱 iframe，PiP 找不到宿主窗口）。已加 `window.open` 独立弹窗回退——它是独立 OS 窗口、最小化 DSH 仍在，但不是置顶；若弹窗也被壳拦截，则保持应用内面板，失败 toast 会带上 host 探测结果（宿主是否 Electron 主进程），据此再决定是否上原生置顶窗方案。
- **系统通知**：依赖桌面版的通知通道；不可用时回退应用内 Toast。
- 点击跳转后，若 DSH 主窗口处于最小化，部分平台可能只闪烁任务栏而不自动还原（点击任务栏即可）。
- “错误态”暂不单独成色（客户端无现成的单会话错误状态源），留待后续版本。

## 开发自测

```bash
node test/client.test.mjs
```

在 Node 里以与 `@deepseek-ai/dsh-client-modules` 相同的方式载入 `lib/client.js`（捕获 `window.__ModuleLoader__.load` 注册、桩 React/原语/ctx），断言：注册位置与字典、行状态映射与排序、点击跳转调用、外置窗特性检测回退、离开时的通知触发与冷却。

## License

MIT
