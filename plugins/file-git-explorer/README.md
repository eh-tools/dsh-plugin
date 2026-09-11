# dsh-file-git-explorer

官方**右侧栏**里的 Git 页签 + 详情悬浮面板 + 对话下方的终端抽屉。

- **Git 页签**(kind `fge-git`, docked 常驻): 当前分支 + 上游 `↑ahead ↓behind` 徽标、**变更列表**、
  **提交历史**(可切「查看分支」/ 分页); 点一条提交**就地展开**它的文件(带 ±行数), 页签内没有「返回」;
  点任一文件 → diff 进**悬浮面板**。
- **详情悬浮面板**: 视口 1/2 宽、满高、紧贴右栏左缘。承载两种东西 —— 官方**文档正文**(官方文件树点开、
  聊天里的文件链接), 与本插件的 **diff**。同一时间只有一个, 开新的先关旧的, 观感即「就地换内容」。
  文件内容**不自己渲染**: 本插件只是把官方正文页签 `ctx.sidebarRight.float()` 起来, 于是
  markdown / 代码 / 图片 / html / **pdf 全部是官方原版**; diff 用官方 `primitives.DiffBlock`。
- **终端抽屉**(kind 无, 座位 `conversation.composer.dock`): **真 PTY** —— `node-pty` ↔ WebSocket ↔
  `xterm.js`, 所以 vim / htop / 颜色 / 补全 / Ctrl+C 全部可用。收起态是 composer 下方一枚居中的透明
  chevron, 点击**向上**展开。终端只有这一种形态(没有右栏终端页签)。
- 文件树**回归官方**: 本插件既不接管、也不自绘文件树。

静态双半插件(host + client bundle), 随 web profile 启动自动加载。

## 安装

```bash
dsh plugin --profile web add link:<repo-abs-path>/plugins/file-git-explorer
```

host 半随 DSH 启动自动挂载; 浏览器 bundle 由 profile 注入, 刷新 GUI 页面生效。
卸载用 `dsh plugin --profile web remove dsh-file-git-explorer`。

### 依赖

| 依赖                               | 来源                | 说明                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@xterm/xterm`、`@xterm/addon-fit` | 本包 `dependencies` | 终端前端。**必须由本包自带** —— 浏览器模块表(seed)是一份封闭的 9 项名单, 不含 xterm, 所以 `require('xterm')` 必然抛错; 改由 host 的 `/fge/vendor/…` 白名单路由伺服官方构建产物, client 用 `<script>` 载入后取全局 `window.Terminal` / `window.FitAddon.FitAddon` |
| `node-pty`、`ws`                   | **dsh 自带**        | 不声明为本包依赖: 它们是 dsh 自己的依赖(`dsh-subprocess-local` → `node-pty`, `dsh-api-gateway` → `ws`), 且**只从 profile 锚点解析得到**(原因见下方「实现事实」)                                                                                                  |

安装依赖(仅首次):

```bash
pnpm --dir plugins/file-git-explorer install
```

## 使用

### Git 页签

右栏点「Git」。页签里是**两份列表**, 都在这一个滚动容器里, 没有视图栈、没有返回按钮:

```
变更列表          工作区相对 HEAD 的全部变更(已暂存 + 未暂存 + 未跟踪), M/A/D/R/U/? 徽标
提交历史          按时间倒序; 头部下拉可切「查看分支」(只影响看哪个分支的历史, 不切工作区分支)
  └─ 点一条提交   就地展开: 提交说明 + 文件清单(±行数); 再点收起
       └─ 点文件  diff 进悬浮面板
  └─ 加载更多…    每页 50 条
```

- **变更列表**: 相对 `HEAD` 的全部变更, 按路径排序, 未跟踪沉底。
- **diff**: rename 用 `-M` 双路径 diff; 未跟踪文件 git 没有 diff 可比, 给明确提示(host 不读盘)。
- **merge 提交只显示说明**, 不展开文件(combined diff 没有阅读价值)。
- **自动刷新**: **agent turn 结束时**(会话 `running` true→false)自动重取变更列表与历史首页, 1s 冷却;
  页签不可见时不刷。**自动刷新不 fetch** —— 避免每个 turn 都打一次网络。提交详情是不可变的, 不重取。
- **⟳ 手动刷新**: 先 `git fetch --all --prune`(非交互、限时 8s、**失败放行**), 再 `info` → `status` → 历史。
- 分支列表是只读展示(本地 / 远程分组), 不切换工作区分支。

### 详情悬浮面板

- 打开文件(官方文件树点行、聊天里的文件链接)或点 diff **都会浮出同一个面板**。
- **同一时间只有一个**: 打开第二个会先关掉第一个的页签, 于是看起来就是内容就地更换。
- 切换会话 / 切换工作区 / **右栏折叠**都会把它关掉。
- 官方悬浮面板头部自带「送回侧栏」按钮且**不可移除**(官方 chrome, 没有可注入的槽) —— 这是选用官方 float
  换取「md/代码/图片/html/pdf 零退化」所付出的已知代价, 见 `docs/adr/0002`。误点后它是右栏页签;
  再点一次同一个文件会重新浮起。
- 悬浮面板可以拖动 / 缩放(官方 chrome), 也可以拖走 —— 因为同时只有一个, 拖走不会与其他面板重叠。

### 「复制内容」芯片

官方文档页签的芯片由本插件**影子替换**(见下方实现事实), 复刻官方外观(`FileTypeIcon` + 文件名),
并在后面加一枚**复制图标**: 复制该文件**磁盘上的原文**(经官方 `remote.workspaceFiles.readAll`),
与预览是否渲染完无关。`html` / `pdf` / 图片等**渲染型**文件不出现这枚图标(没有「原始文本」)。

> diff 悬浮面板的芯片**不需要**复制图标: 官方 `DiffBlock` 自带复制按钮, 复制它重建的 `- `/`+ ` 文本。

### 终端抽屉

- **抽屉舌**: composer 下方一枚居中的透明 chevron(透明、无边框, 只留一枚小三角), 点击**向上**展开。整条与抽屉都用
  `max-width: var(--dsh-chat-content-width); margin-inline: auto` 居中 —— 该变量定义在**对话根元素**上,
  座位在它的子树内, 所以**零 JS 测量**。
- **高度**: 上缘拖柄可调 **20%~70%**, 按工作区记忆在 `localStorage`(默认 40%)。
- **`■`** 终止该工作区终端整棵进程树(Windows 下走 ConPTY 终止整树)。**`✕`** 只是收起抽屉, **不杀进程** ——
  抽屉关闭 / 切换会话 / 刷新页面都不影响它。
- **每工作区一个终端**(键 = 归一化 + 大小写折叠的 cwd): 切工作区就是切换终端; 同工作区多会话**共享同一终端**
  (输出广播, 任意一端都可输入)。全局上限 **16 个**, 超出按 LRU 淘汰最久未用的。
- **重连回放**: host 常驻终端并保留 **256KB** 尾部输出; 重开抽屉 / 刷新页面即重连并补发, 用**绝对字节位**寻址,
  因此不会因缓冲修剪而错位(客户端位置早于缓冲起点时标记 `lossy`)。
- **Esc 焦点分流**: 焦点在终端内 → 交给终端(送给 PTY); 焦点在终端外 → 收起抽屉。
- 默认 shell: `resolveShellExecutable` 产**绝对路径**(PATH 扫描 → 已知安装位置 → `ComSpec`/`/bin/sh` 兜底)。
  **Windows 上不能用裸名** —— node-pty 的 ConPTY 原生层不解析 `powershell` 这类名字, 必须以绝对路径启动。
- 进程**不进 `ctx.jobs`**: jobs 的语义是「会话销毁即取消」, 与「终端要跨抽屉关闭 / 切会话 / 页面刷新存活」矛盾,
  故本插件自管生命周期; 插件卸载时统一收掉所有终端。

## HTTP / WebSocket 接口(host 半, 仅本机)

信任栅栏与 `dsh-ds-balance` 同款: **仅回环地址 + `x-dsh-plugin: 1` 头 + 仅 POST**。
`repoRoot` / `root` 必须是绝对路径; 路径一律 argv 直传 git(无 shell), ref/hash 先过白名单(`safeRef` 拒 `-` 开头 /
`..` / 空白 / `@{`; `safeHash` 只收十六进制)。

| 路由                                                | 请求体                            | 返回                                                                                     |
| --------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /fge/api/info`                                | `{root?}`                         | `{cwd, repoRoot}` —— **纯 stat, 零 git 子进程**                                          |
| `POST /fge/api/status`                              | `{root?, repoRoot}`               | `{current, head, upstream, ahead, behind, initial, detached, branches[], changes[]}`     |
| `POST /fge/api/sync`                                | `{root?, repoRoot}`               | `{ok}` —— `fetch --all --prune`, 成功则作废分支与历史缓存                                |
| `POST /fge/api/diff`                                | `{repoRoot, path, status, from?}` | `{kind:'diff'\|'untracked', hunks:[{path, oldText, newText}], text}` —— 未跟踪**不读盘** |
| `POST /fge/api/log`                                 | `{repoRoot, ref?, skip?, limit?}` | `{ref, commits[], head?}` —— `head` 只在 `skip=0` 附带                                   |
| `POST /fge/api/show`                                | `{repoRoot, hash, path?}`         | `{kind:'commit'\|'merge'\|'diff', message, files[], hunks?, text?}`                      |
| `GET /fge/vendor/xterm.js\|xterm.css\|addon-fit.js` | —                                 | 白名单静态资产                                                                           |
| `GET /fge/ws/terminal?root=&cols=&rows=&from=`      | —                                 | WebSocket 升级 → PTY 字节流                                                              |

`hunks` 是官方 `DiffBlock` 的 `diffs` 形状: **一个 hunk 一条**, 两侧都已是拆好的行块(上下文两边各一份),
`text` 是原始统一 diff(保留备用)。**解析在 host 侧的纯函数里**(`lib/git.js` 的 `parseDiffHunks`),
所以它有真实 git 输出的单测 —— `DiffBlock` 自己**不做** diff 比对, 这一步必须有人做对。

**vendor 路由是唯一不带 `x-dsh-plugin` 的例外**: `<script src>` 无法携带自定义头, 故只校验回环地址, 并以
**硬编码白名单**(三个文件名逐字符命中)兜底 —— 不接受任意路径, 从根上排除穿越; 内容是只读第三方静态资产,
不含任何仓库数据。

### WebSocket 帧协议

与 xterm 的接缝刻意做窄: **数据走二进制帧, 控制走文本帧**。

```
client → host
  · 二进制帧                     原样写入 PTY 的 stdin
  · {t:'resize', cols, rows}     同步 PTY 尺寸
  · {t:'ping'}                   保活
  · {t:'kill'}                   终止整棵终端进程树
host → client
  · 二进制帧                     PTY stdout 原样字节(交由 xterm 解释 ANSI)
  · {t:'ready', id, shell, cols, rows, replay, lossy, exited}
  · {t:'exit', code, signal, evicted?}
  · {t:'error', error}
```

二进制帧不过 JSON —— 这样 vim 的全屏重绘与任意字节序列都不会被编码层破坏。

## 实现事实(已实测钉死, 改实现前必读)

### 1. `git status --porcelain=v2 -z --branch`: 路径可能含空格

一条命令拿全部分支 + 上游 + ahead/behind + 变更(替代了 v0.2 的 4 连发)。**最大的坑**:

```
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>             → 7 个固定字段
2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  → 8 个固定字段
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>   → 9 个固定字段
```

去掉 `1 `/`2 `/`u ` 前缀后, **必须切掉固定数量的前导字段、再把剩余部分用空格拼回**;
用 `split(' ').pop()` 取路径遇到 `sub dir/nested file.txt` 只会拿到 `file.txt`。
官方文档把记录类型也算作一个字段, 按文档字段数直接数会**差一**。

- rename(`2` 行): 新路径在行内, **旧路径是紧随其后的一个裸 token**(自身也可含空格); 输出截断时该 token 孤悬, 解析器必须防御。
- XY 未变更的一侧是 `.`(实测 `.M` / `A.` / `.D`), 解析归一为 v1 的空格形态。
- header: `branch.oid`(空仓库为 `(initial)`)、`branch.head`(分离 HEAD 为 `(detached)`)、`branch.upstream` / `branch.ab`(有上游才有)。
- `git diff HEAD -- <新路径>` 对 rename 只会显示 new file, 必须 `-M -- <新> <旧>`。
- 非 ASCII 路径默认 octal 转义, 统一加 `-c core.quotepath=false`。
- numstat 取文件清单必须 `-z`(默认输出把 rename 打成 `old =>new` 箭头串, pathspec 无法命中)。

### 2. 统一 diff → hunk: 三个只有真输出才暴露的坑

`parseDiffHunks` 的夹具全是真实 `git diff` 输出, 它抓到的是:

- `\ No newline at end of file` 是**内容行之后的标记行**, 不是内容, 必须丢;
- 路径含空格 / 非 ASCII 时 `--- a/<路径>` 后面会**补一个 TAB**(`--- a/ren old.txt\t`),
  所以要先在第一个 TAB 处截断再处理引号;
- `core.quotepath=true` 时路径被 C 风格引号包住、非 ASCII 走**八进制 UTF-8 字节**转义,
  必须按**字节**解码(否则 `\344\270\255` 会变成三个拉丁字符)。

hunk 的范围由 `@@` 头声明的增删数**界定**, 所以 hunk 内一行内容本身以 `--` 开头的 `--- foo` 不会被误当成文件头,
被 `TEXT_CAP` 截断的最后一个 hunk 也能在输入耗尽时按已收到的内容收尾。

### 3. 插件依赖的解析锚点: 不能用 `import.meta.url`

插件以 **junction** 挂进 profile(`~/.dsh/profiles/web/node_modules/dsh-file-git-explorer` → 仓库真实路径),
而 Node 默认解析 **realpath**, `dsh` 也没有传 `--preserve-symlinks`。于是:

- 从插件自身路径 `require('node-pty')` / `require('ws')` → **MODULE_NOT_FOUND**;
- 从 **profile 目录** 解析 → 命中(dsh 在那装了指向自身 `node_modules` 的 junction)。

故 host 半先 `createRequire(ctx.baseUrl)`(`ctx.baseUrl` 由 `dsh-app-boot` 设为 profile 目录),
失败再退回 `createRequire(import.meta.url)`。
**`import.meta.url` 仍然正确用于读本包自己的文件**(本插件没有自带 vendor 资产, 但新增时应照此)。

### 4. 静态资产与 WebSocket

- `dsh-host-webserver` **不提供**静态文件 API(它自己"不伺服任何文件"), 也不做回环校验 —— 都是插件的事。
- `register({kind:'prefix', path, handler})` 按 **最长前缀** 匹配; 重复 `(kind, path)` 抛错,
  所以 `/fge/api` 与 `/fge/vendor` 必须是两条路由。
- `registerUpgrade({path, handler})` 只按 **pathname** 精确匹配(查询串被剥离, 因此 `?root=&cols=` 可用),
  交出的是**裸 socket** —— 握手要自己用 `ws` 的 `WebSocketServer({noServer:true})` + `handleUpgrade` 完成,
  这正是 `ws` 是依赖的原因。不合法来源在**握手前**直接写一段 HTTP 403 到 socket 上。
- 浏览器模块表(seed)是**封闭的 9 项**: `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`-client-store`、`-client-ui-slots`、`-client-ui-primitives`、`-client-ui-dockkit`。
  client 半只能用这些 + `dsh.client.inject` 声明的图内包 —— 所以 `dsh.client.inject` 保持 `[]`。

### 5. 座位、优先级, 与「影子替换官方芯片」

- 两个 kind 都是**全新**的(`fge-git` / `fge-diff`), 用 `priority: 'extension'` 注册, 不与任何 builtin 争位。
- `sidebar.right.pane.tab` / `.title` 是 **keyed** 槽: **`key` = 类型定义的 `id`**(不是 kind)。
  dockkit 用 `definition?.id ?? tab.kind` 当 `entryKey` 派发。
- **拿到官方文档页签的 `tabId` 只有一条路**: 影子注册 `sidebar.right.pane.tab.title`, `key` 用官方 text 类型的
  实现 id `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, 在组件里 `useTabInfo()` 读 `tab.id`。
  为什么别的路全堵死, 见 `docs/adr/0003`。
- ⚠ **同 key 同 priority 会直接抛错**, 而渲染取排序后该 key 的**第一条**, 排序按 priority **升序**
  (`SlotCore.register`: `register at a different priority to shadow it (lowest renders)`)。
  官方那条 title 注册没有 priority(即 0), 所以本插件**必须用负数** priority。
- 复刻官方芯片的成本极小: `FileTypeIcon(classifyFileType(tab.title))` + `tab.title`, 两者都是
  `primitives` 的导出; **关闭按钮 / ⋯ 菜单 / 悬浮面板 chrome 都不在这个槽里**(dockkit 单独渲染, 有
  `data-dockkit-tab-close` / `-tab-menu` / `-float-close` / `-float-dock` / `-float-resize` 为证)⇒ 替换不丢任何交互。
  该槽**两处都渲染**(页签条与悬浮面板头部), 所以影子组件两种位置都要站得住。

### 6. 悬浮面板的几何

- `ctx.sidebarRight.float(tabId, rect)` 是公开接口, `rect` 原样生效(`{x, y, width, height}`, 视口坐标 ——
  悬浮面板宿主是 `position:fixed` 且 portal 到 `document.body`)。**只对 docked 页签生效**, 已浮起的页签是 no-op,
  且**无已挂载会话座位时抛错**(调用点容错)。默认几何是 380×300 + 每层错开 24px 的级联, 没有平铺 / 吸附 / 贴边。
- **右栏左缘**从 `[data-rightbar-col]`(右栏的 grid item)量, **不要**量里面的 `[data-sidebar-right-panel]`:
  面板靠 CSS `transform` 滑入滑出, 展开动画期间量它只会拿到中间值, 而列本身不动。列宽为 0(`data-rightbar-collapsed`)时无轨道。
- **右栏折叠必须显式关掉悬浮面板**: 悬浮面板在 `document.body` 上的一个 `fixed` portal 里(`z-index: 60`), 不随右栏滑走。
  本插件用一个只监听 `data-rightbar-collapsed` 的 `MutationObserver` 来关。
- **居中用变量, 不用测量**: `--dsh-chat-content-width` 定义在**对话根元素**上, `conversation.composer.dock`
  在其子树内, 所以 `max-width: var(--dsh-chat-content-width); margin-inline: auto` 即可, 零 JS。

### 7. `DiffBlock` 的契约

`primitives.DiffBlock` props = `{diffs, labels, maxLines?, className?}`:

- `diffs: [{path, oldText, newText}]`, **一个 hunk 一条**; `oldText` / `newText` 已是拆好的行块(上下文两边各一份)。
- 它**不做 diff 比对**: `oldText` 整块当删除行、`newText` 整块当新增行。无行号、无换行开关、无二进制/mode 表达。
- 自带复制按钮(复制它重建的 `- `/`+ ` 文本)、折叠(`maxLines` 默认 16)、`└ +N -M · N files` 页脚。
- `labels` **必填 7 个键**: `copy` / `copied` / `files(n)` / `expand(n)` / `expandAria(n)` / `collapse` / `collapseAria`。

### 8. 正文渲染器的可复用性

markdown → `primitives.MarkdownText`、代码 → `primitives.CodeBlock`(**可用**); `text` / `image` / `html` / `pdf`
→ **不可复用**(组件未导出)。这正是 v0.7 改用「官方页签浮起来」而不是自绘悬浮面板的原因 —— 见 `docs/adr/0002`。

## 测试与静态检查

```bash
node tests/git.test.mjs      # git 纯函数层(porcelain v2 解析 / 白名单 / diff argv / 统一 diff→hunk)
node tests/address.test.mjs  # 文件地址与「复制内容」纯函数层(芯片逻辑的可执行规约)
node tests/pty.test.mjs      # 终端纯函数层(shell 绝对路径解析 / 尺寸钳制 / 帧编解码 / 回放缓冲 / LRU)
node tests/verify.mjs        # host 全链路冒烟: 真实 git + 真实 HTTP 栅栏 + vendor + 真 WS/PTY 端到端
eslint .                     # 仓库统一 lint(client bundle 按惯例忽略)
```

浏览器半边的**装配契约**(种子模块引用、槽位名 / key / priority)由仓库根的
`scripts/verify-client-bundles.mjs` 离线护栏 —— 其中一条就是「影子芯片必须是负数 priority」。

### 浏览器验收清单(离线脚本盖不到, 需要真 boot)

在**隔离 `DSH_HOME` + 独立端口**起一个实例(先 `dsh plugin --profile <名> add link:<repo-abs-path>/plugins/file-git-explorer`,
再 `dsh --profile <名> --port <端口> --no-open`),在真浏览器里逐条走一遍:

1. 右栏 guide 里有「Git」胶囊;点它打开页签 → 头部是分支名 + `↑/↓` + `⟳`,正文是**变更列表**与**提交历史**两段。
2. 点一条提交 → **就地展开**说明 + 文件 ±行数(merge 提交只出说明);再点收起;「加载更多…」能翻页。
3. 点展开出来的文件 → **悬浮面板**出现在右栏左侧:视口 1/2 宽、满高、右缘贴右栏左缘;正文是官方 `DiffBlock`(带复制按钮)。
4. 官方文件树点一个文件 → 用**同一个**悬浮面板位显示官方正文;再点另一个文件 → 仍是**一个**面板、内容就地更换。
5. 悬浮面板头部:文件名前有文件类型图标,后随一枚**复制图标**;点它 → 图标变「已复制」,剪贴板是磁盘原文
   (只有带扩展名的文件有;`html`/`pdf`/图片与无扩展名文件没有这枚图标)。
6. 收起右栏 / 切换会话 / 切换工作区 → 面板消失。
7. composer 下方有居中的抽屉舌;点它**向上**展开终端(能跑 `vim` / 颜色 / 补全);`✕` 只收起、`■` 才杀进程;
   刷新页面后重开抽屉应看到历史输出;Esc(焦点在终端外)收起。
8. 全程 DevTools 控制台**零 pageerror**、零插件 `console.error`。

## 已知限制(接受, 不是 bug)

- 悬浮面板头部自带的「送回侧栏」按钮**不可移除**(官方 chrome 没有可注入的槽); 误点后再点同一个文件即可重新浮起。
- 悬浮面板**不吸**右栏边缘, 可以被拖走 / 缩放; 换窗口尺寸后也不会自动跟着重排(几何只在浮起那一刻算)。
- Windows 下 PTY 退出后 ConPTY 会滞留句柄直到事件循环排空, **dsh 重启清零**; 终端进程生命周期与 dsh 进程绑定。
- 终端尺寸同步依赖浏览器 `ResizeObserver`, 极端布局变化下可能差一格, 下一次 resize 自愈。
- 悬浮面板的状态是**按会话**存的(官方 `sidebarRight` 的 store 就是按会话的), 所以切走再切回来会看到它还在;
  切到别的会话时它不会跟过去。

## 术语

「右侧栏页签」「git 页签」「变更列表」「diff 范围」「提交历史」「查看分支」「刷新」「悬浮面板」「详情」
「composer 座」「抽屉舌」「终端抽屉」「工作区终端」「回放缓冲」「工作区」的定义见仓库根 `CONTEXT.md`。
