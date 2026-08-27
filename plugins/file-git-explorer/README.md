# dsh-file-git-explorer

左右树浏览插件 —— 左侧**文件树**(可见 / 隐藏 / 忽略三区, 根 = 当前会话工作区, 支持按名搜索, 底部带 **shell 行**: ✓ 执行 / ✕ 停止的单槽后台命令行) + 右侧 **git 树**(当前分支只读下拉、工作区变更列表、悬浮 diff、查看分支的**提交历史**)。两个面板夹在会话 header 与 composer card 之间, 可左右拉伸、可收起为细条、图钉锁定, 不覆盖主对话区。

静态双半插件(host + client bundle), 随 web profile 启动自动加载。

## 安装

```bash
dsh plugin --profile web add link:<repo-abs-path>/plugins/file-git-explorer
```

安装后 host 半随 DSH 启动自动挂载; 浏览器 bundle 由 profile 注入, 刷新 GUI 页面生效。卸载用 `dsh plugin --profile web remove file-git-explorer`(或对应 CLI 命令)。

## 布局与交互

```
┌────────────────────────────────────────────────────────────┐
│ header / tabs ───────────── 边框线(面板顶边不得越过)          │
│ ┌─文件树──┐   主对话区(748px 居中)    ┌──git 树──┐           │
│ │⎇ 可显示 │   (悬浮面板可越过)          │⎇ 当前分支▾│           │
│ │  隐藏   │                            │ M a.txt  │           │
│ │  忽略   │                            │ A b.js   │           │
│ └────────┘                            └──────────┘           │
│ composer card ───────────────── 下边框(面板底边不得越过)       │
└────────────────────────────────────────────────────────────┘
```

- **几何**: 两面板 `position:fixed`, `top`/`bottom` = `[data-conversation-scroll]` 滚动容器(对话列)的顶部 / 底边 —— 统一以对话列为基准, 面板以**对称边距垂直居中**(顶部 4px、底部 4px, 不因 composer 卡片自带 8px 底部留白而偏上)。左树左缘跟随应用侧边栏右缘(折叠成 rail 时自动跟随), 右树右缘在 details 列打开(360px)时自动让位。滚动 / resize / 侧边栏折叠 / 会话切换都通过事件重测锚点(无定时轮询)。
- **拉伸**: 面板内侧边缘有 6px 拖柄, 水平拖动改宽度; **默认宽度 400px**, **最小宽度 250px**; **最大宽度 = 可留白的 2/3(较之前减少 1/3), 面板不会拖到对话区边缘**; 钳制上限 = 对话区与对应侧之间的留白, **永不覆盖主对话区**。拖柄悬停只显示一条细线, 淡化存在。
- **收起 / 细条**: 面板头部「» / «」按钮(SVG 双箭头)收起为同侧 26px 细条(**只剩一个圆角箭头, 无边框底色**)。**悬停细条(或箭头)即整侧展开**; 鼠标移出面板后**延迟约 360ms 才收起**(张顿一下, 不因快速掠过而闪断), 期间移回即取消; 头部的 »/« 按钮也可点击收起。
- **头部路径**: 左树头部显示当前根路径, **中间省略**(保头保尾, `…`), 点击路径复制完整路径到剪贴板(复制后短暂显示「✓ 已复制」)。
- **图钉(无色线条版 📌)**: 默认**不固定**(两侧收起为细条, 悬停即展开); 点任意一侧的图钉, **两个面板都展开为卡片并固定**(不会出现「已固定但另一侧仍是细条」的状态); 钉住后两个面板都不能收起(按钮置灰, 鼠标移出也不会收起); 再点图钉解除固定。
- **悬浮栏联动**: 点文件/diff 弹出的悬浮栏与**源侧栏联动** —— 鼠标移到悬浮栏时侧栏保持展开(悬浮栏豁免收起); 移出整块区域(侧栏+悬浮栏)延迟后侧栏收起并**一并关闭该悬浮栏**, 不留下「侧栏已收、悬浮栏还在」的孤儿状态。
- **刷新 ⟳**: 重读 `info`(根 / 仓库根 / 当前分支) + 重跑 git status, 并作废三棵树已加载的缓存。
- **外观**: 面板背景 = 对话消息列(`.Md3f7G_column` 的 `--dsw-alias-bg-base`), 与聊天区域同底色; 头部图标(图钉 / 刷新 / 收起 / 关闭 / 分支)全部用单色线稿 SVG 对齐; 面板内滚动条细且半透明(悬停才加深), 拖拽柄只在悬停时显示一条细线。

### 左侧文件树(三区, 独立滚动)

| 分区       | 内容                                                                                                                        | 展开语义                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 可显示文件 | 非点开头 且 未被 .gitignore 忽略                                                                                            | 每级只展示本区成员                                                                    |
| 隐藏文件   | `.` 开头(排除 `.git` 内部结构)                                                                                              | 普通目录只展示其 dot 子项; 点开的 **dot 目录**展示其全部子项                          |
| 忽略文件   | .gitignore 忽略项(含被忽略的点文件), 另含**桥接目录**——自身未忽略但子树含忽略项的普通目录(如 `src`, 通向 `src/__pycache__`) | 普通目录只展示其忽略/桥接子项; 点开的 **被忽略目录**(如 `node_modules`)展示其全部子项 |

- 逐级懒加载: 点目录才拉取子节点(`POST /fge/api/tree`), 无定时扫描。
- 点**文件** → 行高亮 + **内容悬浮面板向右浮出**(可越过对话区, 文本 + 行号 + **逐行语法高亮**: 关键字 / 类型·类名 / 函数调用 / 字符串 / 注释 / 数字, 覆盖 JS/TS/Python/Rust/Go/Java/C 等常见语言; >1 MiB 或二进制只显示提示、不预览)。
- 点文件同时触发**联动**: 右侧 git 树若存在该文件 diff, 滚动定位并闪现高亮; **不自动打开 diff**; 无 diff 则无操作。
- 目录单击 = 展开 / 折叠切换。

#### 文件编辑与树内写操作

- **编辑**: 内容悬浮面板头部的「编辑」把高亮预览切换为**纯 textarea**(只读视图保持原样, 不引入编辑器依赖)。**⌘S / Ctrl+S** 保存, **Esc** 退出编辑; 未保存时标题带 `•` 点并给出确认(关闭 / 退出编辑均会拦截询问); Tab 插入两个空格。
- **保存的并发保护**: 读取时返回 `mtimeMs`, 保存时回传做**乐观校验** —— 磁盘已被外部改动(如 agent 同时在写)时**拒绝保存并提示冲突**, 可「重新加载磁盘版」或「仍要覆盖写入」(Shift+⌘S 亦可强制)。内容上限 1 MiB 与预览对称, 超出时保存按钮禁用并提示。
- **保存后自动刷新右侧 git 状态**(变更列表 / 徽标随之更新); 树内结构变化(新建 / 重命名 / 删除)则**局部重载受影响目录**, 不打断展开状态。
- **新建**: 每分区头部 `+` 在当前分区根新建; 目录行的悬停 `+` 在其内新建(自动展开)。名称**以 `/` 结尾 = 建目录**, 可写 `a/b/c.ts` 嵌套(父目录自动补建); 文件名重名报「同名条目已存在」。
- **重命名 / 删除**: 行悬停出现 `✎` / `✕`; 重命名行内输入、Enter 确认; 删除先经确认框(**目录 = 连同全部内容递归删除, 不可恢复**), 非空目录在 host 侧同样要求显式 `recursive` 才放行。
- 已打开的内容面板**跟随重命名**(含祖先目录改名)并**在删除时自动关闭**; 所有写操作拒绝触及 `.git` 段(路径逐段校验)。

#### 文件搜索(name search)

- 头部**放大镜**展开搜索框, 输入防抖 ~150ms 即时按名检索——大小写不敏感子串匹配
  相对路径, **不读取、不检索文件内容**; 三区树被平铺结果替换, Esc / 清空即恢复。
- 每条结果带分区徽标(**显 / 隐 / 忽**); 排序 = 名字命中 > 仅路径命中 → 短路径优先;
  扫描上限 20 000 条、返回上限 300 条, 超出时列表尾提示「已截断」。
- 点击**文件**命中 → 打开内容悬浮面板并联动右树(与点树内文件完全一致);
  点击**目录**命中 → 关闭搜索并在对应分区树内逐级 reveal 展开到目标并高亮
  (混合链如 `src/.env` 在该区不可达时, 退化为高亮可达的最深祖先)。
- 非 git 工作区回退 fs 递归扫描(不跟符号链接, 无忽略区); 会话切根自动清空搜索态。

#### shell 行(shell bar)

左树底部常驻的命令执行行: 输入框 + **✓ 执行** / **✕ 停止**两钮(单色线稿 SVG), 语义见 CONTEXT.md「shell 行 / 单槽 / 尾部输出窗」。

- **执行**: ✓ 或 **Enter**(IME 组合期不触发; `preventDefault + stopPropagation` 隔离应用层按键链)。
  命令在**会话工作区**(与文件树同根)以**用户默认 shell** 解释——POSIX 取 `$SHELL`(不可用回退 `/bin/sh`), Windows 取 `pwsh` 回退 `powershell`; 解析结果按进程缓存。命令串 trim 后非空、≤4000 字符, 越界拒绝(`invalid-command`)。
- **不消失**: 执行后命令文本保留在输入框(不清空); ↑/↓ 在历史间导航(相邻去重, 上限 100 条),
  历史随仓库根持久化(`fge-cache-v1` 的 `shellHistory` 字段)。Esc = 输入框失焦(stopPropagation, 不波及常驻 Esc 监听)。
  输入框与 ✓ 之间**始终显示生命周期符号**(○ 启动中 / ● 运行中 / ■ 已停止), 点击符号开合输出窗; 修改/清空命令即作废上一任务(符号回到 ■); 刷新/切工作区认领到终态任务时命令文本回填输入框。
- **挂后台任务**: 启动即注册为 DSH 后台任务(kind `shell`, label = 命令原文), 出现在各会话头部的任务弹层并计入徽标;
  无主任务 —— 完成**不通知模型**。GUI 任务列表只读, 故 ✕ 是人停止任务的唯一入口
  (整棵进程树 TERM → 3s → KILL)。
- **单槽(按工作区)**: 每个工作区各自至多一条 running/stopping(宿主侧按 root 记账, 跨刷新 / 多标签成立;
  不同工作区可并行各跑各的); 切工作区只显示本区任务 —— 刷新后自动认领本区仍在跑的任务(running 态 + ✕ 照常可停);
  **运行中输入框锁定只读**(Enter / ✓ 执行后光标离开、不可编辑, ↑/↓ 与输入一并禁用, 任务结束后恢复)且 ✓ 置灰; ✕ 只停当前工作区那条; 无运行时长上限; 终态槽超上限按 FIFO 淘汰(运行中永不淘汰)。
- **尾部输出窗**: 点击状态符号(`○ ● ■`)开合的滚动区, 运行中每 ~1s 拉一次增量(offset 制非消费式读), 显示尾部各流 ~16K 字符, 自动滚底; stderr 以 `[stderr]` 段落区分; 启动失败等错误信息也写入窗内。

### 右侧 git 树

- 顶部: 当前分支(前有竖着 git 分支 SVG 图标; 实时读 `git branch --show-current`), 点击从**面板左侧**弹出**所有分支下拉**(本地 / 远程分组, 纯展示清单: 行不可点、无 hover 反色, 仅以「当前 / 查看中」标记状态, 不支持切换)。**单击下拉外任意位置即收起**, 不必再点分支名。下拉与 diff / 提交历史悬浮栏**互斥**(开一关一, 两者同占面板左侧留白带, 避免互相遮挡)。
- 下方: 工作区相对 **HEAD** 的变更列表(已暂存 + 未暂存 + 未跟踪), 平铺 + 状态徽标(`M`/`A`/`D`/`R`/`U`), 按路径排序。
- 点变更文件 → **diff 悬浮面板向左浮出**(unified, 行级 +/− 着色, 增删行内容同样做**代码语法高亮**; 未跟踪文件显示内容; rename 用 `-M` 双路径 diff; 二进制显示提示)。再点同一项或点 ✕ 关闭。
- 非 git 目录: 右侧树显示「(工作区干净)」占位, 分支区为空, 历史按钮置灰。

#### 提交历史(commit history)

- 头部**时钟按钮**向左浮出历史面板, 与 diff 浮层**互斥共享锚位**(开一关一)。
- 跟随「**查看分支**」= 历史面板头部按钮最后点选的分支(默认当前分支; 分支被删时回退当前分支)。右树顶部的分支下拉不含切换入口。
- 面板头部的**分支名按钮**可直接切换查看分支: 点击弹出同款本地 / 远程分组菜单(标记「当前 / 查看中」), 点选即按该分支重拉列表 —— 这是「查看分支」的唯一入口; 只读, 不切换工作区分支。
- 列表每页 50 条, 滚动到底自动追加(`--skip` 分页); 条目 = subject + 作者 · 相对时间 · 短 hash; **条目间有分割线**, 详情里文件行之间同样有分割线。
- 点条目**仍在当前面板**看详情: 完整提交说明 + 按文件 ±行数列表(numstat); **merge 提交只显示说明、不展示 diff**(combined diff 无阅读价值)。点某条文件记录,在历史面板**左侧单开该文件的 diff 悬浮栏**(与变更列表点开 diff 同一套交互、复用同一面板; 再点同一行或 ✕ 关闭), 历史列表与详情保持不动。收起右栏 / Esc / 切换工作区会一并关闭。
- agent turn 结束的自动刷新同样覆盖历史: 面板可见且 HEAD 变了才整页重拉已加载页数, 尽量保留滚动位置; Esc / 收起右栏 / 切换工作区都会关闭历史浮层。

## cwd 缓存

- 树根 = **当前会话工作区**(跟随工作区切换, 经 `useSessions` 的会话 cwd 感知), 会话无 cwd 时回退 DSH 进程 `process.cwd()`; 无路径切换框(设计决策, 见 CONTEXT.md「cwd」)。
- 按仓库根(`repoRoot`, 无仓库时按 cwd)在 `localStorage`(`fge-cache-v1`)记忆: 面板宽度、展开 / 收起状态、「查看中」的分支; 切回同一仓库自动恢复。当前分支始终实时读取, 不缓存。

## HTTP API(host 半, 仅本机)

信任栅栏与 `dsh-ds-balance` 同款: 仅回环地址 + `x-dsh-plugin: 1` 头 + POST。所有路径做防穿越校验(文件树/file 只能落在请求 `root` 之下, `root`/`repoRoot` 必须是绝对路径)。

| 路由                        | 请求体                                     | 返回                                                               |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `POST /fge/api/info`        | `{root?}`                                  | `{cwd(=root), repoRoot, branch, head}`                             |
| `POST /fge/api/tree`        | `{root?, path, mode, reveal}`              | 目录三区条目 `[{name, rel, type, dot, ignored, subIgnored}]`       |
| `POST /fge/api/status`      | `{root?, repoRoot}`                        | `{current, head, branches[], changes[]}`                           |
| `POST /fge/api/diff`        | `{root?, repoRoot, path, status, from}`    | `{kind: 'diff'\|'untracked', text, ...}`                           |
| `POST /fge/api/file`        | `{root?, path}`                            | `{text, binary, truncated, size, mtimeMs}`(mtimeMs 供保存校验)     |
| `POST /fge/api/search`      | `{root?, query}`                           | `{matches[{rel, type, zone, nameHit}], truncated}`                 |
| `POST /fge/api/log`         | `{root?, repoRoot, ref?, skip?, limit?}`   | `{ref, head, commits[{hash, short, author, at, subject}]}`         |
| `POST /fge/api/show`        | `{root?, repoRoot, hash, path?}`           | `{kind: 'commit'\|'merge'\|'diff', message, files[], text}`        |
| `POST /fge/api/save`        | `{root?, path, content, mtimeMs?, force?}` | `{size, mtimeMs}`; conflict / too-large / invalid-path 等拒绝      |
| `POST /fge/api/create`      | `{root?, path, kind: 'file'\|'dir'}`       | `{kind, size, mtimeMs}`; 父目录自动补建, 同名 exists 拒绝          |
| `POST /fge/api/rename`      | `{root?, path, newName}`                   | `{}`; 同目录重命名, 目标已存在 exists / 非法名 invalid-name 拒绝   |
| `POST /fge/api/remove`      | `{root?, path, recursive?}`                | `{}`; 目录需显式 recursive=true(否则非空 not-empty 拒绝)           |
| `POST /fge/api/shellStart`  | `{root?, command}`                         | `{job{id, label, status, ...}}`; busy / invalid-command 等拒绝     |
| `POST /fge/api/shellState`  | `{root?}`                                  | `{job \| null}`(本工作区槽, GUI 刷新恢复用)                        |
| `POST /fge/api/shellOutput` | `{root?, outFrom?, errFrom?}`              | `{job, done, out{text,next,base,lossy}, err{...}}`(绝对字符位增量) |
| `POST /fge/api/shellStop`   | `{root?}`                                  | `{stopped, job}`(TERM→3s→KILL 整树, 只作用本工作区)                |

git 一律经 `subprocess` 服务执行(argv 数组, 无 shell)。shell 行是唯一经用户 shell 解释命令串的入口
(解释器解析见 `lib/shell.js`, 同样只服务栅栏之后的本机请求), 启动即挂 `ctx.jobs`(kind `shell`, 无主任务)。

写类接口(save/create/rename/remove)的约束:

- **路径逐段白校验**: 每段必须通过 `validSegmentName`(拒 `.` / `..` / `.git`、`/ \ : * ? " < > |`、NUL、首尾空格、超 255 字符; 空段如 `a//b` 同样拒绝), 再经 `resolveWithin` 防穿越 —— `.git` 段在写类接口上不可建 / 不可写 / 不可改 / 不可删。
- **save**: `content` 必须为字符串且 ≤1 MiB(`too-large`); 携带 `mtimeMs` 时做乐观并发校验, 磁盘 mtime 差 >1ms 且未 `force` → `conflict`(附磁盘现状, 客户端提示重载或强制覆盖)。save 路由单独放宽请求体上限(3 MiB, 覆盖 JSON 转义最坏 2 倍膨胀), 其余路由仍为 256 KiB。
- **create**: 父目录自动补建(`mkdir -p` 语义); 目标已存在 → `exists`。**rename**: 只允许单段合法名、同目录内; 目标占用 → `exists`。**remove**: 文件 / 符号链接直接删; 目录必须显式 `recursive: true`(`rm -rf` 语义), 否则非空目录 `not-empty` 拒绝; 根路径(`rel === ''`)不可删。

## 实现事实(已用真实仓库实测钉死)

- `git status --porcelain=v1 -z`: 条目 NUL 分隔; rename 是两条 —— `R  <新路径>\0<旧路径>\0`(状态 token 带新路径, 裸 token 是旧路径)。
- `git check-ignore` 必须 `--stdin -z`(argv 模式不允许 `-z`), 只输出命中的路径(exit 0 = 有命中, 1 = 无)。
- 忽略区的**桥接目录**靠 `git ls-files -o -i --exclude-standard --directory -z -- :(literal)<子目录>…` 探测: `--directory` 把整体被忽略的子目录折叠成单条输出, 任一 token 落在某候选子目录下即标记 `subIgnored`(一次调用覆盖全部直接子目录, 开销同阶); 不做桥接时深层忽略路径(如 `src/__pycache__`)因父级未被忽略而无法从忽略区走到。
- `git diff HEAD -- <新路径>` 对 rename 只会显示 new file, 必须 `-M -- <新> <旧>` 才能出 rename diff; 未跟踪文件 diff 为空, 回退读内容。
- 非 ASCII 路径在 diff 里默认 octal 转义, 统一加 `-c core.quotepath=false`。
- `git ls-files -c -o --exclude-standard -z` 与 `-o -i --exclude-standard -z` 分别给出「可见+隐藏」「忽略」的全量文件清单; 搜索的目录命中项由文件路径派生(`dirsFromPaths`), 与懒加载树语义解耦。
- `git log --format=%H%x00%h%x00%an%x00%at%x00%s`: 字段 NUL 分隔、条目换行分隔, 作者名/主题含空格安全; 分页用 `--skip` + `-n`。
- merge 提交识别: `git rev-list --parents -n 1 <hash>` 数父提交(>1 即 merge); 单文件 diff 用 `git show --format= <hash> -- <path>` 输出纯 diff, 首个提交需 `diff-tree --root` 才有 numstat。
- numstat 取文件清单必须 `-z`: 默认输出把 rename 打成 `old =>{new}` 箭头串(pathspec 无法命中); `-z` 下为 hash\0 + `A\tD\t<路径>\0`, rename 是 `A\tD\t\0<旧>\0<新>\0`(计数 token 路径位为空, 后跟旧、新两个裸 token), 解析见 `parseNumStatZ`。
- ref/hash 一律 argv 直传且先过白校验(safeRef 拒 `-` 开头 / `..` / 空白 / `@{`; safeHash 只收十六进制串), 无 shell 可注入面。
- 面板锚点全部用稳定 data 属性: `[data-conversation-scroll]`、`[data-composer-card="true"]`; 对话列宽读 `--dsh-chat-content-width`; 不依赖任何哈希类名(`uV2eYG_*`/`wSkVaW_*` 等跨构建不稳定)。

## 测试与静态检查

```bash
node tests/git.test.mjs    # 纯函数层单测(status 解析 / 三区划分 / 防穿越 / diff 参数)
node tests/shell.test.mjs  # shell 行纯函数层单测(解释器解析 / 历史 / 尾部窗口数学)
node tests/edit.test.mjs   # 写类接口单测(save 并发冲突 / create / rename / remove, 临时目录)
node tests/verify.mjs      # host 集成冒烟(真实 git, 需在仓库内运行)
eslint .                   # 仓库统一 lint(client bundle 按惯例忽略)
```

> 三者均已接入根 `package.json` 的 `test` / `check` 与 `justfile test`。

## 术语

「cwd」「可见组 / 隐藏组 / 忽略组」「悬浮面板」「细条」「图钉」「联动」「diff 范围」「分支」「查看分支」「文件搜索」「提交历史」「刷新」「cwd 缓存」「树面板」的定义见仓库根 `CONTEXT.md`。
