# dsh-file-git-explorer

左右树浏览插件 —— 左侧**文件树**(可见 / 隐藏 / 忽略三区, 根 = DSH 进程 cwd) + 右侧 **git 树**(当前分支只读下拉、工作区变更列表、悬浮 diff)。两个面板夹在会话 header 与 composer card 之间, 可左右拉伸、可收起为细条、图钉锁定, 不覆盖主对话区。

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

- **几何**: 两面板 `position:fixed`, `top` = `[data-conversation-scroll]` 顶部(即 header/tablist 边框线), `bottom` = `[data-composer-card]` 底部。左树左缘跟随应用侧边栏右缘(折叠成 rail 时自动跟随), 右树右缘在 details 列打开(360px)时自动让位。滚动 / resize / 侧边栏折叠 / 会话切换都通过事件重测锚点(无定时轮询)。
- **拉伸**: 面板内侧边缘有 6px 拖柄, 水平拖动改宽度; 钳制上限 = 对话区与对应侧之间的留白, **永不覆盖主对话区**。
- **收起 / 细条**: 面板头部「» / «」按钮收起为同侧 26px 细条, 点击细条重新展开。
- **图钉 📌**: 钉住后两个面板都不能收起(按钮置灰, 点面板外也不会自动收起); 未钉住时点击面板外任意位置, 两个面板自动收起为细条。
- **刷新 ⟳**: 重读 `info`(cwd / 仓库根 / 当前分支) + 重跑 git status, 并作废三棵树已加载的缓存。

### 左侧文件树(三区, 独立滚动)

| 分区       | 内容                                | 展开语义                                                                         |
| ---------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| 可显示文件 | 非点开头 且 未被 .gitignore 忽略    | 每级只展示本区成员                                                               |
| 隐藏文件   | `.` 开头(排除 `.git` 内部结构)      | 普通目录只展示其 dot 子项; 点开的 **dot 目录**展示其全部子项                     |
| 忽略文件   | .gitignore 忽略项(含被忽略的点文件) | 普通目录只展示其忽略子项; 点开的 **被忽略目录**(如 `node_modules`)展示其全部子项 |

- 逐级懒加载: 点目录才拉取子节点(`POST /fge/api/tree`), 无定时扫描。
- 点**文件** → 行高亮 + **内容悬浮面板向右浮出**(可越过对话区, 文本 + 行号 + 迷你语法高亮; >1 MiB 或二进制只显示提示、不预览)。
- 点文件同时触发**联动**: 右侧 git 树若存在该文件 diff, 滚动定位并闪现高亮; **不自动打开 diff**; 无 diff 则无操作。
- 目录单击 = 展开 / 折叠切换。

### 右侧 git 树

- 顶部: 当前分支(实时读 `git branch --show-current`), 点击弹出**所有分支下拉**(本地 / 远程分组, 只读, 不支持切换; 点非当前分支仅标记「上次查看」)。
- 下方: 工作区相对 **HEAD** 的变更列表(已暂存 + 未暂存 + 未跟踪), 平铺 + 状态徽标(`M`/`A`/`D`/`R`/`U`), 按路径排序。
- 点变更文件 → **diff 悬浮面板向左浮出**(unified, 行级 +/− 着色; 未跟踪文件显示内容; rename 用 `-M` 双路径 diff; 二进制显示提示)。再点同一项或点 ✕ 关闭。
- 非 git 目录: 右侧树显示「(工作区干净)」占位, 分支区为空。

## cwd 缓存

- 树根 = DSH 进程 `process.cwd()`, 无路径切换框(设计决策, 见 CONTEXT.md「cwd」)。
- 按仓库根(`repoRoot`, 无仓库时按 cwd)在 `localStorage`(`fge-cache-v1`)记忆: 面板宽度、展开 / 收起状态、下拉里「上次查看」的分支; 切回同一仓库自动恢复。当前分支始终实时读取, 不缓存。

## HTTP API(host 半, 仅本机)

信任栅栏与 `dsh-ds-balance` 同款: 仅回环地址 + `x-dsh-plugin: 1` 头 + POST。所有路径做防穿越校验(文件树/file 只能落在 cwd 之下, diff/status 的仓库根必须是 cwd 的祖先)。

| 路由                   | 请求体                           | 返回                                             |
| ---------------------- | -------------------------------- | ------------------------------------------------ |
| `POST /fge/api/info`   | `{}`                             | `{cwd, repoRoot, branch}`                        |
| `POST /fge/api/tree`   | `{path, mode, reveal}`           | 目录三区条目 `[{name, rel, type, dot, ignored}]` |
| `POST /fge/api/status` | `{repoRoot}`                     | `{current, branches[], changes[]}`               |
| `POST /fge/api/diff`   | `{repoRoot, path, status, from}` | `{kind: 'diff'\|'untracked', text, ...}`         |
| `POST /fge/api/file`   | `{path}`                         | `{text, binary, truncated, size}`                |

git 一律经 `subprocess` 服务执行(argv 数组, 无 shell)。

## 实现事实(已用真实仓库实测钉死)

- `git status --porcelain=v1 -z`: 条目 NUL 分隔; rename 是两条 —— `R  <新路径>\0<旧路径>\0`(状态 token 带新路径, 裸 token 是旧路径)。
- `git check-ignore` 必须 `--stdin -z`(argv 模式不允许 `-z`), 只输出命中的路径(exit 0 = 有命中, 1 = 无)。
- `git diff HEAD -- <新路径>` 对 rename 只会显示 new file, 必须 `-M -- <新> <旧>` 才能出 rename diff; 未跟踪文件 diff 为空, 回退读内容。
- 非 ASCII 路径在 diff 里默认 octal 转义, 统一加 `-c core.quotepath=false`。
- 面板锚点全部用稳定 data 属性: `[data-conversation-scroll]`、`[data-composer-card="true"]`; 对话列宽读 `--dsh-chat-content-width`; 不依赖任何哈希类名(`uV2eYG_*`/`wSkVaW_*` 等跨构建不稳定)。

## 测试与静态检查

```bash
node tests/git.test.mjs    # 纯函数层单测(status 解析 / 三区划分 / 防穿越 / diff 参数)
node tests/verify.mjs      # host 集成冒烟(真实 git, 需在仓库内运行)
eslint .                   # 仓库统一 lint(client bundle 按惯例忽略)
```

> 两者均已接入根 `package.json` 的 `test` / `check` 与 `justfile test`。

## 术语

「cwd」「可见组 / 隐藏组 / 忽略组」「悬浮面板」「细条」「图钉」「联动」「diff 范围」「分支」「cwd 缓存」「树面板」的定义见仓库根 `CONTEXT.md`。
