# dsh-session-monitor

DeepSeek Harness 的轻量**会话状态悬浮面板**：实时列出各会话及其**子 agent**、用颜色区分状态、**整体透明度可调并自动记忆**、必要时系统通知，可一键**外置为 OS 级置顶小窗**（不随 DSH 主窗口最小化而隐藏），点击行直达对应会话对话**并把最小化的 DSH 拉回前台**。

> A lightweight session-status HUD for DeepSeek Harness: live sessions and their sub-agents with color-coded states, an adjustable background opacity that is remembered, system notifications when a session finishes or needs you, an optional always-on-top detached window that survives minimizing the app, and one-click jump to a session that also restores and foregrounds the app.

## 功能

| 功能 | 行为 |
| --- | --- |
| 会话列表 | 右上角悬浮卡列出会话（标题 / 状态点 / 状态文字 / 数量）。**默认只显示活跃会话**：运行中、待处理、已完成未读；点「全部」显示全部（含空闲/新会话），选择会被记住 |
| 子 agent | 会话里跑的**子 agent 缩进列在其父会话下方**，各自带独立状态点与状态文字；父项左侧 ▼/▶ 可折叠展开，折叠状态与透明度一样被记住。折叠中的空闲父项若藏着活跃子 agent，仍会保留在「活跃」视图里——否则子 agent 会跟着父项一起消失 |
| 整体透明度 | 底部滑杆调整**整个面板**的透明度（20%–100%）：背景、文字、状态点、按钮一起变透，不会出现「字很亮、底板很淡」的割裂感。设置自动保存，下次启动自动恢复。应用内面板、置顶小窗、PiP 窗口三处共用同一个值 |
| 颜色状态 | 🔵 运行中（品牌蓝**脉冲动画**：实心点 + 扩散光环）· 🟡 待处理（琥珀，等你审批/交互）· 🟢 已完成（绿，未读完成态约 45 秒后转灰）· ⚪ 空闲 / 新会话（灰） |
| 实时更新 | 订阅 Host 的 session 列表与统一状态流（Gateway control stream 推送，非轮询）；DSH 最小化时 renderer 不休眠，事件继续到达并推送进外置窗 |
| 通知 | 仅在**窗口不可见/未聚焦**时触发：某会话从运行中→完成、或出现待处理交互；每会话每类 60 秒冷却；系统通知不可用时回退应用内 Toast。铃铛按钮开关，记忆选择 |
| 外置独立窗 | 「外置」按钮按环境逐级回退：① **PowerShell WPF 置顶窗**（桌面版：host 半边 spawn，frameless + Topmost，不随 DSH 最小化）→ ② Document Picture-in-Picture（web profile / Chrome 系）→ ③ `window.open` 普通独立弹窗 → ④ 应用内悬浮面板。外置窗内点击行同样跳转会话 |
| 点击跳转 | 点击行（应用内或外置窗）→ `uiWorkspace.openSession(id)` 选中该会话并展示对话；**同时由 host 半边把 DSH 主窗口从最小化还原并提到前台** |
| 其他 | 面板可拖动（位置记忆）、可收起；host 半边只负责外置窗、窗口前置与回环控制路由 |

## 原理

```
dsh-session-monitor/
├── package.json        # dsh 清单：bundle patch + client 平台 + 8 个注入模块
├── cordis.patch.yml    # insert 一行挂载
├── lib/index.js        # host 半边：PowerShell 置顶窗 + 窗口前置 + 回环控制路由
├── lib/client.js       # 浏览器半边：面板（含子 agent 层级与透明度）+ 四级外置回退 + 通知
├── lib/window.ps1      # 外置窗程序（WPF：半透明面板、子 agent 缩进、透明度滑杆）
├── lib/focus.ps1       # 窗口前置：SW_RESTORE + SetForegroundWindow
├── locale/zh.json, en.json
├── README.md
└── test/client.test.mjs        # 浏览器半边离线断言
    test/host-check.mjs         # host 半边：路由与拒绝路径（--run 真开窗/真还原窗口）
    test/window-check.mjs       # 外置窗脚本：BOM / 5.1 解析 / 各态与层级行渲染 / 点击带 id
    test/window-origin.test.mjs # 外置窗轮询地址推导
    test/focus-e2e.mjs          # 真开一个窗口 → 最小化 → 走 focus.ps1 还原（端到端）
    test/smoke-server.mjs       # 冒烟用的假状态服务器
```

- 数据来自官方 Client 服务：`ctx.sessions.list`（`SessionSummary`：`displayTitle/running/blank/updatedAt`）与可选的 `ctx.uiSession.sessionStatus`（`running/pendingInteraction/completionUnread`，sidebar 行同款状态源；缺失时用列表 running 字段 + 本地完成检测兜底）。
- **子 agent 的来源**：官方 `projectList()` 会把子 agent 写进 `byId`（带 `parentId` 与 `origin: 'subagent'`），但**不一定放进 `ids`**。本插件因此遍历 `byId` 建树，而不是只走 `ids`——这正是子 agent 之前完全不显示的原因。`uiSession.sessionStatus` 的 id 集合本身取自 `byId`，所以子 agent 有完整的运行中/待处理/未读完成状态，不是粗略态。
- UI 挂在官方扩展点 `shell.overlay`（Frame-wide floating layer），只注册、不替换任何官方组件。
- 状态点用官方原语 `StateDot`（done/warning/ongoing/error/idle），提示用 `Toast`，配色全部走 `--dsw-alias-*` 主题 token，深/浅色与换肤自动跟随。
- **透明度**：整窗生效。外置窗用 WPF 的 `Window.Opacity`、应用内面板与 PiP 窗用 CSS `opacity`，一次合成让内容与底色同比例变淡（实测文字峰值亮度按 0.500 / 0.252 精确缩放，说明确实在整层合成而非只淡背景）。持久化沿用 `localStorage`（`sm.opacity`、`sm.collapsedParents`），越界值在载入时被夹到 20%–100%。
- **滑杆不会被轮询拽回去**：外置窗每秒轮询一次状态，而「用户拖动 → host → 浏览器半边（最多 0.7s）→ 推回状态」这一圈更慢。若轮询无条件采纳 host 的旧值，用户一松手滑杆就被拉回原位（这正是修掉的那个 bug）。所以窗口用 `Set-LocalOpacity`/`Accepts-RemoteOpacity` 记住自己刚设的值：在 host 追上或超过 4 秒放弃之前，轮询不动滑杆与窗口。两次实测对比：无该守卫时滑杆在 6 次轮询后回到 `1`，有守卫时稳定停在 `0.35`。
- **外置窗**：浏览器半边在桌面壳的沙箱 iframe 里，Document PiP 报 `Internal error: no window`、`window.open` 被拦；Host 又只是 Electron 主进程的 node 子进程（`require('electron')` 解析不到）。所以桌面版由 host 半边 `child_process.spawn` 一个 **PowerShell WPF 置顶窗**（frameless、`Topmost`、`AllowsTransparency` 半透明面板、可拖动可缩放、× 关闭；脚本写入时带 UTF-8 BOM，5.1 才不乱码）。通信走回环 HTTP 路由：浏览器半边推送会话快照（`POST /dsh-session-monitor/state`），窗口每秒轮询读取（`GET`），行点击 POST 到 `/dsh-session-monitor/open` 进入队列，浏览器半边轮询消费（`GET /dsh-session-monitor/pending` → `uiWorkspace.openSession`）。窗口连续 10 次拉取失败会自闭（host 消失时不留孤儿窗口）；窗口被 × 关闭也会通知 host 同步状态。
- **两路传输必须收敛成一次事件**：窗口刻意把每次交互同时发两遍（stdout 协议行 + HTTP POST），这样管道断了也不会让按钮静默失效。两条都会落到 host，所以 host 是唯一能把这一对折回成一次事件的地方——`acceptWindowReport()` 就是这个漏斗，并按「事件种类 + 目标 + 300ms 窗口」去重。**这不是锦上添花**：行点击是幂等的，但**开关类**操作被应用两次就自己抵消，按钮看起来完全没反应（修复前实测：一次 ▼ 点击排出 `["p-1","p-1"]`）。不同的父项、以及用户真正再点一次，都不受影响。
- **窗口前置**：`window.focus()` 对另一个 OS 窗口无效（浏览器半边在沙箱 iframe 里），而 COM 的 `WScript.Shell.AppActivate` 会报成功却让**最小化**窗口继续最小化（实测）。所以行点击时 host 半边 spawn `lib/focus.ps1`，脚本沿**自己的进程祖先链**找到拥有主窗口的进程（host 半边正是它的子进程），用 `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` 还原并置前，必要时退到 `AttachThreadInput` 那套前台夺取手法。匹配限定在应用自身的窗口类，因此外置窗自己（`HwndWrapper[...]`）永远不会被误当成目标。同一时刻最多一个 helper；超时即杀，插件卸载时一并清理。
- web profile / 非 Windows：路由答 `ok:false`，自动回退 Document PiP → `window.open` 弹窗 → 应用内面板；窗口前置请求也被拒绝而不报错。
- `lib/index.js` 同时承担空载体职责：让 Loader 树里有条目，浏览器半边才能被发现并送进页面。

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

> 改 **host 半边**（`lib/index.js`、`lib/window.ps1`、`lib/focus.ps1`）需要重启 DSH 才生效：host 半边是启动时加载的 node 进程，没有 HMR。只改 `lib/client.js` 时页面内热更新即可，但**新路由**同样要等 host 重启。

## 使用

- 面板默认在右上角；拖动标题栏移动，按钮依次为：通知开关 / 视图过滤（活跃 ⇄ 全部）/ 外置（收回）/ 收起（展开）。「活跃」视图只保留运行中、待处理、已完成未读的会话；空闲会话 45 秒未读窗口过后也会自动从默认视图消失。
- **子 agent**：带子 agent 的会话标题后会跟一个数量（如「某会话 ·2」）与 ▼；点子 agent 行会直接打开那个子 agent 的会话。点 ▼ 折叠成 ▶，子 agent 行收起来，数量仍在，折叠状态下次启动保持。
- **透明度**：拖底部滑杆即可，百分比实时显示，**整个窗口一起变透（文字也跟着变淡）**。松手即保存，重启 DSH 后仍是这个值。
- 外置窗：点「外置」弹出置顶小窗；最小化或切走 DSH，小窗照常置顶显示；点某行跳转到该会话**并把 DSH 还原到前台**。
- 想只看运行中的会话：待处理（黄）与运行中（蓝）永远排在最前。

## 兼容性与已知限制

- 依赖的公开契约：`shell.overlay`、`ctx.sessions.list`、`ctx.uiWorkspace.openSession`、`StateDot/Toast`、`documentPictureInPicture`（web profile 增强）。
- **子 agent 状态粒度**：优先取官方统一状态源（子 agent 也在其中，故有运行中/待处理/未读完成）。host 端只为「外置窗里那些没有真实 summary 的投影条目」退化成 `running`/空闲两态，`updatedAt` 为 0 时排序按原有规则处理。
- **桌面壳的外置窗路径**：浏览器半边在桌面壳的沙箱 iframe 里，Document PiP 报 `Internal error: no window`、`window.open` 被拦——桌面版由 host 半边 spawn PowerShell WPF 置顶窗（frameless，靠顶部条拖动、右下角缩放、右上角 × 或面板「收回」关闭；连续 10 秒拉不到状态会自闭）。外观是系统 WPF 风格而非应用主题色；若 spawn 失败（极少见），回退链退到 PiP/弹窗/应用内面板，失败 toast 带完整原因。
- **窗口前置的平台约束**：`SetForegroundWindow` 受 Windows 前台策略限制——当前前台进程不是 DSH 时，系统可能拒绝把窗口提到最前。实测「最小化 → 还原并置前」稳定可用（本机 Win11 已验证），必要时脚本会退到 `AttachThreadInput` 手法；若仍被系统拒绝，脚本会在返回值里如实报告 `background` 而不是假装成功。
- **系统通知**：依赖桌面版的通知通道；不可用时回退应用内 Toast。
- 「错误态」暂不单独成色（客户端无现成的单会话错误状态源），留待后续版本。

## 开发自测

```bash
node test/client.test.mjs         # 浏览器半边离线断言
node test/host-check.mjs          # host 半边：路由、拒绝路径（--run 真开窗 + 真还原窗口）
node test/window-check.mjs        # 外置窗脚本：BOM、5.1 解析、各态与层级行渲染、点击带 id（--run 验 READY 握手）
node test/window-origin.test.mjs  # 外置窗轮询地址推导（含沙箱帧 "null" 回归）
node test/focus-e2e.mjs           # 真开窗口 → 最小化 → 经 focus.ps1 还原（端到端）
```

- `client.test.mjs`：以与 `@deepseek-ai/dsh-client-modules` 相同的方式载入 `lib/client.js`（捕获 `window.__ModuleLoader__.load`、桩 React/原语/ctx），断言注册位置与字典、行状态映射与排序、活跃/全部过滤、点击跳转、面板默认隐藏与侧边栏入口、外置失败诊断 toast、快照推送与队列消费，以及离开时的通知触发。另含几组新断言：**子 agent 只出现在 `byId` 时也能进面板**（含缩进、独立状态、折叠记忆与「折叠的空闲父项不被活跃过滤误删」）、**被折叠藏起来的子 agent 完成时照样通知**、**透明度可调/被夹取/下次启动恢复**（用真会读写的存储桩 + 真正重启实例，而不是只重渲染）、**行点击会请求 host 还原窗口**，以及 **PiP 窗口与面板拿的是同一个透明度、同样渲染子 agent 缩进**（PiP 是另一套 DOM 渲染路径，最容易悄悄掉队）。还守住 `locale/*.json` 与代码字典逐键一致（这条检查当年就发现了一个从未被引用的死键）。
- `host-check.mjs`：用桩 Cordis 上下文驱动真实 `apply()`，断言八条路由注册、非回环调用被拒、错误方法/畸形请求体返回 4xx，并守住一条真实事故——`windowWorkDirectory()` 把变量当函数调，导致每次开窗都 400、窗口永不出现（`--run` 时真开窗并核对进程存在）。另有**两路传输去重**一组：把同一次交互按窗口的做法发两遍，断言只排进一次、排空后队列干净、用户再点一次仍然生效、不同父项互不掩盖——这条守住的正是「开关被应用两次 → 按钮看起来完全没反应」。`--run` 另含窗口前置：拿一个**临时窗口**（绝不动用户自己的 DSH 窗口）最小化后交给 `lib/focus.ps1`，断言它真的被还原。
- `window-check.mjs`：直接读 `lib/window.ps1`（脚本已独立成文件，不再从 JS 里抠字符串）。守住几件事：**BOM 必须存在**（5.1 按 ANSI 读无 BOM 的 .ps1，中文全乱码）、五种状态都能构建行（`RepeatMode` 在 PowerShell 里设不了，曾让 running 行抛异常被 catch 吞掉 → 空白窗 + 自闭）、父项/折叠父项/子行三种层级行也都能构建、点击落在子元素上仍能把 id 带上（`MouseLeftButtonUp` 是直接路由事件，不冒泡）、透明度作用在 `$window.Opacity` 整窗而非某个画刷、**轮询移动滑杆不会被当成用户操作回传**（否则两半会互相覆盖同一个值），以及**用户自己的值在 host 追上之前不被轮询覆盖**（否则滑杆一松手就弹回原位）。
- `window-origin.test.mjs`：锁住「沙箱帧报 `null` 时必须回退到请求 Host 头」——不然窗口会去拉 `null/...`，十次失败后被孤儿守卫关掉。
- `focus-e2e.mjs`：端到端跑一遍真实路径——开一个窗口、调 Win32 把它最小化、调用 `lib/focus.ps1`，断言返回 `restored` 且窗口真的不再最小化，同时确认 host 半边的 `/focus` 路由已注册且永远不以 TypeError 作答（这条路由在每次点击行时都会被调用）。

## License

MIT
