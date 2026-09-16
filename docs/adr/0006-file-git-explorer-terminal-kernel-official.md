# 0006 — 终端内核易主:PTY 归官方 terminal-controller,抽屉外壳留在本插件

- 状态:已接受
- 日期:2026-09-16
- 关联词条:`CONTEXT.md` § file-git-explorer(终端抽屉 / 终端标题条 / 终止键 / 会话终端 / 屏幕快照 / 终端选中即复制 / 选区尾巴收敛 / 终端自动聚焦)
- 关联决策:ADR-0002(能用官方承载的就不自绘)
- 触发:用户口径 —— 「dsh 更新新版本了,这个版本原生支持在页签侧栏开终端,能否把那个终端放到我们 file_git 那个位置」
  (澄清后:位置 = 本插件现在放终端的那个 composer 下方抽屉位;要的是**官方那套终端**)

## 背景

新版本 DSH 自带一套官方终端,它是**两层**,而这两层的可复用性完全不同:

- **界面层** `@deepseek-ai/dsh-client-ui-sidebar-terminal`:只把 `TerminalBody` / `TerminalTitle` 注册进
  **官方右栏的槽**(`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title`、`sidebar.right.tab.guide.entry`),
  整包 `exports` 只有 `apply` / `inject`,**一个正文组件都没导出**;而且正文靠**宿主注入**的 `useTabInfo()`
  拿 tab 上下文 —— 那个 hook 由右栏的页签宿主提供。结论:**任何人都不可能把官方终端正文搬到别处渲染**
  (影子注册也拿不到它,槽的渲染权在宿主手里)。
- **内核层** `@deepseek-ai/dsh-api-terminal-controller`:一个**公开、有类型、React 无关**的 client 服务
  `ctx.webTerminals.view(sessionId, key, terminalId?, shellPath?) → TerminalView`,带
  `mount() / write() / resize() / rename() / close() / connect() / refresh() / acknowledge()` 与
  `state` 快照流(`snapshot` → `output` 两段帧)。PTY、shell 探测、进程归属、屏幕快照恢复、
  每会话配额(默认 `maxTerminals: 8`)、sandbox 对齐都在这一层。

本插件那套终端则是**自己写的一整条链**:host 侧 node-pty + 每工作区一个终端池(全局 16 槽 LRU)+
256KB 环形回放(绝对字节位寻址)+ `/fge/ws/terminal` 的裸 socket 升级(与 `ws` 手写握手);
client 侧 xterm + WS 控制帧 + 自管连接状态。它带着两处已经实测钉死的脆弱接缝:
`node-pty` / `ws` **只能从 profile 锚点解析**(从插件自身路径 require 一律 MODULE_NOT_FOUND),
以及一条只有本插件自己在跑的裸 socket 升级路径。

逐字满足"把官方那个终端放到抽屉位"只剩一条路:开一个官方 `terminal` 页签,再用
`ctx.sidebarRight.float(tabId, rect)` 把它浮起来、用 CSS 钉在 composer 带上。这条路被否掉的理由见下表 ——
而 ADR-0002 已经为"官方 float 没有移动/缩放接口、几何只能靠覆盖"付过一次代价。

## 决策

1. **内核归官方**:抽屉里的终端由 `ctx.webTerminals.view(sessionId, 'fge-dock')` 提供。
   PTY、shell 探测与校验、进程归属与清理、屏幕快照、配额全部归 terminal-controller;
   本插件不再 spawn 任何进程,也不再碰 `node-pty` / `ws`。
2. **外壳归本插件**:抽屉舌、宽度跟 composer 卡片、高度记忆(20%~70% 按工作区)、终端标题条、
   `×` 收起**不杀进程**、终止键、挂载时自动聚焦一次、选中即复制 + Alt+C 兜底 + 选区尾巴收敛 + 那枚开关 ——
   一条都不动。观感是本插件的,这点在触发条件里就已经接受了。
3. **帧桥照官方那套写**:`snapshot` 帧先 `term.reset()` + 按 `info.cols/rows` `resize` 再写屏,
   `output` 帧直接写;**两者都在 `term.write(..., cb)` 的回调里 `acknowledge(revision)`** ——
   这是官方流的背压契约(`consume` 会 await 这次 ack),漏掉它输出会停住。
4. **收起 ≠ 杀进程**:抽屉卸载只 detach(官方 view 本来就"DOM 卸载后仍存活"),
   终止键才 `view.close()`。轮换语义与旧实现逐字对齐。
5. **host 半删掉自研那一整层**:`lib/pty.js`、`/fge/ws/terminal` 升级路由、`resolveDep('node-pty'|'ws')`
   一并退场;**保留** `/fge/vendor/*` 白名单路由 —— xterm 仍由本插件自己渲染(浏览器种子表不含 xterm,
   这条绕行照旧)。

## 备选方案(被放弃的)

| 方案                                                | 放弃原因                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开官方 `terminal` 页签 + `float()` 钉在 composer 带 | 拿到的是官方正文本体,但浮窗不是抽屉:`float()` 没有移动/缩放已浮面板的接口(ADR-0002),高度拖拽只能覆盖 dockkit 浮窗 DOM;浮窗几何只在内存里,刷新后要重开重浮;浮起后页签离开页签条 —— **用一层架在官方内部结构上的 hack 换"正文是官方的"**,而正文组件本来就没导出 |
| 自绘沿用现在这套,只是照官方正文重写一遍             | 就是本决策(即"内核归官方、外壳归我们")                                                                                                                                                                                                                        |
| 保持自研 PTY 不动,官方终端留在右栏                  | 两套终端并存:官方那 8 个配额、屏幕快照恢复、shell 探测与沙箱对齐都拿不到;host 那两处依赖锚点接缝继续留着。而且用户要的是"放到抽屉位",不是"右栏多一个页签"                                                                                                     |
| 拆掉抽屉,只让官方终端在右栏                         | 同上 —— 位置相反,等于没做用户要的事                                                                                                                                                                                                                           |

## 后果

- **正面**:终端进程、shell 解析、进程清理、屏幕恢复全归官方(沙箱策略与 shell profile 覆盖随之统一);
  host 半少一个 10.9KB 的 `pty.js`、一条裸 socket 升级路径与两处 node-pty/ws 的锚点接缝;
  client 半少一台自管的连接状态机(官方 `phase` + `info.state` + `writable` 直接给)。
- **代价(已知并接受)**:
  - 终端从**每工作区一个 / 同工作区多会话共享**变成**每会话一个**(官方 view 归属 session),
    配额 8;切会话就是换一个终端。`CONTEXT.md` 的词条随之改写。
  - 终止键语义从"立刻杀整棵进程树"变成官方"请求结束进程"(后台清理,失败可在抽屉里重试)。
  - 重连从"自管 256KB 字节回放 + 绝对字节位寻址"变成官方 host 屏幕快照。
  - **观感仍是本插件那套**,不是官方那套终端 UI —— 官方正文组件未导出,拿不到,这是本决策的前提而非疏漏。
  - **client 半从此依赖那个服务**:`exports.inject` 里加了 `webTerminals`(与官方终端页签自己的
    `inject` 同一口径,它就是 `["slots","locale","sidebarRight","sidebarRightTabs","webTerminals","theme"]`)。
    于是官方 terminal-controller 缺席时, 本插件的 client 半会停在 pending、**git 页签也一起不出现** ——
    这是刻意选的失败模式: 缺失在装配期就显形, 而不是等用户点开抽屉才发现只有一半能用。
    该 controller 随 web bundle 常驻, 且与 `ui-sidebar-terminal` 各自独立挂载(关掉官方页签它仍在)。
- **守门**:离线护栏用**假 `ctx.webTerminals`**(可控帧流 + 假 state store)钉死帧桥契约 ——
  帧顺序与 ack 次数、输入 → `view.write`、fit → `view.resize`(夹在 `maxCols/maxRows`)、终止 → `view.close`;
  `verify-client-bundles` 另断言 client `inject` 含 `webTerminals`、host 不再注册 `/fge/ws/terminal`、
  假 ctx 提供该服务。真机验收走插件 README 验收清单里的终端项(起 shell、切主题就地换色、收起再展开仍连着、
  终止键结束进程、刷新页面重连补屏)。
