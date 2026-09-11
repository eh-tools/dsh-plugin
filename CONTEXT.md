# dsh-plugin(DeepSeek Harness 插件仓库)

本仓库承载 DSH 的静态双半插件(Host 半 `lib/index.js` + Client bundle `lib/client.js`),每个插件是 `plugins/` 下的独立 npm 包,经 `dsh plugin --profile web add link:<abs-path>` 挂载进 web profile。插件共享同一套挂载契约:`package.json` + `manifest.json` + `cordis.patch.yml`。

## file-git-explorer(官方右侧栏 Git 树 + 终端插件)

> **v0.6 重建**:本插件现在只做两件事 ——「官方右侧栏的 Git 树页签」与「真 PTY 终端」。
> v0.2 的自带文件树(可见 / 隐藏 / 忽略三区)、文件搜索、编辑保存、`.http` 运行、
> shell 行 / 单槽 / 尾部输出窗、悬浮面板 / 细条 / 图钉 / 离场 / 避让 / 联动 / 行操作 /
> 更多菜单 / 树面板 / cwd 缓存等概念**已整体移除** —— 文件树改由 `files-lite` 接管官方
> `kind: 'files'`,只读浏览交给 agent 的 glob/grep/edit 工具。
> 下表**仅**保留仍然成立的词条;旧词条不再有效,出现即属误用。

**Git 树页签(git tab)**:
本插件在官方右侧栏注册的页签类型(kind `fge-git`,`extension` 档 —— 全新 kind,不与任何 builtin 争位),页签体内是**视图栈**:变更列表(默认)→ 单文件 diff → 提交历史 → 提交详情。头部 `‹` 返回上一层。只读:不改仓库状态、不切换分支。
_Avoid_: 右树、侧边栏、面板

**变更列表(change list)**:
Git 树页签的默认视图 —— 工作区相对 `HEAD` 的全部变更(已暂存 + 未暂存 + 未跟踪),每项带单字母徽标(`M`/`A`/`D`/`R`/`C`/`U`/`?`),按路径排序、未跟踪沉底。数据由**一条** `git status --porcelain=v2 -z --branch` 命令取得(不再是 v0.2 的 4 连发)。
_Avoid_: 文件树、改动列表

**diff 范围(diff scope)**:
**工作区相对 HEAD** 的变更 —— 不是两分支之间、也不是两次提交之间的 diff。rename/copy 用 `-M -- <新> <旧>` 双路径取 diff;未跟踪文件 git 没有 diff 可比,host **不读盘**,只回报 `kind:'untracked'` 由客户端给提示。
_Avoid_: 分支间差异、提交间差异

**提交历史(commit history)**:
Git 树页签内按时间倒序列出「查看分支」提交的视图,50 条/页。点某条**在页签内**看完整提交说明与文件级 ±行数,再点某条文件记录看该次提交里该文件的 diff。**merge 提交只显示说明、不展示 combined diff**(无阅读价值)。
_Avoid_: 日志、git log(那是实现命令)

**查看分支(viewed branch)**:
提交历史所跟随的分支,默认 = 当前分支;只决定「看哪个分支的历史」,**不切换工作区的实际分支**。点选「当前」即回到默认态。
_Avoid_: 切换分支、上次查看

**刷新(refresh)**:
**自动刷新**在 agent turn 结束时触发(会话 `running` 由 true→false,1s 冷却),只重取 status 与已打开的提交历史;**页签不可见时挂起、可见时补刷**;自动刷新**不做网络请求**。**手动 ⟳** 先 `git fetch --all --prune`(非交互、限时 8s、失败放行),再重取 info + status。
_Avoid_: 轮询、fs.watch(本插件未用)、手动刷新(那只是刷新的触发之一)

**终端页签(terminal tab)**:
本插件在官方右侧栏注册的第二个页签类型(kind `fge-shell`),页签体是一个**工作区终端**。
_Avoid_: 控制台、shell 面板

**终端抽屉(terminal drawer)**:
收起态只在 `conversation.composer.dock` 座位里留一条细舌;展开时**在流内推挤会话列**(刻意不做 fixed 悬浮)。上缘拖柄调高度(20%~70%,按工作区记忆)。`✕` 只是收起抽屉、**不杀进程**;`■` 才终止整棵终端进程树。Esc 焦点分流:焦点在终端内 → 发给 PTY,焦点在终端外 → 收起抽屉。
_Avoid_: 底部面板、浮层、fixed 悬浮

**工作区终端(workspace terminal)**:
按归一化 + 大小写折叠的 cwd 键控的常驻 PTY,**每工作区一个**;同工作区的多个客户端**共享同一终端**(输出广播,任意一端皆可输入)。跨抽屉关闭 / 切会话 / 页面刷新存活,全局上限 16 个按 LRU 淘汰。进程**不进 `ctx.jobs`** —— jobs 的语义是「会话销毁即取消」,与「终端要跨会话存活」矛盾,故本插件自管生命周期,卸载时统一收掉。
_Avoid_: 会话终端、shell 行、后台任务(那是 `ctx.jobs` 的概念)

**回放缓冲(replay buffer)**:
每个工作区终端保留的 **256KB** 尾部输出,供重开抽屉 / 刷新页面重连时补发。用**绝对字节位**寻址(客户端记住自己读到的位置),因此不因缓冲修剪而错位;客户端位置早于缓冲起点时标记 `lossy`。
_Avoid_: 日志、scrollback(xterm 自身的滚动区是另一回事)

**工作区(workspace)**:
本插件的 cwd —— 当前会话的工作区目录(经 `useSessions` 的 `byId[].cwd` 感知),会话没有 cwd 时回退 DSH 进程的当前工作目录。它是 Git 状态与工作区终端的**唯一**根。
_Avoid_: 项目根、仓库根(仓库根是它向上找到的第一个 `.git`,是另一个概念)

## db-console(数据库控制台插件)

**数据库页签(database view)**:
注册进会话头部的第三个视图(id `database`),与对话、轨迹平级、排在轨迹之后。v0.2 时它与 file-git-explorer 的左右树面板联动(进入收细条、切回按快照还原);fge v0.6 移除面板后该联动已不存在,本视图不再需要协调。
_Avoid_: 数据库标签页、DB 标签

**数据库连接(database connection)**:
项目级**单例**——隔离键与「cwd 缓存」同口径(仓库根 = cwd 向上找到的第一个 `.git` 所在目录,无仓库退化为 cwd 本身),一个项目至多一条,以完整 PostgreSQL 链接串描述,**明文**持久化在 Host 侧(UI 打码展示、配置文件权限收紧);切换项目即面对另一条连接。没有连接列表、没有命名连接,也不做加密。
_Avoid_: 多连接、连接管理器、工作区级(隔离的是项目,不是 DSH 会话工作区)、加密(明确放弃)、主口令(随加密一并放弃)
