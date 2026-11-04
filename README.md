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
| 外置独立窗 | 「外置」按钮按环境逐级回退：① **真 Electron 置顶窗**（桌面版：host 半边用壳自己的 Electron 启动本插件的窗口程序，frameless + 真 `WS_EX_TOPMOST`，不随 DSH 最小化）→ ② Document Picture-in-Picture（web profile / Chrome 系）→ ③ `window.open` 普通独立弹窗 → ④ 应用内悬浮面板。外置窗内点击行同样跳转会话 |
| 点击跳转 | 点击行（应用内或外置窗）→ `uiWorkspace.openSession(id)` 选中该会话并展示对话；**若 DSH 不在前台，由 host 半边请桌面壳自己把主窗口 `restore → show → focus`**（Electron 原生窗口 API）；已经在前台时不做任何窗口操作 |
| 其他 | 面板可拖动（位置记忆）、可收起；host 半边只负责外置窗、唤起主窗口与回环控制路由 |

## 原理

```
dsh-session-monitor/
├── package.json        # dsh 清单：bundle patch + client 平台 + 8 个注入模块
├── cordis.patch.yml    # insert 一行挂载
├── lib/index.js        # host 半边：外置窗启动 + 唤起主窗口（Electron 路径）+ 回环控制路由
├── lib/window-runtime.js # 为外置窗镜像一份壳的 Electron 运行时（硬链接，不复制 235MB）
├── lib/client.js       # 浏览器半边：面板（含子 agent 层级与透明度）+ 四级外置回退 + 通知
├── lib/window/         # 外置窗程序（真 Electron BrowserWindow：main / preload / renderer / shared）
├── locale/zh.json, en.json
├── README.md
└── test/client.test.mjs        # 浏览器半边离线断言
    test/host-check.mjs         # host 半边：路由、拒绝路径、唤起请求的进程边界（--run 真开窗）
    test/window-shared.test.mjs # 外置窗纯逻辑：状态映射 / 透明度护栏 / 行签名 / 边界夹取
    test/window-e2e.mjs         # 真 Electron 建窗：置顶位、尺寸、存活、不回声
    test/window-locale.test.mjs # 外置窗语言链路：代码字典 → locale JSON → 窗口字符串表
    test/window-origin.test.mjs # 外置窗轮询地址推导
    test/raise-e2e.mjs          # 真 Electron 第二实例 → restore/show/focus（端到端）
    test/smoke-server.mjs       # 冒烟用的假状态服务器
```

- 数据来自官方 Client 服务：`ctx.sessions.list`（`SessionSummary`：`displayTitle/running/blank/updatedAt`）与可选的 `ctx.uiSession.sessionStatus`（`running/pendingInteraction/completionUnread`，sidebar 行同款状态源；缺失时用列表 running 字段 + 本地完成检测兜底）。
- **子 agent 的来源**：官方 `projectList()` 会把子 agent 写进 `byId`（带 `parentId` 与 `origin: 'subagent'`），但**不一定放进 `ids`**。本插件因此遍历 `byId` 建树，而不是只走 `ids`——这正是子 agent 之前完全不显示的原因。`uiSession.sessionStatus` 的 id 集合本身取自 `byId`，所以子 agent 有完整的运行中/待处理/未读完成状态，不是粗略态。
- UI 挂在官方扩展点 `shell.overlay`（Frame-wide floating layer），只注册、不替换任何官方组件。
- 状态点用官方原语 `StateDot`（done/warning/ongoing/error/idle），提示用 `Toast`，配色全部走 `--dsw-alias-*` 主题 token，深/浅色与换肤自动跟随。
- **透明度**：整窗生效。外置窗用 Electron 的 `BrowserWindow.setOpacity`（真·整窗合成）、应用内面板与 PiP 窗用 CSS `opacity`，一次合成让内容与底色同比例变淡（实测文字峰值亮度按 0.500 / 0.252 精确缩放，说明确实在整层合成而非只淡背景）。持久化沿用 `localStorage`（`sm.opacity`、`sm.collapsedParents`），越界值在载入时被夹到 20%–100%。
- **滑杆不会被轮询拽回去**：外置窗每秒轮询一次状态，而「用户拖动 → host → 浏览器半边（最多 0.7s）→ 推回状态」这一圈更慢。若轮询无条件采纳 host 的旧值，用户一松手滑杆就被拉回原位（这正是修掉的那个 bug）。所以窗口用 `Set-LocalOpacity`/`acceptsRemoteOpacity` 记住自己刚设的值：在 host 追上或超过 4 秒放弃之前，轮询不动滑杆与窗口。两次实测对比：无该守卫时滑杆在 6 次轮询后回到 `1`，有守卫时稳定停在 `0.35`。
- **外置窗是一个真正的 Electron `BrowserWindow`**：浏览器半边在桌面壳的沙箱 iframe 里，Document PiP 报 `Internal error: no window`、`window.open` 被拦；Host 又只是 Electron 主进程的 node 子进程（`require('electron')` 解析不到，拿不到 `BrowserWindow`）。所以窗口改成由**壳自己的 Electron 可执行文件**再启动一次，指向一份临时镜像运行时，其 `resources/app` 就是本插件的 `lib/window`（`lib/window-runtime.js`）。于是窗口的显示/隐藏/最大化/还原/置顶/整窗透明度**全部是 Electron 自己的窗口 API**，不再有任何 Win32 调用。
  - 镜像用**硬链接**建（同卷不复制字节），所以既不占额外 235MB，也不改动已安装的应用；跨卷时才退回复制。
  - 必须剔除继承来的 `ELECTRON_RUN_AS_NODE`，否则子进程跑成 Node，永远建不出窗口。
  - 必须给独立的 `--user-data-dir`，否则会和真实应用抢同一个 Chromium 缓存目录。
  - 配置走**文件**（`--config`）而不是命令行：实测 `-- --origin http://…` 会被 Chromium 当成它自己的开关，页面直接 `ERR_FAILED`，窗口永远不出现。
  - 通信沿用原来的回环 HTTP 协议（`/state`、`/pending`、`/consume`、`/command`、`/open`）和 stdout 协议行，所以 host 的去重漏斗与队列一行没改。窗口连续 10 次拉取失败会自闭（host 消失时不留孤儿窗口）。
  - 旧实现是 `child_process.spawn` 一个 PowerShell WPF 窗口（`lib/window.ps1`，303 行，含自绘 ×/滑杆/置顶）。它已删除：控窗 API 用的是 WPF 而不是 Electron，正是用户报的闪屏/无效的来源。
  - **语言跟随应用设置**：窗口的文字由 host 写进 `strings.json`，而语言 id 只来自浏览器半边的 `ctx.locale.getLocale().active`。host 是纯 Node 子进程，桌面壳**不导出任何 locale 环境变量**（实测 `DSH_LOCALE` / `LANG` 在 Windows 上都是空的），所以早先按环境变量猜的写法会让中文用户的窗口显示英文。窗口按钮的 tooltip 与无障碍名称也走同一张表，不留硬编码英文。
- **两路传输必须收敛成一次事件**：窗口刻意把每次交互同时发两遍（stdout 协议行 + HTTP POST），这样管道断了也不会让按钮静默失效。两条都会落到 host，所以 host 是唯一能把这一对折回成一次事件的地方——`acceptWindowReport()` 就是这个漏斗，并按「事件种类 + 目标 + 300ms 窗口」去重。**这不是锦上添花**：行点击是幂等的，但**开关类**操作被应用两次就自己抵消，按钮看起来完全没反应（修复前实测：一次 ▼ 点击排出 `["p-1","p-1"]`）。不同的父项、以及用户真正再点一次，都不受影响。
- **唤起主窗口走 Electron 自己的 API**：`window.focus()` 对另一个 OS 窗口无效（浏览器半边在沙箱 iframe 里），而 host 半边只是 Electron 主进程的 Node 子进程，`require('electron')` 解析不到、也拿不到 `BrowserWindow`。所以这里**不再自己操作窗口**——旧实现的 `focus.ps1` 用 `ShowWindow`/`SetForegroundWindow` 从外部进程抢前台，既受 Windows 前台锁限制（被拒绝时窗口留在原处，“点了没反应”），又会重新声明边框与 z 序（用户看到的闪屏）。
  现在行点击只做一件事：host 半边用**桌面壳自己的可执行文件**再启动一次并带上 `dsh://open`。运行中的实例持有单实例锁，新进程立刻退出，然后运行中的实例执行它本来就会对“第二次启动”执行的那段：
  `if (window.isMinimized()) window.restore(); window.show(); window.focus();`
  这三步都是 Electron 的 `BrowserWindow` API，由**拥有窗口的那个进程**调用，所以不需要任何前台抢夺手法。实测事件顺序是 `restore → show → focus`，没有 `maximize/unmaximize`，窗口不动时也不会被重新声明。
  - 本机对**真实运行的 DSH** 实测三种起始状态（都是同一条路径，不需要分支）：已在前台 → 状态不变；最小化（`IsIconic=True`）→ `IsIconic=False` 且重新在前台；托盘隐藏（`visible=False iconic=False`）→ `visible=True` 且重新在前台。后者正是旧 `focus.ps1` 需要专门处理、且曾经报「no app window found」的那种状态。
  - 代价是每次唤起都会起一个**短命**的启动器进程（约 0.5s，用完即退，不会留下第二份应用）。这比外部进程抢前台更可靠，也不会改变窗口边框/z 序。
  - 启动子进程前必须清掉继承来的 `ELECTRON_RUN_AS_NODE`（host 半边自己就是带着这个变量跑的）。不清的话子进程会当成 Node 跑，永远到不了 Electron，“窗口没反应”的就是这个原因。
  - 超时不再杀进程：如果调用瞬间应用恰好已经退出，这一次启动**就是**应用本身，杀掉它等于把用户刚要的窗口关掉。所以超时只如实报告「请求没送达」。
  - 已在前台时就**根本不发请求**：浏览器半边在本文档已持有焦点时直接返回（应用内面板被点击 ⇒ 应用本来就是前台窗口；最小化或被盖住的窗口点不到）。外置窗是另一个文档，仍会发。
- web profile / 非 Windows：路由答 `ok:false`，自动回退 Document PiP → `window.open` 弹窗 → 应用内面板；唤起请求也明确回答「不是桌面壳（没有 Electron 运行时）」/「仅 Windows」，不报错、不做无效动作。
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

> 改 **host 半边**（`lib/index.js`、`lib/window-runtime.js`、`lib/window/*`）需要重启 DSH 才生效：host 半边是启动时加载的 node 进程，没有 HMR。只改 `lib/client.js` 时页面内热更新即可，但**新路由**同样要等 host 重启。

## 使用

- 面板默认在右上角；拖动标题栏移动，按钮依次为：通知开关 / 视图过滤（活跃 ⇄ 全部）/ 外置（收回）/ 收起（展开）。「活跃」视图只保留运行中、待处理、已完成未读的会话；空闲会话 45 秒未读窗口过后也会自动从默认视图消失。
- **子 agent**：带子 agent 的会话标题后会跟一个数量（如「某会话 ·2」）与 ▼；点子 agent 行会直接打开那个子 agent 的会话。点 ▼ 折叠成 ▶，子 agent 行收起来，数量仍在，折叠状态下次启动保持。
- **透明度**：拖底部滑杆即可，百分比实时显示，**整个窗口一起变透（文字也跟着变淡）**。松手即保存，重启 DSH 后仍是这个值。
- 外置窗：点「外置」弹出置顶小窗；最小化或切走 DSH，小窗照常置顶显示；点某行跳转到该会话**并把 DSH 还原到前台**。
- **外置窗自己的窗口控制**：右上角依次是 `—` 最小化、`□` 最大化/还原（双击标题栏同效）、`×` 关闭；拖动标题栏移动，右下角可缩放。位置与大小会被记住，下次打开回到原处（若原来那块显示器已拔掉，会自动挪回可见区域）。全部走 Electron 的 `BrowserWindow` API。
- 想只看运行中的会话：待处理（黄）与运行中（蓝）永远排在最前。

## 兼容性与已知限制

- 依赖的公开契约：`shell.overlay`、`ctx.sessions.list`、`ctx.uiWorkspace.openSession`、`StateDot/Toast`、`documentPictureInPicture`（web profile 增强）。
- **子 agent 状态粒度**：优先取官方统一状态源（子 agent 也在其中，故有运行中/待处理/未读完成）。host 端只为「外置窗里那些没有真实 summary 的投影条目」退化成 `running`/空闲两态，`updatedAt` 为 0 时排序按原有规则处理。
- **桌面壳的外置窗路径**：浏览器半边在桌面壳的沙箱 iframe 里，Document PiP 报 `Internal error: no window`、`window.open` 被拦——桌面版由 host 半边启动一个**真 Electron 窗口**（无边框、半透明、置顶，靠顶部条拖动、右下角缩放、右上角 × 或面板「收回」关闭；连续 10 秒拉不到状态会自闭）。外观走应用的深色配色；若启动失败，回退链退到 PiP/弹窗/应用内面板，失败 toast 带完整原因。
- **置顶不能只信 Electron 的 getter**：实测 44.7.0 上 `alwaysOnTop: true` 与 `setAlwaysOnTop(true)` 都会让 `isAlwaysOnTop()` 报 true，但窗口的 `WS_EX_TOPMOST` 位其实是**空的**——窗口看起来能置顶，实际会被别的窗口盖住。所以窗口按 `screen-saver → pop-up-menu → normal` 逐个尝试并读回 getter 验证，选定能生效的那个级别；`show`/`restore`/`focus` 之后会重新断言（Windows 会借这些时机清掉置顶位）。e2e 直接从 Win32 读该位，不采信应用自己的说法。
- **唤起主窗口的平台约束**：插件不抢前台，只请桌面壳再启动一次（`dsh://open`），由 Electron 在拥有窗口的进程里执行 `restore → show → focus`。最小化与托盘隐藏两种状态都走同一条路径，因为 `restore()` + `show()` 一起覆盖了两者；窗口是否真的到了最前仍由 Windows 前台策略决定，但进程内调用不再触发旧的「外部抢前台被拒 → 窗口没动」。
- **后台提示灯的取舍**：应用在托盘时 renderer 不会休眠，所以外置窗与通知仍工作。旧实现里「点击会话把应用藏进托盘」的未知现象随 `focus.ps1` 一起移除（那段代码不再存在）；现在这条路径只有「再启动一次应用」，即应用自身的单实例行为。
- **系统通知**：依赖桌面版的通知通道；不可用时回退应用内 Toast。
- 「错误态」暂不单独成色（客户端无现成的单会话错误状态源），留待后续版本。

## 开发自测

```bash
node test/client.test.mjs         # 浏览器半边离线断言
node test/host-check.mjs          # host 半边：路由、拒绝路径、唤起请求的进程边界（--run 真开窗）
node test/window-shared.test.mjs  # 外置窗纯逻辑：状态映射、透明度护栏、行签名、边界夹取
node test/window-e2e.mjs          # 真 Electron 建窗：置顶位、尺寸、存活、不回声
node test/window-locale.test.mjs  # 外置窗语言链路（防止窗口退回英文）
node test/window-origin.test.mjs  # 外置窗轮询地址推导（含沙箱帧 "null" 回归）
node test/raise-e2e.mjs           # 真 Electron 第二实例 → restore/show/focus（端到端）
```

- `client.test.mjs`：以与 `@deepseek-ai/dsh-client-modules` 相同的方式载入 `lib/client.js`（捕获 `window.__ModuleLoader__.load`、桩 React/原语/ctx），断言注册位置与字典、行状态映射与排序、活跃/全部过滤、点击跳转、面板默认隐藏与侧边栏入口、外置失败诊断 toast、快照推送与队列消费，以及离开时的通知触发。另含几组新断言：**子 agent 只出现在 `byId` 时也能进面板**（含缩进、独立状态、折叠记忆与「折叠的空闲父项不被活跃过滤误删」）、**被折叠藏起来的子 agent 完成时照样通知**、**透明度可调/被夹取/下次启动恢复**（用真会读写的存储桩 + 真正重启实例，而不是只重渲染）、**行点击的唤起请求会按焦点状态决定发不发**（已在前台时不发，避免无谓地再启动一次应用；隐藏文档或无法报告焦点的环境一律发，宁多一次请求也不漏拉窗口），以及 **PiP 窗口与面板拿的是同一个透明度、同样渲染子 agent 缩进**（PiP 是另一套 DOM 渲染路径，最容易悄悄掉队）。还守住 `locale/*.json` 与代码字典逐键一致（这条检查当年就发现了一个从未被引用的死键）。
- `host-check.mjs`：用桩 Cordis 上下文驱动真实 `apply()`，断言八条路由注册、非回环调用被拒、错误方法/畸形请求体返回 4xx，并守住一条真实事故——`windowWorkDirectory()` 把变量当函数调，导致每次开窗都 400、窗口永不出现（`--run` 时真开窗并核对进程存在）。另有**两路传输去重**一组：把同一次交互按窗口的做法发两遍，断言只排进一次、排空后队列干净、用户再点一次仍然生效、不同父项互不掩盖——这条守住的正是「开关被应用两次 → 按钮看起来完全没反应」。唤起主窗口那组则在**进程边界**上断言：只启动一次、参数只有 `dsh://open`、**必须剔掉 `ELECTRON_RUN_AS_NODE`**（否则子进程跑成 Node，永远到不了 Electron）、零退出即 Electron 路径、非零退出带原因、超时**不杀进程**（那可能是刚成为应用的自己）。
- `window-shared.test.mjs`：外置窗的纯逻辑（`lib/window/shared.js`，被主进程、渲染层和测试三方共用）。这些规则以前埋 PowerShell 里，只能靠真开窗验证。守住的每条都对应一个用户能看见的缺陷：**状态映射**（未知状态必须退到 idle，否则整行渲染抛异常 → 空白窗）、**透明度护栏**（用户刚拖完滑杆时，host 推回的旧值不许把滑杆拽回去，4 秒后自动解除）、**行签名**（快照没变就不重建列表；状态/层级/子 agent 数/折叠/过滤任一变化才重建——这是不闪屏的核心）、**边界夹取**（上次的窗口位置可能落在已拔掉的显示器上，也不能小到无法抓取）。
- `window-e2e.mjs`：**真开一个 Electron 窗口**（壳的运行时 + 本插件 `lib/window`，与生产同一条路径），然后从 **Win32 侧**读回事实：窗口存在、可见、`WS_EX_TOPMOST` 真的置位、标题非空、尺寸不小于最小值。后面还守着两个真实回归：窗口不能在 `ready` 之后自杀（曾把 host 的 `open` 标志当成"该退出了"，而那个标志要等 host 读完 `ready` 行才为真），以及不能每秒重复上报同一个透明度（两半曾因此无限对打）。
- `window-origin.test.mjs`：锁住「沙箱帧报 `null` 时必须回退到请求 Host 头」——不然窗口会去拉 `null/...`，十次失败后被孤儿守卫关掉。
- `raise-e2e.mjs`：用**真的 Electron**（硬链接一份已安装的运行时到临时目录，绝不碰用户的 DSH 窗口）启动一个实现了同样 `second-instance` 处理的宿主，把自己的窗口最小化，然后调用生产代码里的 `raiseAppWindow()`。断言：运行中的实例收到唤起、`restore()` 让 `isMinimized()` 变回 false、`show()` 让窗口可见。聚焦由 Windows 前台策略决定，只作为诊断信息打印、不当硬断言。它还故意把 `ELECTRON_RUN_AS_NODE=1` 原样传进去——这正是生产路径上最容易犯的错，**如果实现没有剔掉这个变量，子进程会跑成 Node，整个检查会以「窗口仍然最小化」失败**。

## License

MIT
