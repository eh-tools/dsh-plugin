# dsh-file-git-explorer

官方**右侧栏**里的 Git 页签 + 终端抽屉。

- **Git 树页签**(kind `fge-git`): 当前分支 + 上游 `↑ahead ↓behind` 徽标、工作区变更列表(已暂存 / 未暂存 / 未跟踪, 带 `M/A/D/R/U/?` 徽标)、单文件 diff、提交历史(分页 / 切查看分支 / 提交详情 / 单文件 diff)。
- **终端页签与终端抽屉**(kind `fge-shell`): **真 PTY** —— `node-pty` ↔ WebSocket ↔ `xterm.js`, 所以 vim / htop / 颜色 / 补全 / Ctrl+C 全部可用。抽屉的收起态只在 composer 下留一条细舌, 展开**在流内推挤会话列**(不做 fixed 悬浮)。

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

### Git 树页签

右侧栏点「Git 树」。页签内是**视图栈**, 头部 `‹` 返回上一层:

```
changes(默认) ──点变更行──▶ diff
      │
      └─⏱ 历史──▶ history ──点提交──▶ cfile(提交详情)
                                                   │
                                            点文件行 ──▶ 同屏显示该文件 diff
```

- **变更列表**: 相对 `HEAD` 的全部变更(已暂存 + 未暂存 + 未跟踪), 按路径排序, 未跟踪沉底。
- **diff**: rename 用 `-M` 双路径 diff; 未跟踪文件 git 没有 diff 可比, 给明确提示(host 不读盘)。
- **提交历史**: 每页 50 条; merge 提交只显示说明、不展示 combined diff。
- **自动刷新**: **agent turn 结束时**(会话 `running` true→false)自动重取 status, 1s 冷却; 页签不可见时挂起、可见时补刷。**自动刷新不 fetch** —— 避免每个 turn 都打一次网络。
- **⟳ 手动刷新**: 先 `git fetch --all --prune`(非交互、限时 8s、**失败放行**), 再 `info` → `status`; sync 成功才作废分支缓存。
- 分支列表是只读展示(本地 / 远程分组), 不切换工作区分支。

### 终端

- **抽屉**: composer 下方常驻一条「终端」细舌, 点击展开; 上缘拖柄调高度(**20%~70%**, 按工作区记忆在 `localStorage`); 拖到哪就记住哪。
- **`■`** 终止该工作区终端整棵进程树(Windows 下走 ConPTY 终止整树)。**`✕`** 只是收起抽屉,**不杀进程** —— 抽屉关闭 / 切换会话 / 刷新页面都不影响它。
- **每工作区一个终端**(键 = 归一化 + 大小写折叠的 cwd): 切工作区就是切换终端; 同工作区多会话**共享同一终端**(输出广播, 任意一端都可输入)。全局上限 **16 个**, 超出按 LRU 淘汰最久未用的。
- **重连回放**: host 常驻终端并保留 **256KB** 尾部输出; 重开抽屉 / 刷新页面即重连并补发, 用**绝对字节位**寻址, 因此不会因缓冲修剪而错位(客户端位置早于缓冲起点时标记 `lossy`)。
- **Esc 焦点分流**: 焦点在终端内 → 交给终端(送给 PTY); 焦点在终端外 → 收起抽屉。
- 默认 shell: `resolveShellExecutable` 产**绝对路径**(PATH 扫描 → 已知安装位置 → `ComSpec`/`/bin/sh` 兜底)。**Windows 上不能用裸名** —— node-pty 的 ConPTY 原生层不解析 `powershell` 这类名字, 必须以绝对路径启动。
- 进程**不进 `ctx.jobs`**: jobs 的语义是「会话销毁即取消」, 与「终端要跨抽屉关闭 / 切会话 / 页面刷新存活」矛盾, 故本插件自管生命周期; 插件卸载时统一收掉所有终端。

## HTTP / WebSocket 接口(host 半, 仅本机)

信任栅栏与 `dsh-ds-balance` 同款: **仅回环地址 + `x-dsh-plugin: 1` 头 + 仅 POST**。
`repoRoot` / `root` 必须是绝对路径; 路径一律 argv 直传 git(无 shell), ref/hash 先过白名单(`safeRef` 拒 `-` 开头 / `..` / 空白 / `@{`; `safeHash` 只收十六进制)。

| 路由                                                | 请求体                            | 返回                                                                                 |
| --------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /fge/api/info`                                | `{root?}`                         | `{cwd, repoRoot}` —— **纯 stat, 零 git 子进程**                                      |
| `POST /fge/api/status`                              | `{root?, repoRoot}`               | `{current, head, upstream, ahead, behind, initial, detached, branches[], changes[]}` |
| `POST /fge/api/sync`                                | `{root?, repoRoot}`               | `{ok}` —— `fetch --all --prune`, 成功则作废分支与历史缓存                            |
| `POST /fge/api/diff`                                | `{repoRoot, path, status, from?}` | `{kind:'diff'\|'untracked', text}` —— 未跟踪**不读盘**                               |
| `POST /fge/api/log`                                 | `{repoRoot, ref?, skip?, limit?}` | `{ref, commits[], head?}` —— `head` 只在 `skip=0` 附带                               |
| `POST /fge/api/show`                                | `{repoRoot, hash, path?}`         | `{kind:'commit'\|'merge'\|'diff', message, files[], text}`                           |
| `GET /fge/vendor/xterm.js\|xterm.css\|addon-fit.js` | —                                 | 白名单静态资产                                                                       |
| `GET /fge/ws/terminal?root=&cols=&rows=&from=`      | —                                 | WebSocket 升级 → PTY 字节流                                                          |

**vendor 路由是唯一不带 `x-dsh-plugin` 的例外**: `<script src>` 无法携带自定义头, 故只校验回环地址, 并以**硬编码白名单**(三个文件名逐字符命中)兜底 —— 不接受任意路径, 从根上排除穿越; 内容是只读第三方静态资产, 不含任何仓库数据。

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

### 2. 插件依赖的解析锚点: 不能用 `import.meta.url`

插件以 **junction** 挂进 profile(`~/.dsh/profiles/web/node_modules/dsh-file-git-explorer` → 仓库真实路径),
而 Node 默认解析 **realpath**, `dsh` 也没有传 `--preserve-symlinks`。于是:

- 从插件自身路径 `require('node-pty')` / `require('ws')` → **MODULE_NOT_FOUND**;
- 从 **profile 目录** 解析 → 命中(dsh 在那装了指向自身 `node_modules` 的 junction)。

故 host 半先 `createRequire(ctx.baseUrl)`(`ctx.baseUrl` 由 `dsh-app-boot` 设为 profile 目录),
失败再退回 `createRequire(import.meta.url)`。
**`import.meta.url` 仍然正确用于读本包自己的文件**(本插件没有自带 vendor 资产, 但新增时应照此)。

### 3. 静态资产与 WebSocket

- `dsh-host-webserver` **不提供**静态文件 API(它自己"不伺服任何文件"), 也不做回环校验 —— 都是插件的事。
- `register({kind:'prefix', path, handler})` 按 **最长前缀** 匹配; 重复 `(kind, path)` 抛错, 所以 `/fge/api` 与 `/fge/vendor` 必须是两条路由。
- `registerUpgrade({path, handler})` 只按 **pathname** 精确匹配(查询串被剥离, 因此 `?root=&cols=` 可用),
  交出的是**裸 socket** —— 握手要自己用 `ws` 的 `WebSocketServer({noServer:true})` + `handleUpgrade` 完成, 这正是 `ws` 是依赖的原因。不合法来源在**握手前**直接写一段 HTTP 403 到 socket 上。
- 浏览器模块表(seed)是**封闭的 9 项**: `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`-client-store`、`-client-ui-slots`、`-client-ui-primitives`、`-client-ui-dockkit`。client 半只能用这些 + `dsh.client.inject` 声明的图内包。

### 4. 座位与优先级

- 两个 kind 都是**全新**的(`fge-git` / `fge-shell`), 用 `priority: 'extension'` 注册, 不与任何 builtin 争位。
  (右侧栏注册表: `extension` 可以**接管**同 kind 的 `builtin`; 同档重复注册或 `id` 重名都会抛错。)
- `sidebar.right.pane.tab` / `.title` 是 **keyed** 槽: `key` = 类型定义的 `id`。
  body 从座位注入拿到 `useTabInfo`(`tab.visible` 驱动挂起)、`sessionId`、`useSessions` 等标准 props。
- client 半只 `require('react')`, 官方能力全走座位注入, 因此 `dsh.client.inject` 保持 `[]`。

## 测试与静态检查

```bash
node tests/git.test.mjs    # git 纯函数层(porcelain v2 解析 / 白名单 / diff argv), 夹具是真实 git 输出
node tests/pty.test.mjs    # 终端纯函数层(shell 绝对路径解析 / 尺寸钳制 / 帧编解码 / 回放缓冲 / LRU)
node tests/verify.mjs      # host 全链路冒烟: 真实 git + 真实 HTTP 栅栏 + vendor + 真 WS/PTY 端到端
eslint .                   # 仓库统一 lint(client bundle 按惯例忽略)
```

## 已知限制(接受, 不是 bug)

- Windows 下 PTY 退出后 ConPTY 会滞留句柄直到事件循环排空, **dsh 重启清零**; 终端进程生命周期与 dsh 进程绑定。
- 终端尺寸同步依赖浏览器 `ResizeObserver`, 极端布局变化下可能差一格, 下一次 resize 自愈。

## 术语

「Git 树页签」「变更列表」「diff 范围」「提交历史」「查看分支」「终端页签」「终端抽屉」「工作区终端」「回放缓冲」「刷新」的定义见仓库根 `CONTEXT.md`。
