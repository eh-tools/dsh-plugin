# dsh-file-git-explorer

官方**右侧栏**里的 Git 页签 + 详情悬浮面板 + 对话下方的终端抽屉。

- **Git 页签**(kind `fge-git`, docked 常驻): 头部一颗**分支按钮**(当前分支 + 上游 `↑ahead ↓behind` 徽标),
  点它弹出**分支小浮窗**(本地 / 远程分支树, 点一条即切「查看分支」; 远程按 remote 名分层);
  正文是**上下两栏** —— 上栏**变更列表 / 当前 diff**(默认 3/4)、下栏**提交历史**(分页)或**聚焦提交**,
  两栏各自滚动, 中间拖柄可调占比;两份列表都**按目录归类**、带**层级线**;
  点一条提交 = **聚焦**它(下栏整栏只剩这一条, 顶上带返回, 说明默认折两行、可展开), 点任一文件 → diff 进**悬浮面板**。
- **详情悬浮面板**: 视口 1/2 宽、满高、紧贴右栏左缘。承载两种东西 —— 官方**文档正文**(官方文件树点开、
  聊天里的文件链接), 与本插件的 **diff**。同一时间只有一个, 开新的先关旧的, 观感即「就地换内容」。
  文件内容**不自己渲染**: 本插件只是把官方正文页签 `ctx.sidebarRight.float()` 起来, 于是
  markdown / 代码 / 图片 / html / **pdf 全部是官方原版**; diff 用官方 `primitives.DiffBlock`。
- **终端抽屉**(kind 无, 座位 `conversation.composer.dock`): **真 PTY** —— `node-pty` ↔ WebSocket ↔
  `xterm.js`, 所以 vim / htop / 颜色 / 补全 / Ctrl+C 全部可用。收起态是 composer 下方一枚透明 chevron,
  点击**向上**展开;**宽度与 composer 卡片(uV2eYG_card)完全一致**, 配色全走主题 token,
  顶上是 Windows Terminal 观感的**终端标题条**(页签上的 `×` / 点条空白处收起, 右端**终止键**才杀进程);
  **展开就自动聚焦终端**(不用再用鼠标点一下就能打字 —— 代价是那一刻 `Esc` 归终端, 想收起点条空白处);
  终端里**选中即复制**(拖选 / 双击 / 三击, 松手就进剪贴板), **Alt+C 兜底**; 条右侧那枚**开关**可以关掉自动那条。
  **拖到内容下面那片空白里也不会选出一堆空行**(选区尾巴收到最后一行有内容处)。
  终端只有这一种形态(没有右栏终端页签)。
- 文件树**回归官方**: 本插件既不接管、也不自绘文件树。**右栏默认铺两格** —— 官方「工作区文件」+ 本插件的「Git」,
  且 **Git 是打开右栏时当前显示的那一格**(见实现事实 §9)。

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

右栏点「Git」。页签正文是**上下两栏**, 两栏**各自滚动**、各自吸顶:

```
头部:分支按钮   当前分支(带分支图标 + 箭头);点它弹出**分支小浮窗**(见下)+ 上游 ↑↓ + 刷新图标
── 上栏(默认占正文 3/4)──────────────────────────────────────────────
变更列表        工作区相对 HEAD 的全部变更(已暂存 + 未暂存 + 未跟踪), 按目录归类 + 层级线, M/A/D/R/U/? 徽标
── 拖柄: 拖动调占比、双击回到 3/4 ────────────────────────────────────
── 下栏(默认占正文 1/4): 两种形态二选一 ──────────────────────────────
① 提交历史      按时间倒序; 节头显示正在查看哪个分支 + 每页 50 条
     └─ 点一条提交 = 聚焦它(见 ②); 行尾 hash 胶囊点一下复制完整 hash
     └─ 加载更多…  每页 50 条
② 聚焦提交      ← 返回 | 作者 · 时间 | hash 胶囊   ← 标题栏
     提交说明(默认折两行,放不下才有「展开 / 收起」)
     文件清单(±行数, 按目录归类 + 层级线)
       └─ 点文件 diff 进悬浮面板
```

- **头部**:分支按钮**撑满到刷新键之前**(吃掉头部剩余空间)—— 整条都能点开分支小浮窗,分支名长了在按钮里省略号截断;
  `↑ahead ↓behind` 徽标与刷新键靠右。
- **上下两栏**:上栏是**变更列表 / 当前 diff**(默认占正文 **3/4**),下栏是**提交历史列表**或**聚焦提交** —— 两栏**各自滚动**,
  互不牵连(上栏滚到底不会把历史顶走)。中间那条**分界线本身就是拖柄**(线 1px、热区 5px,
  **悬停不变色**, 只把指针变成 `ns-resize` —— 与终端抽屉上缘那条同一口径),按正文高度换算、钳在 **40%~90%** ——
  也就是**下栏最多占 60%**(往上拉不会把变更列表挤没;正文高度 = 整页减 38px 页签头,所以这条约束对整页只会更严),
  下栏最少留 10%。**双击拖柄回到 3/4**。拖过的比例记在 `localStorage`(刷新 / 切会话都在),没拖过就是 3/4。
- **标题栏**:两栏顶上那条(「变更列表 N」「提交历史 · 查看 main」、以及聚焦提交的返回条)是**不透明的实色横条**,
  下边压一条 `.5px` 细线 —— 滚上来的行被它挡在下面,不会从字缝里透出来。
  ⚠ 底色是**两层**:底座是面板自己的实色 `--dsw-alias-bg-base`,主题强调色 `--dsw-alias-markdown-tag`
  只作为**叠加层**(`background-image:linear-gradient(…)`)铺在上面。**不要**把强调色直接当 `background`:
  它是"标签 / 芯片的填充色",语义上就是一层淡强调色 —— 官方两套主题恰好把它定成实色(#f1f3f5 / #2c2c2e),
  但**由强调色派生的主题会把它做成半透明**(本机 Sage Mist 就是 `rgba(135,186,129,0.14)`):那样横条是透的,
  行照样穿过去。叠在实色面之上就与它的 alpha 无关了。
- **聚焦提交**:点一条提交,**下栏整栏**换成"只有这一条"(见上 `②`)。顶上标题栏是 `← 返回` |
  `作者 · 时间`(放不下就省略号)| **hash 胶囊**(与返回键永不被截断);
  **Esc 也能返回**,分层与插件其它 Esc 一致:浮着的 diff 面板先被关掉,再按一次才返回列表(焦点在终端里时不抢)。
  进聚焦时下栏**自动放到最大(60%)**,返回时还回进聚焦前的比例 —— 但**聚焦期间自己拖过拖柄**的话,以那个新值为准。
  聚焦态整栏有一层**极淡的品牌色底**当容器感(上栏不受影响)。
- **返回不重新刷新**:列表本来就还在(只是被聚焦态顶掉了),返回**不重新拉取、也不补刷**,而且**滚回你点进去时那一处**。
  聚焦期间 turn 结束的自动刷新**挂起**(且不补刷)。
- **按目录归类 + 层级线**:两份列表都按路径折成**目录树**, 而不是每个文件都从头平铺一遍完整路径 ——
  同一个目录只出现一次目录行(前面一枚文件夹图标),文件名以 **basename** 缩进列在它下面
  (`a/a1`、`a/a2` → 目录行 `a`, 底下 `a1`、`a2`);**一层只套一个目录、自己又没有文件的链并成一行**
  (`plugins` → `file-git-explorer` → `lib` 压成 `plugins/file-git-explorer/lib`)。
  目录在前、文件在后;完整路径仍在 `title`(悬停可见),请求 diff 用的也是完整路径。
  层级由**纵向虚线**画出来:每一层一条(吊在该层目录的文件夹图标下方),从目录行连到它**最后一个子项的行中**,
  组与组之间天然断开。
- **hash 胶囊**:提交历史每行第二行末尾那枚短 hash(等宽字体)。**点一下复制完整 hash**(不是显示的那个短的),
  复制后它自己变成「已复制」/「复制失败」,1.2s 后变回短 hash;`stopPropagation` 保证这一下**不会**连带聚焦这条提交。
- **提交说明折两行**:聚焦后最上面那块说明默认**只显示两行**(右栏最窄 200px,一段带 body 的 message
  铺开会把下面的文件清单挤出视野);**放不下**才出现「展开 / 收起」,点开看全文;
  短于两行的说明没有这枚按钮。是否放得下是**量**出来的(`scrollHeight > clientHeight`),不按行数猜 ——
  一行很长的 subject 折行后同样给得出出口。**开关独占一行、左对齐、画在说明文字的上方**:
  展开之后它原地不动(不往下跑、也不用拉滚动条去找「收起」)。
  **展开后这一段自己滚**(最多约 14 行),于是它不会把整栏撑长,下面的文件清单与开关都留在原地;
  两栏外层的滚动条都不显示(见 §14),所以不会出现"双重滚动条" —— 这一段自己那条是**唯一**的滚动条。
  展开态与「聚焦的是哪一条」一起按会话缓存,点文件开 diff 再回来仍在。
- **右栏默认就有 Git**:新会话打开右栏时,页签条上是**官方「文件」+ 本插件的「Git」两格**,且 **Git 是当前那一格**
  (官方那条"guide 恰好一条才作默认"的规则见实现事实 §9;想让「文件」当默认那格,把两次 `openTab` 调过来即可)。
- **快捷键**:见下表;焦点怎么分流、什么情况下不接、为什么挂在 `window` 捕获 —— 见实现事实 §15。

  | 键                | 作用                           | 口径                                                       |
  | ----------------- | ------------------------------ | ---------------------------------------------------------- |
  | `Alt+J` / `Alt+L` | 右栏页签**左 / 右**切一格      | **到边不环绕**;算的是页签条上视觉相邻的那一格              |
  | `Alt+Ctrl+R`      | **刷新 git**(= 页签上那枚 `⟳`) | **任何焦点下都能触发**(含终端里);不在 Git 那格时切过去再刷 |
  | `Alt+C`           | **复制终端当前选区**           | 终端平时是"选中即复制",这一按是兜底                        |

- **分支小浮窗(查看分支)**: 点头部那颗分支按钮弹出一个小浮窗, 里面是**分支树** ——
  `本地分支` 一组(平铺)+ `远程分支` 一组(先按 remote 名分一层, 分支缩进在下面)。
  点任意一条(本地 / 远程都行)就把「查看分支」切到它, 立刻重取该分支的提交历史; 点文件照样出 diff。
  当前**检出**的分支标「当前」, 正在**查看**的标「查看中」。
  ⚠ 它只决定「看哪个分支的历史」, **不切换工作区的实际分支**(头部的分支名不会变)。见 `CONTEXT.md`「查看分支」。
- **变更列表**: 相对 `HEAD` 的全部变更, 按路径排序, 未跟踪沉底(上屏时按目录归类, 见上); 点一行即出该文件的 diff。
- **diff**: rename 用 `-M` 双路径 diff; 未跟踪文件 git 没有 diff 可比, 给明确提示(host 不读盘)。
- **merge 提交只显示说明**, 不展开文件(combined diff 没有阅读价值)。
- **点文件看 diff 不会打断这里**: 打开的 diff 页签会浮起来, 回到 git 页签时**聚焦态 / 列表 / 滚动位置原样保留**
  (不会重新拉取、不会闪 —— 数据按**工作区**、视图状态按**会话**缓存在模块级, 见实现事实 §10)。**手动刷新也不会把你从聚焦里踢出来。**
- **切会话不再重读一遍**: 同一个工作区的两个会话看的是同一个仓库, 换个会话直接复用那份数据
  (30s 内一次请求都不发; 更久则先把快照铺上屏、再后台重取)。见实现事实 §10 与 `CONTEXT.md`「工作区快照」。
- **自动刷新**: **agent turn 结束时**(会话 `running` true→false)自动重取变更列表与历史首页, 1s 冷却;
  页签不可见时**挂起、可见时补刷**;**聚焦提交期间挂起且不补刷**。**自动刷新不 fetch** —— 避免每个 turn 都打一次网络。
  提交详情是不可变的, 不重取。
- **刷新键 = 官方 SVG 图标**(`primitives.IconRefreshOutline14`): 原来那个 `⟳` 是**文字字形** —— 同一个码位在
  不同平台 / 字体回退下画出来的粗细、大小、基线都不一样(Windows 上明显偏细偏小), 与旁边的分支 / 箭头图标
  **不是一个画风**; 换官方图标后头部三枚图标(分支 / 上下游箭头 / 刷新)是同一套线条。
  **busy 时的进度提示**: 按钮忙时本就是 `disabled`(暗到 `.45`), 图标**借这个状态自转**
  (`.fge-refresh[disabled] svg{animation:fge-spin 1s linear infinite}`), 于是原来那个 `…` 字符功成身退 ——
  它与图标不能并存(会变成"图标 + 省略号")。图标按钮**没有文字**, 所以补了一枚 `aria-label: '刷新'`。
- **手动刷新**: 先 `git fetch --all --prune`(非交互、限时 8s、**失败放行**), 再 `info` → `status` → 历史。
- 小浮窗: 点外面 / 点一条分支 / 按 **Esc** 都会收起。

### 详情悬浮面板

- 打开文件(官方文件树点行、聊天里的文件链接)或点 diff **都会浮出同一个面板**。
- **同一时间只有一个**: 打开第二个会先关掉第一个的页签, 于是看起来就是内容就地更换。
- **不闪、也不换页签**: 详情**只以浮层出现** —— 页签条上不会先冒出一枚详情页签再消失;右栏也**不会自己跳页签**,
  从哪一格点的就停在哪一格(从「文件」点文件之后仍是「文件」, 不会跳到 git 树)。
  两条都是官方座位 / dockkit store 的时序问题, 成因与修法见实现事实 §12。
- 切换会话 / 切换工作区 / **右栏折叠** / 按 **Esc** 都会把它关掉。
  (Esc 与终端抽屉共用同一条焦点分流: 焦点在终端里时 Esc 归终端, 不动面板。)
- 悬浮面板头部那枚「送回侧栏」**已由本插件藏掉**(用户口径): 它会把详情变回右栏页签, 与"详情只以浮层出现"相反。
  纯 CSS, 且**只对本插件自己的详情浮窗生效** —— 判据是标题里有本插件的文件名芯片; 官方浮动宿主是所有页签共用的,
  别的页签被拖浮起来时还得能送回去, 见实现事实 §11 第 2 条。
  ⚠ 这条推翻了 `docs/adr/0002` 里"该按钮不可移除"那句已知代价, 已在 ADR 里补了修订说明。
  (仍有别的路会把详情变回右栏页签 —— 拖页签 / 页签菜单; 那时再点同一个文件会重新浮起。)
- **头部有一枚「全屏」**(本插件加的):点它 → 详情面板**铺满整个视口**(左栏、中栏一起被盖住),
  再点一次(图标变"按下"态、提示变「退出全屏」)回到原来那份几何(**1/2 宽、贴右栏左缘**, 与浮起时一致)。
  ⚠ 它**只出现在详情浮窗里** —— 同一个标题槽在页签条上也渲染, 那里没有这枚按钮。
  ⚠ 全屏时按 **Esc** 是**关掉整个面板**(不是先退出全屏) —— 沿用"Esc 关详情"这条既有约定。
  原理: 官方没有移动/缩放浮窗的公开接口, 所以这是"只改画法"的 CSS 覆盖(见实现事实 §11 第 4 条)。
- 悬浮面板可以拖动 / 缩放(官方 chrome), 也可以拖走 —— 因为同时只有一个, 拖走不会与其他面板重叠。

### 「复制内容」芯片

官方文档页签的芯片由本插件**影子替换**(见下方实现事实), 复刻官方外观(`FileTypeIcon` + 文件名),
并在后面加一枚**复制图标**: 复制该文件**磁盘上的原文**(经官方 `remote.workspaceFiles.readAll`),
与预览是否渲染完无关。`html` / `pdf` / 图片等**渲染型**文件不出现这枚图标(没有「原始文本」)。

- **文件名本身也可以点**: 点一下就把**文件名**(你点的是什么就复制什么)放进剪贴板, 反馈是把它染一下色
  (1.2s, 不换文字 —— 换成"已复制"就看不见自己点的是哪个文件了)。⚠ 这一下**不吃掉点击**:
  这个标题同时出现在页签条与浮窗头部, 在页签条里还要让点击继续走到官方那层去"选中这个页签"。
  ⚠ 判定"这算点击"用的**不是 `onClick`, 而是「按下 → 抬起, 位移未达 4px」** —— 页签条与浮窗头部
  都在 `pointerdown` 时对**自己** `setPointerCapture`, 那之后 mouse/click 全被重定向到捕获元素,
  我们这层更深的子元素根本收不到 `click`(见实现事实 §11 里「文件名点击判定」那一条)。把页签**拖走**不会顺手复制文件名。
  **两条详情路径都成立**: 文档类的影子页签(标签是文件名)与 git 里点文件出的 diff 芯片(标签是路径)。
- **标题不再被提前截断**: 真因是**页面签**被官方钉在 `min-width:80px; max-width:170px`(浮窗里那个标题
  就是同一个页签元素), 不是标题自己有上限 —— 见实现事实 §11 第 3 条。插件只放开**浮窗里**那一格,
  页签条里的版式不动;本插件自己那条 `.fge-chip-label{max-width:22em}` 也一并撤了。

> diff 悬浮面板的芯片**不需要**复制图标: 官方 `DiffBlock` 自带复制按钮, 复制它重建的 `- `/`+ ` 文本。

### 右栏外观(覆盖官方 chrome)

这几处是**本插件对官方右栏的覆盖**, 都在 `ensureStyles` 的样式里(原理与依赖见实现事实 §11):

- **宽度可拖, 上限 = 15% 视口**(常量 `RIGHTBAR_MAX_VW`): 官方首开宽度是视口的 45%(1920 上就是 864px),
  中栏被挤到只剩 776px; 现在右栏拖柄可拖, 范围 **200px ~ 15vw**(1920 上 200–288px), 且**仍然占真实一格轨道** ——
  打开右栏是**把中栏挤窄**(不是浮在上面盖住它), 折叠时这一格宽度立刻还给中栏。拖过的宽度**记住**
  (`localStorage`, 刷新 / 切会话都在)。
- **右栏顶部: 「收起」+「进全屏」+「+ 新页签」**; 只隐藏「分栏」。**「进全屏」点一下, 右栏铺满整个视口**
  (官方做法: 面板自己变成 `position:fixed;inset:0`), 再点一次退出 —— 它与「退出全屏」是**同一个按钮**
  (非全屏时带 `data-sidebar-right-mode="fullscreen"`, 进全屏后才变成 `"push"`)。本插件的限宽**只针对非全屏**
  (`[data-sidebar-right-panel="push"]`), 所以全屏铺满是官方原样, 见实现事实 §11 第 2 条。
- **右栏左缘那条 8px 的拖柄**就在面板边界上, 悬停会出现一条 3px 竖条提示。

### 终端抽屉

- **抽屉舌**: composer 下方一枚透明 chevron(无边框, 只留一枚小三角), 点击**向上**展开。
  **抽屉舌与抽屉的宽度都跟 composer 卡片一致**(见 §14 的宽度公式:`width:calc(100% - 2*--dsh-composer-side-clearance)` + `max-width:--dsh-composer-card-max-width` + `margin-inline:auto`)——
  就是顶部那条 `wSkVaW_widthHandle` 拖出来的宽度: 座位本身是整条中栏, 直接用 `width:100%` 会比 composer 卡片宽出一截。
  零测量、零 JS(拖那条手柄时变量一变抽屉跟着变, 里面的 xterm 由 ResizeObserver 自动 refit)。
  抽屉**顶部两角圆角**(`border-radius:12px 12px 0 0`), 底部不圆。
- **终端标题条**(terminal title bar): 顶上一条 Windows Terminal 观感的标题区 —— 一枚页签(`>_` 字形 +
  **尾部省略号**截断的工作区路径 + **悬停才出现**的 `×`)加右端一枚**终止键**(官方 SVG `IconStopFill16`)。
  页签**恒定只有当前工作区这一枚**:
  它长得像页签, 但**不是多页签容器**(每工作区仍是一个终端, 见 `CONTEXT.md`「工作区终端」)—— 外观档,
  没有 `+`、没有多终端、没有重命名与排序。**条自己不带底色**(透出抽屉表面), 与终端体的分界交给下面那条 1px 线。
  **抽屉本体四周有描边**(上 + 左右各 1px `border-l2`, 下边贴座位底不画): 只画上边时, 标题条这一段自己不带底色,
  它跟终端体的接缝就只剩下面那条分隔线 —— 观感上 grip 与 body 之间"断了一截"(用户口径的断层感)。
  官方 composer 座里的横条本来就是四周描边的(`.nLMEza_bar{border:.5px solid var(--dsw-alias-border-l1)}`)。
- **`×` = 收起, 终止键 = 杀进程**: 页签上的 `×` 与点条空白处等价(**收起抽屉, 不杀进程**); 右端**终止键** =
  **终止整棵终端进程树**(Windows 下走 ConPTY 终止整树), 取主题的危险色 `--dsw-alias-state-error-primary`,
  悬停用 `--dsw-alias-interactive-bg-hover-danger`。条内按钮自己 `stopPropagation`, 点它们不会连带收起。
  终止键里的图标是**官方 SVG**(`primitives.IconStopFill16`, 尺寸 12, 取色走 `currentColor`) ——
  原来是文字字形 `■`, 与刷新键那个 `⟳` 同一个毛病: 同一个码位在不同平台/字体回退下大小与粗细都不一样。
  抽屉关闭 / 切换会话 / 刷新页面都**不影响**终端进程。
  primitives 的图标全表里**没有终端图标**(最接近的只有 `IconCodeOutline16`), 所以页签上的 `>_` 仍是自绘字形, 不引依赖。
- **展开就自动聚焦终端**(用户口径: 省掉"再用鼠标点一下才能打字")。做法与代价见实现事实 §13。
  ⚠ 代价: 焦点一进来 `Esc` 就归终端了, 所以**开抽屉后 `Esc` 不再收起抽屉** —— 想收起就点条空白处、
  页签上的 `×`, 或先把焦点点出去。
- **选中即复制, Alt+C 兜底; 条右侧有开关**: 拖选 / 双击选词 / 三击选行一松手就进剪贴板, 不用按任何键;
  **Alt+C** 是兜底(内容与"自动那次"相同时也强制重写)。条右端那枚**开关**关掉的是**自动**那条 ——
  关掉后 Alt+C 照旧可用、选区照样收尾巴;状态记在 `fge-term-copy-v1`(整机一个偏好, 默认开),
  点它不会连带收起抽屉。做法与实测见 §13。
- **选中不会漫到"内容下方那片空白"**(用户报的 bug: 拖到底选中一大堆空行, 复制出一串换行):
  拖蓝停在最后一行有内容处、松手后尾巴收到那一行, 复制出来**不带尾巴空行**;中间本来就有的空行照留;
  从空白往上拖同样收干净, 整段都拖在空白里则什么都不选。做法与三个与门见 §13。
- **页签样式**: 活动态页签底色取**终端表面色**(`--dsw-alias-markdown-code-block`, 与终端体同色)加两角 `6px 6px 0 0`;
  **页签与终止键在"拖柄 + 标题条"这条带子里垂直居中**(默认 `flex-start` / 贴底时它们会挨着下面那条分隔线,
  看着是沉在条底的);做法是条里 `align-items:center` + **下内边距比上边多 `拖柄高 − 分隔线高`** ——
  拖柄(5px)在条上面、分隔线(1px)在条下面, 两者把带子的中心往上推了 2px, 用下内边距补回来;
  拖柄高在 `.fge-term` 上以 `--fge-term-grip` 声明一次, 拖柄与这条内边距共用它。
  带子本就高过页签, 所以页签**不压** border(分隔线在它下面照样连续 —— 用户口径: 线要连贯, 不要在页签处断一截);
  `max-width:42%` 配 `text-overflow:ellipsis` 在**尾部**截断长路径, 与 Windows Terminal 同款。
  真机量过: 页签 / 终止键 / 带子三者中心重合(19.5px, 偏差 0)。
- **终端滚动条 = 6px 细条 + 圆角**: xterm 自带的是 **14px**(vscode 血统, `verticalScrollbarSize = overviewRuler.width || 14`),
  在这么窄的抽屉里又粗又占地方。它的宽是**内联样式**写死的, 只能用 `!important` 覆盖
  (`.xterm-scrollable-element > .scrollbar.vertical{width:6px!important}` + 滑块同宽 + `border-radius:3px`,
  与 dsh 自己的细滚条同观感); 滑块颜色仍由 xterm 主题算(跟随前景色)。
- **配色跟主题 + 两层分明**(为什么不用 `bg-base`: 见实现事实 §13): 抽屉 / 终端体 = 官方的**代码 / 终端卡片底色**
  `--dsw-alias-markdown-code-block`, 页签同色; 边界靠 `border-l2/l3` + 主题 token 文字色
  (`-label-*`)、按钮 hover 用 `-interactive-bg-hover`、终止键用 `-state-error-primary`, 明暗与自定义主题都跟得上。
- **终端自己的底色也跟主题**(坑与实测见实现事实 §13): xterm 的 `theme.background` **只认具体颜色** ——
  传入 `rgba(0,0,0,0)`(想"透明露出容器底色")会被判无效、静默回落到 xterm 自家的默认**纯黑**;
  而 `xterm.css` 又把 `.xterm-viewport` 写死成 `#000`。结果就是浅色主题下整个终端体是黑的, 与抽屉其余部分断开。
  现在按上面的表面 token 算成 `#rrggbb` 交给 xterm(与 CSS 同一只 token), 并用 CSS 覆盖 viewport 底色;
  切明暗主题时**已经开着的终端就地换色**(订官方 `theme/change`), 不必重开抽屉。
- **高度**: 上缘拖柄可调 **20%~70%**, 按工作区记忆在 `localStorage`(默认 40%)。
  ⚠ 这条拖柄**没有 hover 底色**(用户口径: "想拉伸抽屉时鼠标 hover 到边缘, 看到这条的底色跟旁边不一样")——
  它是一整条 5px 通宽的横带, 一亮就是一整条, 在抽屉边缘非常扎眼; 可拖的提示交给 `cursor:ns-resize`。
  git 页签里那条**分栏**拖柄 `.fge-grip` 已按**同一口径**去掉 hover 底色(见 §14)——
  两条拖柄的底色现在都恒为 `transparent`, 亮/暗与自定义主题下都不会再冒出一块跟旁边不一样的色块。
- **每工作区一个终端**(键 = 归一化 + 大小写折叠的 cwd): 切工作区就是切换终端; 同工作区多会话**共享同一终端**
  (输出广播, 任意一端都可输入)。全局上限 **16 个**, 超出按 LRU 淘汰最久未用的。
- **重连回放**: host 常驻终端并保留 **256KB** 尾部输出; 重开抽屉 / 刷新页面即重连并补发, 用**绝对字节位**寻址,
  因此不会因缓冲修剪而错位(客户端位置早于缓冲起点时标记 `lossy`)。
- **PTY 重启不叠 banner**(用户实测: "一进去就看到很多 `PowerShell … / PS …>`"): 两处一起修 ——
  ① PowerShell 家族 spawn 时带 **`-NoLogo`**(`shellArgs`), 不再每次启动都打一遍版本 banner;
  ② 上一次会话结束后重启时 **`ring.reset()`** 丢掉上一个进程的回放, 只留一条"上一次会话已结束"标记
  (原来是把旧缓冲当"上文"留着, 配上每次重启的 banner 就是 N 份叠在一起)。**同一次会话内**的重连回放照旧。
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
  (唯一的例外是 `-float-dock`: 它是**故意**被 §11 第 2 条那条 CSS 藏掉的, 不是替换弄丢的。)
  该槽**两处都渲染**(页签条与悬浮面板头部), 所以影子组件两种位置都要站得住。

### 6. 悬浮面板的几何

- `ctx.sidebarRight.float(tabId, rect)` 是公开接口, `rect` 原样生效(`{x, y, width, height}`, 视口坐标 ——
  悬浮面板宿主是 `position:fixed` 且 portal 到 `document.body`)。**只对 docked 页签生效**, 已浮起的页签是 no-op,
  且**无已挂载会话座位时抛错**(调用点容错)。默认几何是 380×300 + 每层错开 24px 的级联, 没有平铺 / 吸附 / 贴边。
  ⚠ 正因为**没有**"移动 / 缩放已浮起面板"的接口, 浮窗头上那枚「全屏」只能走 CSS 覆盖(inline 几何压掉),
  见 §11 第 4 条 —— 它不改官方那份 rect, 所以退出全屏能原样回去。
- **右栏左缘**的取法取决于右栏还有没有轨道:
  - **不覆盖宽度时**(官方 layout 原样): 右栏是真实的一格 grid track, 从 `[data-rightbar-col]` 的 `left` 量最稳,
    **不要**量里面的 `[data-sidebar-right-panel]` —— 面板靠 CSS `transform` 滑入滑出, 展开动画期间量它只会拿到中间值。
  - **本插件覆盖了宽度之后**(见 §11): 第三轨是固定 15vw(折叠时为 0), `[data-rightbar-col]` 本身仍然是一格
    真实轨道、`left` 依旧可用; 不过面板**右缘贴视口右缘**这条更直接, 所以现在用
    `left = innerWidth - panel.width`。`transform` 只平移不改宽度, 这个宽度在展开动画期间也是准的
    (量 `left` 才会拿到中间值)。两种取法都对, 面板那一种对"轨道与面板不等宽"的配置更稳。
- **右栏折叠必须显式关掉悬浮面板**: 悬浮面板在 `document.body` 上的一个 `fixed` portal 里(`z-index: 60`), 不随右栏滑走。
  本插件用一个只监听 `data-rightbar-collapsed` 的 `MutationObserver` 来关。
- **终端抽屉不参与这套几何**: 它在 `conversation.composer.dock` 里**宽度贯穿**整个座位, 既不用量也不用
  `--dsh-chat-content-width`。(该变量仍定义在对话根元素上, 座位在它的子树内 —— 以后要做居中的座位元素可以
  直接 `max-width: var(--dsh-chat-content-width); margin-inline: auto`, 零 JS。)
- **右栏内的小浮窗(分支树)要用 `position:fixed`**: 官方 `primitives.useAnchoredPosition({open, anchorRef,
panelRef, side, gap, margin})` 返回的是**视口坐标**(`{left, top}`), 且面板要能被它量到 `offsetWidth` ——
  所以那条规则是: 面板先渲染(位置未算出来时先 `visibility:hidden`, 布局 effect 跑完即可见)、用 `fixed` 定位。
  `fixed` 还顺带免疫右栏面板的 `overflow` 裁剪; 唯一要避开的是「面板正在做 transform 过渡」的那一瞬
  (有非 `none` 的 transform 时 `fixed` 会改为相对该祖先定位, 而展开态是 `transform:none`, 所以常态无碍)。
  关掉用官方 `primitives.useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef)`(第 4 个参数是
  "也算内部"的额外 ref)。

### 7. `DiffBlock` 的契约

`primitives.DiffBlock` props = `{diffs, labels, maxLines?, className?}`:

- `diffs: [{path, oldText, newText}]`, **一个 hunk 一条**; `oldText` / `newText` 已是拆好的行块(上下文两边各一份)。
- 它**不做 diff 比对**: `oldText` 整块当删除行、`newText` 整块当新增行。无行号、无换行开关、无二进制/mode 表达。
- 自带复制按钮(复制它重建的 `- `/`+ ` 文本)、折叠(`maxLines` 默认 16)、`└ +N -M · N files` 页脚。
- `labels` **必填 7 个键**: `copy` / `copied` / `files(n)` / `expand(n)` / `expandAria(n)` / `collapse` / `collapseAria`。

### 8. 正文渲染器的可复用性

markdown → `primitives.MarkdownText`、代码 → `primitives.CodeBlock`(**可用**); `text` / `image` / `html` / `pdf`
→ **不可复用**(组件未导出)。这正是 v0.7 改用「官方页签浮起来」而不是自绘悬浮面板的原因 —— 见 `docs/adr/0002`。

### 9. 右侧栏的默认页签: 官方 `defaultSeed` 的「恰好一条」规则

官方 `sidebar-right` 决定右栏首次展开时放哪个页签:

```js
const [only, ...others] = tabs.guide();
const kind = only !== undefined && others.length === 0 ? only.kind : GUIDE_KIND;
```

也就是 **guide 条目恰好只有一条时, 默认页签就是那一条; 两条及以上就落回 guide 列表页**。
(这也是 v0.6 时 `files-lite` 能让右栏默认显示文件树的原因: 那时 guide 里只有官方 files 的「工作区文件」一条。)

v0.7 保留了本插件的 guide 条目 —— 不然 git 页签**没有任何入口**(页签只能由 `openTab` 或 guide 胶囊打开,
而 guide 只列 `guide` 条目)。多出的一条把默认顶回了列表页, 所以本插件补一步把它拉回来:

- `conversation.composer.dock` 里另注册一个**空渲染**的座位(`fge-session-seed`), 每个会话只跑一次:
  右栏还是空的 / 只有 guide 时, 先 `ctx.sidebarRight.openTab('files')` 打开官方「工作区文件」,
  再 `ctx.sidebarRight.openTab(GIT_KIND)` 打开本插件的「Git」—— **后开的那格成为活动页签**,
  于是打开右栏直接是变更列表, 官方的文件树就在左边一格(用户口径: git 侧栏也像文件侧栏一样默认打开)。
  最后 `close()` 掉 guide 占位页(此时它不是唯一页签, 官方 `canCloseTab` 允许关)。
  想让「文件」当默认那一格, 把两次 `openTab` 调过来即可。
- **不抢用户已经开的页签**: 每次尝试前先看 `ctx.sidebarRight.active()`, kind 不是 `guide` 就直接放手
  (用户自己开的、或已经铺好的这两格, 都不会被再动一次)。
- 座位还没绑定时 `openTab` 会抛错, 按 20×150ms 退避重试; 用尽就静默放弃(这只是锦上添花)。
  ⚠ 两次 `openTab` 在**同一个 try 里**: 万一「Git」那一步抛了, 重试会把「文件」再开一次 ——
  同 kind 的页签不会开出第二格, 是幂等的。
- 依赖两个官方内部字面量: 页签 kind `'files'`(ui-sidebar-files)与 `'guide'`(sidebar-right 的 `canCloseTab`
  也按这个字面量判断)。两边改名时这里要跟着改 —— 失败是静默的, 只退化回官方默认行为。

### 10. 页签体只渲染**活动**页签 ⇒ 组件状态必须外置, 而且要**按两种键**分开放

dockkit 只渲染活动页签的页签体(`bodiesFor(panel)` 按活动页签派发, 其余 docked 页签的 body **不挂载**;
官方文档那句「docked bodies need an expanded sidebar and an active tab」说的就是这件事)。

本插件正好会**自己把活动页签换掉**: 点文件打开 `fge-diff` 页签并激活它 ⇒ git 页签体被卸载;
diff 页签浮起后离开页签条, git 页签又成为活动页签、**重新挂载**。状态只放组件里的话就会出现
「点一下文件, 历史列表闪一下、刚展开的提交被收起来」(真 boot 实测复现: 展开 1 条 + 4 个文件 → 点文件后归零)。

**切会话也是重挂** —— 每个会话的右栏页签是各自的一份, 所以组件拿到的 `sessionId` 一换, 页签体就是新实例。

于是模块级放**两份**缓存, 键不同、管的東西也不同:

| 缓存       | 键                              | 装什么                                                         | 为什么是这个键                                           |
| ---------- | ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `gitViews` | **会话 id**(并比对工作区 cwd)   | 视图状态: 查看分支 / 聚焦态 / 列表滚动 / 分栏比例 / 说明展开态 | 这些是「你看到哪儿了」, 各会话本来就该各看各的           |
| `gitData`  | **工作区**(`workspaceKey(cwd)`) | 数据: `info` / `status` / 历史首页                             | 同一个工作区的两个会话看的是同一个仓库, 没有理由各存一份 |

`gitData` 的复用判据是纯函数 `gitDataDecision(snapshot, cwd, now, GIT_DATA_FRESH_MS)`, 三选一:
`skip`(同工作区 + 30s 内, **一个请求都不发**)/ `revalidate`(同工作区但旧了: 快照照铺上屏, 后台重取)/
`load`(没有这个工作区的快照: 从头取)。离线护栏直接跑它, 并且用真实组件把「同工作区切会话 = 0 次请求」
钉死(`scripts/verify-client-bundles.mjs`)。

⚠ 这一步修的 bug: 数据原先与视图状态**一起**挂在会话 id 上, 于是同一个工作区换个会话被当成全新工作区,
`info → status → log` 再走一遍(真 boot 实测: 每次切换固定这三条, 200–730ms), 面板先白成
「读取中… / 读取历史…」再回填 —— 使用者口径就是"切个会话又要等它读一遍"。
自己实现"打开一个页签"时都要考虑这条。

⚠ 快照的 `history` 只收**当前分支第一页**(`history.ref === null`): 切回来时「查看分支」会被重置成
当前分支, 只有这一页与它对得上; 看过别的分支的历史只留在那个会话自己的视图里。

### 11. 右栏外观覆盖: 可拖宽度 + chrome 按钮(只藏「分栏」)

按用户要求, 本插件对**官方右栏的外观**做了几处覆盖(纯 CSS + 一个拖柄接管, 都在 `ensureStyles` / `attachRightbarDrag` 里):

- **1) 宽度 = 可拖, 范围 [200px, 15vw]**(常量 `RIGHTBAR_MIN_PX` / `RIGHTBAR_MAX_VW`)。官方**没有**公开的宽度 API:
  `setRightbar` 只存在于 layout 内部, 而且被钳制到 `[300px, 0.7×视口]`; 首开宽度还是
  `RIGHTBAR_DEFAULT_RATIO = 0.45`(1920 宽上就是 864px, 中栏只剩 776px)。所以走"改画法":
  第三轨与面板宽度都读**同一个 CSS 变量** `--fge-rightbar-px`(拖动过的 px), 没拖过就回落 15vw:

  ```css
  /* 展开: 真实第三轨 = 拖过的宽度(没拖过 = 15vw), 于是右栏"挤"中栏 */
  div:has(> [data-rightbar-col]):not([data-rightbar-collapsed]) {
    grid-template-columns: auto minmax(0, 1fr) min(var(--fge-rightbar-px, 15vw), 15vw) !important;
  }
  /* 折叠: 把这一轨还给中栏 */
  [data-rightbar-collapsed]:has(> [data-rightbar-col]) {
    grid-template-columns: auto minmax(0, 1fr) 0px !important;
  }
  [data-sidebar-right-panel='push'] {
    max-width: min(var(--fge-rightbar-px, 15vw), 15vw) !important;
  }
  ```

  ⚠ **第三轨绝不能写成 0**: 轨道为 0 时官方面板(`position:absolute; right:0`)会向左挂到中栏**上面**
  (官方注释原话 "it can hang over the centre when there is no track"), 观感是"浮了一层"而不是"挤" ——
  这条真踩过。轨道留成真实宽度 + 面板限到同宽, 面板就正好落在自己那一格里, 中栏被挤窄但不被遮住
  (判据: **面板左缘 == 第三轨左缘 == 中栏右缘**)。
  ⚠ **折叠时要把这一轨还回去**, 否则收起右栏聊天还是不宽 —— 所以按 `data-rightbar-collapsed` 分成两条规则。
  **左栏那一轨必须留给 `auto`** —— 官方侧栏组件自带宽度(`width` 从座位注入), `auto` 会收缩到它,
  收起成 56px 细条(实测 57px)、拖动变宽都照旧; 写成固定值就会把左栏写死。
  `!important` 是必须的: 官方把 `grid-template-columns` 写在 **inline style** 上。

- **拖柄由本插件接管**(`attachRightbarDrag`): 官方那根 8px 的 `.pI_x6G_handle[data-side="rightbar"]`
  本来就骑在边界上, 但它的 `left` 跟的是**官方**宽度, 而且官方的拖动会把值写进 layout store(还会钳到
  `[300px, 0.7×视口]`, 与本插件的区间冲突)。所以:

  - CSS 把它的定位改成 `left:auto; right:calc(<轨道> - 4px)` —— 不管官方值是多少, 它始终骑在**真实**边界上;
  - JS 在**捕获阶段**吃掉 `pointerdown`(`stopPropagation` 之后 React 的委托处理器收不到),
    按指针位移算宽度、钳进 `[200px, 15vw]`、写 `--fge-rightbar-px`、松手入 `localStorage`(`fge-rightbar-w-v1`);
  - 拖动期间给 frame 挂 `data-fge-resizing`: 关掉官方的 `transition:grid-template-columns`(慢过渡会让面板
    追不上指针)并把光标钉成 `col-resize`(指针滑出那 8px 手柄也还在拖);
  - ⚠ **存的是本插件落下去的那个值, 不是量出来的面板宽度**: 面板是 border-box, 量出来会比变量多 1px ——
    存那个值每拖一次就胖 1px(实测踩过: 200 → 201 → 202…)。

- **2) 隐藏「分栏」`[data-dockkit-split-button]` 与「进全屏」`[data-sidebar-right-mode="fullscreen"]`**:
  ⚠ 这两枚的取舍绕过一圈: 曾一起藏 → 把「进全屏」放回来 → **用户指出位置放错了**(他要的是
  **详情面板**全屏, 不是右栏页签条那一格)→ 又藏回去。所以现在还是"右栏顶部只剩「收起」与「+ 新页签」"。
  真正该有的那枚在**浮窗**上, 见下面第 4 条。
  ⚠ 值得记下的坑: 页签条那枚「进全屏」/「退出全屏」是**同一个按钮**(官方 `PanelChrome`:
  `next = fullscreen ? "push" : "fullscreen"`), 非全屏时才带 `"fullscreen"` —— 单看"真进全屏时
  退出按钮还在"会得出错误结论, 藏掉它等于非全屏时**永远进不去**。但这不构成放它的理由:
  用户要的全屏对象根本不是它。
  `[data-sidebar-right-toggle]`(收起)与 `[data-dockkit-add-tab]`(回到 guide)都保留。

  同一条里还藏了**详情浮窗头上的「送回侧栏」**(`[data-dockkit-float-dock]`, dockkit 那枚
  `_iconButton_17p4l_408`; 用户口径): 点它会把详情变回右栏页签, 与"详情只以浮层出现"相反。
  ⚠ **按"这是不是我们的浮窗"限定**, 不能写成裸的 `[data-dockkit-float-dock]{display:none}` ——
  官方浮动宿主是**所有页签共用**的, 别的页签被拖浮起来 / 从页签菜单浮起来时也长着同一个按钮, 一起藏了
  人家就送不回侧栏。判据取**标题里的文件名芯片**:

  ```css
  [data-dockkit-float]:has([data-dockkit-float-title] .fge-doc-name) [data-dockkit-float-dock] {
    display: none;
  }
  ```

  两种详情标题都带 `.fge-doc-name`(文档详情是 `DocName`, diff 是 `.fge-chip-label > DocName`), 所以都命中;
  探针实测(官方浮窗 DOM 逐字搭两个浮窗 —— 一个有我们的芯片、一个没有): 注入后前者那枚消失、**关闭**仍在、
  后者两枚**都不动**。
  ⚠ 这条让 `docs/adr/0002` 里"该按钮不可移除"那句**已知代价失效**(已在该 ADR 补修订说明);
  "拖页签/页签菜单仍能送回侧栏"那条路仍然成立, 所以 `adoptFloat` 的幂等那套照旧要有(见 §12)。

- **git 页签头部高度 = 38px**(`.fge-head`, border-box): 官方页签条占 0–38, 官方的「文件」页签头也是 38px ⇒
  头部底边线落在 **y=76**, 正好接上会话头部(`wSkVaW_header`, 0–76)的底边线与官方文件页签的下缘。
  原来用 `padding:6px 8px` 撑出 33.8px, 那条线落在 y≈71.8 —— **差 4px, 肉眼就是"这条线没跟上面那条对齐"**。
- **3) 放开浮窗里那个页签的宽度上限**(`[class*="_float_"] *:has(> [data-dockkit-tab-title]){max-width:none!important}`
  与 `[class*="_floatTitle_"]{max-width:none!important}`):
  "文件名经常显示不全"(用户口径)的**真因在页签上, 不在标题上** —— 官方给页签钉的是
  `min-width:80px; max-width:170px`, 而**浮窗头部那个标题就是同一个页签元素**(官方渲染是
  `Ce(me.tab, me.floatTitle)`, 两个类都挂), 于是半屏宽的浮窗里文件名可用宽度也只有 170px。
  ⚠ 标题自己(`[data-dockkit-tab-title]`)本来就没有 `max-width`(它是 `flex:1 1 auto; min-width:0;
overflow:hidden` + 裁切时加 `mask-image` 渐隐)—— **第一版改它是空操作**, 这条踩过。
  ⚠ **浮窗里那一格不带 `data-dockkit-tab`**(实测: 开着详情时 DOM 里只有「文件」「Git」两格带它):
  所以按 `[data-dockkit-tab][class*="_floatTitle_"]` 选**永远匹配不到浮窗**, 名字照旧截断 —— **第二版也是空操作**。
  现在两条**各自独立生效**的钩子钉住它: 前者盯着"谁夹着标题"(官方类名将来变了也还在), 后者是官方那格自己的类
  (`:has()` 官方自己也在用, 不是新依赖; `_floatTitle_` 取的是可读段不是 hash)。
  ⚠ 只放开**浮窗里**那一个: 页签条上那两格还靠官方这套 80/170 维持版式, 不动。
  真机量过(探针里**逐字抄来**官方那两条规则 + 按用户实测的 DOM 形状搭场景, 再注入本插件 CSS):
  浮窗那格标题 170px(被截)→ 281px(不再被截), **两条规则各自单独注入也都是 281px**;
  同一条规则下**页签条那格仍是 170px**(没被一起改)。
  另外本插件自己那条 `.fge-chip-label{max-width:22em}` 也一并撤了 —— 同一种病(diff 芯片在浮窗里也有地方却先截),
  截断交回官方那层。
  ⚠ **`.fge-doc-name` 不许挂 `padding:0 2px; margin:0 -2px`** 这种"视觉上不占地方"的写法: 官方判断要不要给
  标题加渐隐的判据是 `scrollWidth > clientWidth + 1`(容差只有 1px), 那对 padding/margin 会造出 2px 的
  scrollWidth, 让**已经完整显示**的文件名亮起右侧渐隐。踩过。
- **4) 详情浮窗头上的「全屏」开关** —— 本插件**自己加**的一枚按钮(`FloatFullButton` + 下面几条 CSS):
  用户口径是"全屏要落在**详情面板**上", 而不是右栏页签条那一格(那也是第 2 条把它藏回去的原因)。

  ```css
  .fge-float-full {
    display: none;
  } /* 默认藏: 标题槽在页签条上也渲染 */
  [data-dockkit-float] .fge-float-full {
    display: inline-flex;
  } /* 只在浮窗里露面 */
  [data-dockkit-float][data-fge-float-full] {
    inset: 0 !important;
    width: auto !important;
    height: auto !important;
    border-radius: 0 !important;
    z-index: 50 !important;
  }
  [data-dockkit-float][data-fge-float-full] [data-dockkit-float-resize] {
    display: none;
  }
  ```

  ⚠ **为什么只能"改画法"**: 官方没有移动 / 缩放浮窗的公开接口(`ctx.sidebarRight` 只有
  close/focus/float/dock/split), 而 `float()` 对已浮起的页签是 **no-op** ⇒ 官方那份 rect 换不了。
  所以全屏态就是一个标记(`data-fge-float-full`)打在**浮窗元素**上, 由 CSS 用 `!important` 压掉它
  **inline** 的 `left/top/width/height` —— 与第 1 条右栏宽度同一个手法(`author` 的 `!important`
  压得过 inline 的普通声明)。探针实测(官方浮窗 DOM 与 CSS 逐字搭):
  `800,40,640×400` + 圆角 20px → 打标记后 `0,0,视口` + 圆角 0 + 缩放手柄消失, **摘掉标记原样还原**。
  ⚠ 用 `inset:0` 而不是 `100vw/100vh`: 一次盖住四个方向, 也不必担心 `100vw` 把滚动条宽度算进去。
  ⚠ 按钮**只在浮窗里出现**: 标题槽在页签条与浮窗头部**两处都渲染**, 所以默认 `display:none`、
  再由 `[data-dockkit-float] .fge-float-full` 放开 —— 想用 JS 判据分不清这两处
  (`useTabInfo().tab.visible` 的定义里还包含"右栏展开且是本格", 条上与浮窗里都是 `true`)。
  ⚠ 按钮的 `onPointerDown` 必须 `stopPropagation`: 官方浮窗**整条 header 都是拖拽柄**, 它会对自己
  `setPointerCapture`, 那之后子元素的 `click` 永远不派发(与下面"文件名点击判定"同一个坑)。
  ⚠ 「退出全屏」没有单独的官方图标(primitives 只有 `IconFullscreenOutline16`), 两态共用它 ——
  靠按钮的 `data-s="on"`(底色 + 主文字色)与提示文字表示"正在全屏"。
  ⚠ 状态**不跨浮起保存**: 组件卸载(关详情 / 换文件)时把标记摘掉, 所以下次浮起一定从"非全屏"开始;
  **Esc 仍然是关掉整个面板**(不是先退出全屏), 沿用"Esc 关详情"这条既有约定。

- **文件名点击判定: 不用 `onClick`, 用「按下 → 抬起且位移 <4px」**:
  页签条与浮窗头部都在 `pointerdown` 时对**自己**调 `setPointerCapture`(页签是 `onTabPressed`, 浮窗是带
  `data-dockkit-float-grip` 的那条 header)。指针一旦被捕获, 其后的 mouse/click 全部重定向到捕获元素 ——
  官方自己的 `onClick`("选中页签")照常触发(捕获元素正是它), 而**更深的子元素永远收不到 `click`**:
  实测 `click` 计数 **0**, 连自身的 `pointerup` 也是 **0**。⇒ 该响应只能挂在**窗口级** `pointerup`
  (捕获阶段, 不受重定向影响)上自己结算, 并且照旧**不吃掉**这次事件(页签该选中还要选中)。
  ⚠ 阈值与官方拖拽起手判据(`|dx|>=4 || |dy|>=4`)**逐字对齐** —— "官方开始拖页签"与"我们不再复制"
  是同一条线, 拖一次不会顺手复制一个文件名(实测拖 40px 不复制)。
  ⚠ 同层那枚「复制内容」芯片**不需要**这么绕: 它在 `pointerdown` 里 `stopPropagation`, 官方那层压根没机会
  捕获, 所以它的 `onClick` 一直是好的 —— 这也正是当时**只有文件名那一下**不生效的原因。

### 12. 浮起详情的两个时序陷阱: 页签条"闪一下"与右栏跳页签

两条都只在真浏览器里看得见, 成因都在**官方座位绑定与 dockkit store** 的时序上。

- **第一次 `float()` 必抛「sidebarRight: no session surface is mounted」**。官方座位的绑定写在
  `useEffect(() => bindService({...}), [..., surfaces])` 里, 而新页签让 `surfaces` 变了: 那一轮 flush
  **先跑整棵树的卸载阶段**(座位释放绑定)、**再跑装载阶段**(子先父后)—— 本插件的芯片 effect 正好夹在
  "已释放、尚未重绑"的空隙里。关键是**空隙在同一轮 flush 的收尾就补好**, 所以重试要用**微任务**
  (`Promise.resolve().then`): 微任务在 flush 之后、paint 之前跑, 详情页签于是**一帧都不会**出现在页签条上。
  用 `setTimeout(60ms)` 会把这 60ms 的中间态画到屏幕上 —— 真 boot 实测: 页签条上冒出详情页签
  **45–66ms / 3–5 帧**, 使用者看到的就是"先加一个 tag, 闪一下, 消失"。
  `retryFloat` = 前 2 次走微任务、之后退回定时器; 「量不出 rect」(右栏还在展开、没有轨道)那一路仍用定时器
  (那是真的得等下一帧)。`close()` 与 `float()` 共用这条重试, 顺序仍是"先关后浮"。
- **浮起之后右栏会跳到"详情左边那一格"**。dockkit 的 float reducer 会把来源 pane 的 activeTabId 改成
  `tabs[max(0, index - 1)]`(内部 `W3`; index = 被浮起页签的下标), 而详情页签总是**追加在末尾** ——
  从「文件」页签点文件时, 左边那格正是先前打开的 git 树, 观感就是"右栏自己切回 git 树了"。
  修法不是猜"左边那格应该是谁": 本插件用一条**捕获阶段**的 `click` 监听记住"用户这次动作之前页签条上选中的那一格"
  (读 DOM 的 `aria-selected`, 每次动作前重读, 点在页签条本身上时跳过), 浮起成功后 `sidebarRight.focus()` 回去 ——
  右栏就停在用户原本看的地方。focus 与 float 落在同一拍(同一个微任务)里, 所以连"先跳过去再跳回来"的闪动都没有。
  实现事实 §10 里那次"自己把活动页签换掉"是同一枚硬币的另一面: **本插件有能力改动右栏当前页签, 就欠用户一个还原**。

> 这两条由仓库根 `scripts/verify-client-bundles.mjs` 的「座位空隙的重试走微任务 + 浮起后把用户那一格 focus 回来」
> 一项离线守住(桩里 `float()` 第一次必抛、`setTimeout` 只记账不执行): 退回定时器、或者删掉那次 focus, 这项就红。

### 13. 终端抽屉: 配色 / 自动聚焦 / 滚动条

这一节原来只讲配色, 现在把终端抽屉里**属于"为什么这么做"的东西**都收在这里(「使用」层只留行为一条)。
先讲配色 —— 它踩的坑最深:

真 boot 实测(浅色主题): `.fge-term-body` / `.fge-term-strip` 都是 `rgb(255,255,255)`, 唯独
`.xterm-viewport` 是 `rgb(0,0,0)`, 终端里的文字也是 xterm 默认的浅灰 —— 也就是**整个 theme 都没生效**。

原因是两份"默认值"叠在一起:

1. **`theme.background` 传了 `rgba(0,0,0,0)` 会被 xterm 丢掉**。原实现的意图是"透明, 露出容器底色"
   (`body{background:var(--dsw-alias-bg-base)}`), 但 xterm 解析不了这个值就**静默回落**到它自家的默认黑,
   连 `foreground` 也跟着是默认白。所以主题色必须**算成不透明色**再交出去。
2. **`xterm.css` 里 `.xterm-viewport{background-color:#000}`**。xterm 的主题色只刷在
   `.xterm-scrollable-element`(DOM 渲染器)上, viewport 那一层没人管 —— 终端底边会漏出一条黑带。

修法:

- `terminalTheme(snapshot)` 从**主题 token** 取色(`--dsw-alias-bg-base` / `--dsw-alias-label-primary`),
  归一到 xterm 认得的写法再交出去(见下);
- CSS 补一条 `.fge-term-body .xterm-viewport{background-color:var(--dsw-alias-bg-base)!important}`(跟着 token 走, 零 JS);
- 订官方 `theme/change`(`ThemeSnapshot{tokens, active.colorScheme}`): 主题一换就把新 theme 塞给
  **所有活着的 xterm 实例**(模块级 `liveTerms`), 不重开抽屉也是新配色。

**16 色 ANSI 调色板必须自己给(用户报的"字体高亮导致看不清")。** 只设 `background` / `foreground` 时,
其余 16 色会回落成 xterm **内置的默认调色板** —— 那套是**为深色背景设计的**: 亮白 `#ffffff` / 亮黄 `#ffff00`
落到浅色终端面上(官方浅色 `#f9fafb`、本机主题 `#E4EAE0`)几乎看不见;更糟的是
`drawBoldTextInBrightColors` **默认开着** —— **加粗**的字会切到那排"亮色"上, 于是 git / PowerShell 那些
加粗的高亮词直接糊掉。所以 `terminalPalette(dark)` 明暗各给一套 16 色, 并且:

- **浅色主题下"亮色"那一排是反的: 更暗、更深**(对比度才是"更亮");深色主题下才是更亮。
  这样 `drawBoldTextInBrightColors` 开着也不会掉进看不清的坑, 不必去改那个选项。
- 两套都按 **WCAG 对比度**逐个颜色验过(见下方守门那段):浅色两面最紧的也有 **5.2:1**,深色最紧的
  `black`(= 约定的"暗淡槽")**3.56:1**,其余都 ≥ 4.5:1。⚠ 改这几个颜色**必须**重跑离线断言。
- 这 16 个是**写死的常量**: 主题里没有 ANSI 调色板这组 token(只有面色 / 状态色), 官方也没定义 ——
  与 diff 行数用的 `#3fa34d` / `#d9534f` 同一种性质。面与前景**仍然**全走主题 token。
- 选区底色也改成**主题品牌色**调的淡底(`color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent)`),
  不再写死那个蓝。

**`normalizeColor` 必须交出 xterm **认**的写法。** 原来直接把 canvas 的 `fillStyle` 交出去, 实测发现两个坑:

1. canvas 对 `color-mix()` 回的是 **`color(srgb 0.53 0.73 0.51 / 0.32)`**、对 `oklch()` 原样回 `oklch(…)`,
   而**这两种写法 xterm 的解析器都不认** —— 它会把整条设置**静默忽略**、回落到内置默认值(底色 = 黑),
   也就是"整份 theme 没生效"那个老毛病的另一种触发方式;
2. 无效写法时 canvas **静默保留上一个值**: 原来拿 `#000000` 当哨兵, 于是"不认"会被误判成纯黑。

现在改成:用 `rgba(1,2,3,.5)` 当哨兵认"不认",再把颜色画进 **1×1 画布读回像素**(`getImageData` 给非预乘
RGBA), 交出 `#rrggbb`(alpha=1)或 `rgba(r,g,b,a)`。真机验过:`color-mix` → `rgba(134,187,128,0.32)`
(通道差 ≤1/255, 那点误差来自像素往返, 肉眼无感)、`oklch(0.7 0.1 150)` → `#6fb07d`、非法写法 → `null`(走回落)。

**三层表面: 为什么不能拿 `bg-base` 当终端底。** 把终端表面统一到 `--dsw-alias-bg-base` 之后, 用户实测反馈
"整个抽屉糊进背景、下面的横线都看不到了" —— 查 token 才明白: 官方浅色主题里
`bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-layer-3` **全是纯白**(实测 `#fff`), 拿它们当终端底就等于
把抽屉画成页面本身的颜色, 标题条的分隔线也跟着糊了。所以改成:

| 层                       | 取值                                                | 实测(浅 / 深)         |
| ------------------------ | --------------------------------------------------- | --------------------- |
| 终端体 / 画布 / viewport | `--dsw-alias-markdown-code-block`(官方终端卡片同款) | `#f9fafb` / `#1b1b1c` |
| 标题条                   | **不设底色**(透出上面那层)                          | 同上                  |
| 页签                     | 与终端体同色(不压 border, 线在它下面继续)           | 同体                  |

于是**条 / 页签 / 体两层**在任何主题下都读得出来, 条下面那条 `border-l3` 分隔线**在页签下面也连续**
(像素级实测: 页签底边那行 `249,250,251 → 206,207,208 → 249,250,251`); 页面底色一变, 这层跟着变, 没有一个写死的颜色。
(标题条不再自己叠一层墨色 —— 用户口径: 把那块色去掉, 分界交给那条线。)

**抽屉宽度跟 composer 卡片对齐, 零 JS(但要用对变量)。** 座位是整条中栏, 所以宽度得自己算。
⚠ 这里踩过一次: 原来写的是 `max-width: var(--dsh-chat-content-width, 100%)` —— 那是**正文列宽**, 而 composer 卡片
(`.uV2eYG_card`)是 `min(容器宽 - 2*side-clearance, --dsh-composer-card-max-width)`, 官方定义:
`--dsh-composer-card-max-width = calc(--dsh-chat-content-width + 32px)`、`--dsh-composer-side-clearance = 16px`。
于是抽屉恰好比卡片**窄 32px**(左右各 16), 用户一眼看出来"宽度跟卡片不一致"。现在照卡片的公式写:

```css
width: calc(
  100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px)
);
max-width: var(--dsh-composer-card-max-width, var(--dsh-chat-content-width, 100%));
margin-inline: auto;
```

抽屉与抽屉舌共用这一份(舌是收起态, 只有一枚居中 chevron、不带底色, 32px 的差别看不出来, 但两处必须同一来源)。
真机量过: 宽列(1200)两边都是 **952px**、窄列(700)两边都是 **668px**, 左缘也重合 —— 拖顶部那条宽度手柄时两者一起变宽变窄,
xterm 由既有的 ResizeObserver 自动 refit。(官方 dock 座位如目标条 `.nLMEza_bar` 是再往里缩 2×`--dsh-composer-dock-inset`(8px)的;
本抽屉按用户口径**与卡片持平**, 不缩。)

**打开抽屉就把焦点交给终端。** 用户口径是"省掉再用鼠标点一下这一步"。做法与两条硬约束:

- 在 `term.open(...)` **之后**调一次 `term.focus()` —— xterm 的 focus 是打到它自己那个隐藏 textarea 上的,
  元素还没挂上去就等于没调(静默失败, 不报错)。
- **只在挂载那一次做**(终端 effect 的依赖是 `[root, visible]`, 不是每次渲染): 否则用户刚点去 composer 打字,
  一次无关重渲染就把焦点抢回来。
- 真机验过: `focus()` 后 `document.activeElement` 落在 `.xterm` 里的 textarea 上、敲键真进 `onData`; 不聚焦时敲键进不去。
- ⚠ **代价**: 焦点一进来 `Esc` 就归终端(与"焦点在终端里"那条分流一致), 于是**开抽屉后 Esc 不再收起抽屉**。
  想收起就点条空白处 / 页签上的 `×`, 或先把焦点点出去。这条也是 `Alt+Ctrl+R` 带 `Ctrl` 的原因(见 §15)。

**选中即复制(与那枚开关)。** 拖选 / 双击选词 / 三击选行一松手就写剪贴板(走官方 `primitives.writeClipboard`),
**Alt+C** 是兜底: 内容与"自动那次"相同时也**强制重写一遍**(自动那次可能被浏览器或权限挡了, 这时内容当然一模一样,
不能跳过)。两条路共用同一条 `copySelection(force, expandTail)`, 免得日后走岔。条右端那枚**开关**
(`role="switch"` + `aria-checked`, 自己画的轨道 + 滑块)关掉的是**自动**那条 —— Alt+C 照旧、**选区收敛照旧**
(那是选区本身的口径)。几条硬约束:

- ⚠ 读选区 + 发起写入必须在 **mouseup 里同步**做完 —— 剪贴板 API 要"用户手势", 挪进 `setTimeout` 手势就过期了。
- ⚠ 监听挂在**终端体**上(不是 `document`): 鼠标在终端外松开时不去动剪贴板; 普通单击清空选区,
  只需"重新选同一段还能再复制" —— 所以选区空了就把 `lastCopied` 归零。
- ⚠ **不用 Ctrl+C**(那是 SIGINT, 必须原样送给 PTY), 也**不占 Ctrl+Shift+C**(那是浏览器 / DevTools 的"检查元素", 抢了很碍事)。
- ⚠ 开关长在"整条可点即收起"的标题条里, 所以它的 `onClick` 第一件事就是 `stopPropagation`。
- ⚠ 开关的尺寸**全套取偶数**(盒子 18 与终止键一致 / 轨道 24×12 / 滑块 8 / 文字行盒 12): 条里内容行高是
  **奇数**(页签 21px), 控件自己若是 17 / 轨道 13 / 行盒 11.5, 居中就会落在 `.5px` 上 —— 相邻元素的
  **文字与几何各自吸到不同的半像素**, 看着就是"文字和开关垂直没对齐"。全取偶数之后真机量到:
  文字行盒与轨道**同顶同高**(都是 top 13.5 / 12px, 修前是 13.75 对 13.00 —— 差半像素)、
  墨迹中心 = 轨道中心 = 滑块中心 = 19.5px; 标题条高度没变(仍 32px)。

**选区不许漫到"内容下方那片空白"**(用户报的 bug: 拖到底选中一大堆空行, 复制出一串换行)。
终端格子是 `rows × cols` 的, **光标下面本来就还有一整片空格**, xterm 允许把选区拖到那儿去 ——
它自己的 `getCoords` 只把越界的指针**夹进视口**, 于是那一整片空白照选不误。三件事一起做才收干净:

- **拖拽途中**: 在 `document` 的**捕获阶段**吃掉这次 `mousemove`(xterm 的拖拽监听挂在 document 的
  **冒泡**阶段, 捕获一定先跑)。它收不到移动, 选区就停在最后一行有内容处 —— 拖蓝不会漫过去。
  三个与门缺一不可: **从终端里开始**的拖拽(`mousedown` 捕获时记下) + 还按着左键 + 指针落在
  "最后一行有内容之下"(行号用 `mouseRowAt` 算, 与 xterm 的 `getCoords` **同款算法**, 所以边界处处对得上)。
  ⚠ **开了鼠标上报**(全屏 TUI: vim / htop …)时一概不碰 —— 那时鼠标归应用; 抽屉上缘那条拖柄与别的拖拽
  也完全不受影响(它们的 `mousedown` 不在终端体里)。
- **松手时**: 把尾巴收到最后一行有内容处(纯函数 `clampSelectionTail`)。**两端都在空白里** ⇒ 清掉选区
  (那儿一个字都没有); 尾巴越过边界 ⇒ 收到**该行文字末尾**。⚠ 边界挡过的那次还要**补到行尾**:
  鼠标那一列在越界那一刻就冻住了, 不补的话"拖到底"会把最后一行**截断**(真机实测: `gamma-here` 只选到 `gamma-h`)。
  ⚠ 没被挡过时绝不能补 —— 那可能是双击选词、或用户就是要选到某一列。
- **中间的空行照留**: 两条命令之间的空行是内容的一部分(纯函数 `findLastContentRow` 只找**最深**那行有内容的行),
  真机验过: `alpha / beta / (空) / gamma-here` 拖到底复制出来就是这 4 行、**没有尾巴空行**。
  ⚠ 收敛只能在 **mouseup / Alt+C** 这种"选区定下来了"的时刻做: xterm 的 `setSelection` 会先
  `_removeMouseDownListeners()`, 拖拽途中调用会把这次拖拽直接弄断(它就再也收不到 mousemove 了)。

**xterm 自带的滚动条要单独收拾。** 它是 vscode 血统的 `ScrollableElement`: 宽度取
`verticalScrollbarSize = overviewRuler.width || 14`(即**默认 14px**), 而且 `domNode.setWidth(...)` 把它写成
**内联样式** —— CSS 必须 `!important` 才压得住。这里收到 6px、滑块同宽并加 `border-radius:3px`(对齐 dsh 自己的细滚条);
滑块颜色不用管, xterm 自己按 `scrollbarSliderBackground`(默认 = 前景色 20% 透明)注入一段 `<style>`, 于是天然跟主题。

> 由 `scripts/verify-client-bundles.mjs` 的离线守住: **「16 色 ANSI 调色板与终端面的对比度达标」**
> (纯计算: 官方浅色 / 本机主题浅色 / 官方深色三种面, 逐个颜色算 WCAG 对比度 —— 这是"看不清"唯一可离线度量的判据) +
> 「终端底色不写透明」+「订了 `theme/change`」+
> 「表面用官方 code-block 底色(不是 `bg-base`)、条无底色、抽屉/舌宽度照 composer 卡片的公式(不是 chat-content-width)、
> **两条拖柄(终端上缘 + git 分栏)都无 hover 底色**、滚动条 6px 圆角、终端选中即复制(mouseup 上同步读选区,
> 与 Alt+C 共用 `copySelection`, 监听挂终端体且照登记表摘)+ **条右侧那枚开关**(role=switch / aria-checked / 点击 stopPropagation /
> **尺寸全套取偶数** —— 盒子 18、轨道 24×12、滑块 8、文字行盒 12, 免得居中落半像素)+
> **终止键是官方 SVG**(`primitives.IconStopFill16` 尺寸 12, 且源码里不许再出现 `'■'` 字面量)+
> **选区尾巴收敛**(纯函数 `__findLastContentRow` / `__clampSelectionTail` / `__mouseRowAt` 逐个跑, 外加拖拽途中
> 只许吃事件、**不许**落选区那条回归锁)」; host 侧的 `-NoLogo` 与「重启丢旧回放」由 `tests/pty.test.mjs` 守。
> 真浏览器验收见验收清单第 10、11 条。

### 14. 上下两栏、聚焦提交、按目录归类与层级线

**分栏**:`.fge-body` 本身就是那条竖排 flex 容器(`display:flex;flex-direction:column`), 上栏
`flex-basis:<split>%` + `flex-grow/shrink:0`(行内样式给, 拖动改的就是它), 下栏 `flex:1 1 auto`。
两条 `.fge-pane` **各带自己的 `overflow:auto`** —— 所以 `.fge-section` 那条 `position:sticky` 的节头
天然变成"每栏各吸各的", 上栏滚到底也不会把历史顶走。默认 3/4 由 `GIT_SPLIT_DEFAULT = 75` 一处给。
拖柄就是那条**分界线本身**:`.fge-grip` 只有 **1px 高**(上边一条 `border-l3` 就是两栏的分界线),
可拖的 5px 热区由 `::after` **压上去**(`top:-4px;height:5px`, 只向上越线) —— 布局高度必须是 1px,
否则那条实体盒子会在两栏之间又占出 4px 空隙(原来就是 5px 实体 + 上栏 `padding-bottom:6px` = 两栏之间
一块**约 11px 的空白带**, 看着就是个缺口, 见 §10 那条 bug)。热区还要 `z-index:2`, 因为两个 sticky
标题栏都是 `z-index:1`, 不压过它们的话线那一带会被下栏标题栏抢走、拖柄有一半按不动(真 chromium 实测
`elementFromPoint` 命中 `fge-section`)。move/up 挂 `document`
(与终端抽屉的上缘拖柄同款); 比例按 `getBoundingClientRect().height` 换算, 存 `localStorage`
(`fge-git-split-v1`)。⚠ 拖完**不能在 `setSplit` 的更新函数里写盘**(React 可能把更新函数跑两次),
所以把最后一次的值记在闭包里, `mouseup` 才落盘。

⚠ 这条拖柄**没有 hover 底色**(与终端抽屉上缘那条**同一口径**, 见 §13): 它同样是一整条通宽的横带,
一亮就是一整条; 而这条夹在两块长得很像的列表之间, 变色会被读成"这一条跟别处不是一个颜色", 不像提示。
底色常驻 `transparent`, 可拖的提示交给 `cursor:ns-resize`。
(不采用"悬停时出现一条 3px 圆角短竖条"的官方做法 —— 当前是最干净的版本; 若以后真觉得难找, 再借那一手。)
离线护栏与上缘那条一样是**反向断言**: `.fge-grip:hover` 一旦再冒出来, 「git 页签上下两栏」那一项就红。

- 拖拽区间是 `GIT_SPLIT_MIN..GIT_SPLIT_MAX`。上限 90 是"下栏至少留一条"; **下限由 `GIT_SPLIT_BOTTOM_MAX = 60`
  反推**(`GIT_SPLIT_MIN = 100 - 60 = 40`, 用户口径「往上拉别超过页面高度的 60%」)。正文 = 整页高度减
  38px 页签头, 所以"下栏 ≤ 60% 正文"**一定** ≤ 60% 页面 —— 这条约束就落在这一个常量上, 不需要去量视口、
  也不受窗口尺寸影响。旧版本存下的 15 之类会被 `readGitSplit` 夹回下限。
- ⚠ **两栏都不显示滚动条**(`.fge-pane{scrollbar-width:none}` + `.fge-pane::-webkit-scrollbar{display:none}`,
  用户口径)。连锁效果:
  1. **仍然可滚**(滚轮 / 键盘照常), 只是没有那条可见轨道;
  2. **"形变"从根上没了** —— 滚动条从不占位, 内容宽度恒定。之前为此加过 `scrollbar-gutter:stable`,
     现在**去掉了**: 那条留白本来就是给滚动条占位的, 没有滚动条它就是死代码;
  3. 两栏内容宽度一起变宽(真机 8px), 彼此仍然对齐 —— ⚠ **只能两条一起隐藏**: 只藏一条会让两栏差 8px,
     两个列表的右缘 / 截断点会当场错开(实测过: 隐藏滚动条会把 `scrollbar-gutter` 那 8px 一起带走);
  4. 展开的**提交说明自己那条滚动条保留**(见下), 那是"该滚的那一条"。
     真机量过: 上栏 / 下栏(列表态)/ 下栏(聚焦态)滚动条占位都是 **0px** 且都能滚, 两栏内容宽度相等(288px),
     说明那一栏仍是 8px。
- **分支按钮撑满到刷新键之前**:`.fge-branch{flex:1 1 auto;min-width:0}`, 不再卡 `max-width:11em`;
  头部因此**不放** `.fge-spacer`(两者并存会把空白平分, 按钮就长不到刷新键前面), 只留终端标题条那一条还在用。
  名字那格 `min-width:0` 才能在按钮里省略号。
- **刷新键是官方 SVG 图标**:`primitives.IconRefreshOutline14`(20+ 个官方图标与分支 / 箭头图标同在一张表里,
  `primitives` 整个模块就是 `require` 进来的, 见上面「只 require 了种子模块」那条)。`.fge-refresh` 只声明
  **自己这一格**的居中与 busy 动画(`inline-flex` + `@keyframes fge-spin`), 不动 `.fge-btn` 的通用盒子 ——
  返回键 / 终止键还各有自己的排版。⚠ **不要再退回文字字形**(`⟳` / `■` 这类): 画风随平台字体漂移,
  官方 SVG 图标才是稳的(`IconRefreshOutline14` / `IconStopFill16`)。

**标题栏(`.fge-section`)**:不透明的实色横条 + 下边 `.5px` 细线, 配方照官方那个真 sticky 分组头
(model-selection 的 `groupTitle`:`sticky/top:0/z-index:1`、12px/500、`label-tertiary`、`padding:5px 8px 3px`)。

- ⚠ 原来写的是 `opacity:.72` + `background:var(--dsw-alias-bg-base,…)`:浅色主题下 `bg-base` 恰好就是
  右栏面板自己的纯白(`.P3OORG_panel{background:var(--dsw-alias-bg-base)}`), 再叠 0.72 的不透明度,
  滚上来的行就从字缝里透过去了 —— 这就是"文字内容出现在 fge-section 下层"的成因。
- 底色是**两层**:底座用面板自己的实色 `--dsw-alias-bg-base`(按构造一定不透明),主题强调色
  `--dsw-alias-markdown-tag` 只作为 **`background-image` 叠加层**铺上去;细线改 `--dsw-alias-border-l3`
  (明暗自动翻转),替掉写死的 `rgba(128,128,128,.16)`。条高 27px(12px 行高 + 上下 padding),比原来高约 5px。
- ⚠ **强调色不能直接当 `background`**:`--dsw-alias-markdown-tag` 是"标签 / 芯片的填充色",语义上就是一层
  淡强调色。官方两套主题恰好把它定成实色(`#f1f3f5` / `#2c2c2e`,官方右栏活动页签芯片用的也是它),
  但**由强调色派生的主题会把它做成半透明** —— 本机 Sage Mist 就是 `rgba(135,186,129,0.14)`。于是横条是透的,
  滚上来的行照穿(实测复现:同一个 `.fge-section`,底座换成 `rgba(135,186,129,.14)` 后算出来的底色 alpha 就是 0.14)。
  叠在实色面之上,挡不挡得住就只取决于底座、与强调色的 alpha 无关;万一 token 无效,这一层 gradient 整个失效,
  剩下的 `bg-base` 仍然实色。
- ⚠ **`ensureStyles()` 必须换掉旧 `<style>`**,不能"已存在就 return":插件热重载(不刷新页面)时旧的那个
  `<style id="fge-styles">` 还在,return 会把旧 CSS 一直留在页面上 —— 改样式的人会以为"改了没生效"。
  改样式后要么刷新页面(Ctrl+F5:普通刷新可能命中缓存),要么靠这条换掉。
- ⚠ 横条**上边不画线**:上栏那条来自 `.fge-head` 的 38px 底边线、下栏那条来自 `.fge-grip` 的分界线;
  自己再画一条会叠成双线(两条 `.5px` 挨在一起就是 1px 的粗线)。

**聚焦提交(`focusCommit` / `exitFocus`)**:下栏整栏在**列表态**与**聚焦态**之间二选一 ——
`focused === null ? historySection : focusSection`, 两个形态**共用同一个滚动容器**(下栏那个 `.fge-pane`)。

- 进聚焦:记下列表的 `scrollTop` 与当前比例 → `setSplit(GIT_SPLIT_MIN)`(下栏放到 60%)→ 请求 `show`;
  返回:还回比例(`splitBefore` 非空时)与滚动位置。⚠ **聚焦期间自己拖过拖柄**(`onUp`/`resetSplit` 里
  `setSplitBefore(null)`)就**不再还原** —— 那是你在表达新偏好。
- 滚动位置用 `scrollBefore` / `restoreScroll` 两个 **ref** 记:进聚焦时存下 `scrollTop`,返回时置一次
  `restoreScroll` 闸门,由一条 `useLayoutEffect` 还原。
  ⚠ **只在"刚返回"那一次还原**:组件重挂(点文件开 diff 再回来)并没有可信的列表位置,那时什么都不该动
  (按一个陈旧的值把列表跳走 = 新引入的毛病)。所以它**不进** §10 那两份缓存 —— 它是"这一次挂载内"的事。
  ⚠ 依赖是 `focused === null` 这个**布尔**, 不是 `focused` 本身 —— 详情到达时 `focused` 会换个对象,
  拿它当依赖会在那一刻又动一次滚动。
- 聚焦头部那三件(作者 / 时间 / 短 hash)是**跟着列表行一起进聚焦态**的(`focusCommit(commit)` 把整行带进去)。
  ⚠ 不要"回头去列表里找":`show` 不回这几个字段,而列表会被手动 ⟳ 重建 —— 那条提交不在前 50 条时,
  回查会查到空,头部就白了。
- **Esc 分层**:apply 里那条**唯一**的 keydown 负责, 顺序是「焦点在终端里 → 让给终端」→「悬浮面板开着 → 只关它」
  →「分支小浮窗开着 → 只关它」(最内层)→「`focusEsc.current` → 返回列表」。`focusEsc` 是模块级 ref,
  GitTabBody 每次渲染写一次(卸载清掉) —— 这样不用给 Esc 加第二条监听,
  也就不会出现"一次按键既关悬浮面板又返回列表"。
- 自动刷新在聚焦期间**挂起且不补刷**(那一拍 true→false 被吃掉):看的是一条不会变的历史, 不该在返回时
  把背后的列表换掉。手动 ⟳ 不改变聚焦态。

**按目录归类 + 层级线**:`buildPathTree(items, pathOf)` 折树 → `compactPathTree` 压单链目录 →
`makeTreeRows(h)` 造出的行数组工厂上屏(变更列表与聚焦里的文件清单共用同一条链)。

- 工厂对外只给两个入口:`root(tree, keyPrefix, makeFileRow)`(**顶层**, 三个参数)、
  `fileRow(pos, props)`(文件行的壳: 缩进 + 层级线 + 完整路径 `title` + basename;两份列表共用,
  于是线不可能被哪一份列表漏掉)。`pos = { depth, isLast, continues }`。
  ⚠ 顶层**特意**收成三个参数, 是因为这里翻过一次车: 早先的 `treeRows(node, depth, keyPrefix, makeFileRow, cont)`
  是五个位置参数, 顶层调用把 `[]` 传进了 `makeFileRow` 那一格;而"按目录归类"只在**有目录**时才走到那条分支,
  于是 grep 式的离线护栏完全没拦住 —— 真渲染时直接 `TypeError`。现在顶层调用一律 `treeRows.root(...)`,
  护栏里也**真的把树跑成行数组**断言一遍(见下方守门那段)。
- 顺序: **目录在前、文件在后**, 各自按首次出现的次序(= host 排好的路径序, 未跟踪仍然沉底)。不用再排一次。
- **单链目录压缩**: 自己没文件、又只套着一个目录的链并成一行(`plugins/file-git-explorer/lib`)。
  ⚠ 压缩只改**显示名**, 节点的 `path` 仍是完整路径 —— React key 与 `title` 都取它, 否则深层目录的 key 会撞。
- 文件行只显示 **basename**(`.fge-name`, `min-width:0` 才能在 flex 行里截断), 完整路径在 `title` 里,
  请求 diff 用的也始终是 `files[].path`。
- **层级线**由 `guideSegments(pos, hasChildren)` **纯函数**算出一行要画哪几段(`{x, part}`,
  part = full / top / bottom), 工厂再把它们画成绝对定位的 `span`(`data-part`);
  列 k 的 x = `15 + 12k`(= 第 k 层目录的**文件夹图标中心**, 与 `indentPx` 同一套步长)。
  ⚠ 那个字段叫 `part` **不叫 `h`** —— 这个文件里 `h` 是 `React.createElement` 的别名, 别撞。
  - 父那一列一定有线, 本行是父的**最后一个子项**时收到**行中**(`part:'top'`);
  - 祖先那一列只在"那个祖先**还有后续兄弟**"时才贯穿本行(`pos.continues` 就是这么一路传下去的);
  - 有子项的目录自己那一列从**行中**起头(`part:'bottom'`), 于是线从文件夹图标底下连着第一子项。
  - ⚠ 用 **1px** 虚线:官方没有先例(官方文件树完全不画缩进线, 最近的 subagent 树是 `.5px` **实线**),
    而 `.5px` 的虚线在屏幕上会碎成看不见。真 Chrome 实测:线 x 落在父目录图标中心、末项收到行中、
    0 列从父目录行中连续贯到最后一个后代。
- ⚠ 聚焦里那批文件行**不能用循环变量做闭包**:工厂函数外面先 `(function (hash) {…})(focused.hash)`,
  再让 `onClick` 闭这个局部, 否则重挂后点文件会拿错提交。

**提交说明折两行**:说明块是 `CommitMessage`(`.fge-msg` > `.fge-msg-bar` + `.fge-msg-text`),
折叠态给文字挂 `data-clamp="1"`(`display:-webkit-box` + `-webkit-line-clamp:2` + `overflow:hidden`),
展开态摘掉它。**是否放得下**由 `useLayoutEffect` 里量 `scrollHeight > clientHeight + 1` 决定,
只决定「要不要给按钮」—— 折叠态**始终**挂着 clamp, 所以首帧就是两行, 不会先闪一下全文。

- ⚠ **开关(`.fge-msg-bar`)独占一行、左对齐、画在文字上方**: 用户口径是"展开后别让「收起」跑到最底下、
  还得拉滚动条"。放在文字下面时, 展开会把按钮顶到全文末尾 —— 位置随内容变; **左对齐**则让它连 x 都与容器
  宽度无关(右对齐会随滚动条出现 / 右栏拖宽漂移, 用户口径的"固定位置")。量的是 `.fge-msg-text` 自己,
  上面那行按钮不参与它的 `clientHeight`, 所以量出来的结论不会因为按钮出现而变。
- ⚠ **展开态限高、自己滚**: `.fge-msg-text:not([data-clamp="1"]){max-height:calc(1.5em * 14);overflow:auto;
scrollbar-gutter:stable}` —— 用户口径是"展开后滚动条该出现在这一段里, 而不是 `fge-pane`"。
  于是说明最多占约 14 行, 不再把整栏撑长, 下面的文件清单与开关都留在原地; 这一段自己出滚动条时,
  里面的文字宽度也不变(同样靠 `scrollbar-gutter`)。
- ⚠ 只在**折叠态**量: 展开态两者相等, 量了会让「收起」自己消失(所以 `measure()` 头一句就 `return`)。
- ⚠ 用 `useLayoutEffect` 而非 `useEffect`: 按钮在同一帧就位, 下面的文件清单不会先跳一下。
- ⚠ 还挂一个 **`ResizeObserver`** 盯 `.fge-msg-text`: 右栏宽度可拖, **变宽**可能就放得下了(不重量的话
  「展开」会一直挂着), **变窄**时更糟 —— 溢出但没有按钮 = 内容被永久藏住。真 Chrome 实测:
  同一条单行长说明 240px 下 `scrollHeight 126 / clientHeight 36`(溢出), 拉到 1200px 就变成
  `36 / 36`(不溢出)—— 这条结论必须跟着宽度走。
- 展开态(`msgOpen`, 键 = commit hash)与 `focused` 同款**按会话缓存**在 `gitViews` 里(见 §10),
  点文件开 diff 再回来仍在;换工作区时一起清空。
- 点**说明文字本身**不切换 —— 那段文字可以拖选复制, 只有「展开 / 收起」按钮是开关。

**hash 胶囊(`HashChip`)**:提交历史每行第二行末尾那枚短 hash, 是个 `<button class="fge-chip fge-hash">`。

- 显示**短** hash、复制**完整** hash(`writeClipboard(props.hash)`, 与「复制内容」芯片、终端选中即复制同一条路),
  `data-s` = done / failed 沿用仓库既有的反馈, 1.2s 后回到短 hash。
- ⚠ `onClick` 里第一件事是 `stopPropagation`:它长在"点这条提交就聚焦"的那一行里, 不拦一下会连带导航。
  外面那层 `.fge-commit-meta` 因此改成 flex(左 `作者 · 时间` 可截断、右胶囊 `flex:0 0 auto`), 而
  `.fge-commit-meta-text` 单独承担 `.6` 的透明度 —— 否则「已复制」的绿色会被一起压灰。

> 由 `scripts/verify-client-bundles.mjs` 的离线守住: 「`.fge-body` 是竖排 flex + 两栏各滚各的 + 有 `ns-resize` 拖柄
> 且**它不许有 hover 底色**(反向断言, 与终端上缘那条同口径) +
> **两栏之间只剩那条 1px 分界线**(上栏不许再有底部内边距; 拖柄布局高度 1px + `z-index:2` + 热区交给 `::after`
> —— 这几条就是"空隙"那个 bug 的回归锁) +
> 刷新键是官方 `IconRefreshOutline14`(**带引号的 `'⟳'` 不许再出现** —— 反向断言) + busy 时图标自转的那条
> `animation` 与 `@keyframes` 都在 +
> 上栏默认 75 + 下限由 60% 反推」, 「标题栏不再有 `opacity`、**底座是实色 `bg-base` 且强调色只许作为叠加层**、
> 下边线 `.5px` `border-l3`、`ensureStyles` 要换掉旧 `<style>`」,
> 「层级线是 `1px dashed border-l2` + top/bottom 两段 + 行是 `position:relative`」, 「聚焦态有 `data-focus` 淡底 / 返回键 /
> `focusEsc` / 返回时还原滚动位置 / `focusCommit`, 且 `toggleCommit`、`withExpanded` 已退场」, 「hash 胶囊先 `stopPropagation`
> 再复制完整 hash」, 「说明折叠态 `-webkit-line-clamp:2` + 开关渲染在文字之前」, 「默认页签恰好铺「文件」+「Git」这一对」,
> 「右栏页签 `Alt+J` / `Alt+L` 切相邻一格且**到边不环绕**」(`__tabNeighbor` 的纯断言 + 接线断言),
> 「`Alt+Ctrl+R` 与 `⟳` 指向**同一个** `manualRefresh`(不带 `busy` 门、卸载清空那枚回调位、
> 页签体没挂载时"切过去 + 记一笔待刷"、**只吃 Alt+Ctrl**、`window` 捕获且认下就 `preventDefault + stopPropagation`)」,
> 「展开抽屉后**只**聚焦一次、而且必须在 `term.open()` 之后」,
> 「详情**浮窗里那个页签**放开 `max-width`(真因是页签被官方钉 80–170px, 标题自己没有上限 —— 第一版改错了地方;
> 第二版按 `[data-dockkit-tab][class*="_floatTitle_"]` 选也错了, 浮窗那格根本没有 `data-dockkit-tab`) +
> `.fge-chip-label` 撤掉自己的 `22em` + 文件名**按「按下 → 抬起且位移 <4px」判定点击**(官方那两处
> `setPointerCapture` 会把子元素的 `click` 吃干净, 实测计数 0)、复制的是文件名本身、
> **两条详情路径都覆盖**、**不吃掉点击**、反馈只染色)」,
> 「右栏 chrome 只藏「分栏」与「进全屏」两枚按钮(位置放错过一轮: 用户要的全屏在**详情浮窗**上, 不是页签条)」,
> 「详情浮窗那枚**自己加**的「全屏」开关: 只在浮窗里露面(基础规则 `display:none` + `[data-dockkit-float]` 里放开)、
> 标记打在浮窗元素上、`inset:0!important` 压官方 inline 几何、圆角归零、缩放手柄消失、
> 两条详情路径都有它、且必须吃掉 `pointerdown`」,
> 「详情浮窗的「送回侧栏」按"标题里有本插件的文件名芯片"**限定**藏掉(裸选择器会连别人浮窗的一起藏)」,
> 以及 `exports.__pathTree` 上的纯函数断言(目录归类 + **层级线的分段**:末项收到行中 / 祖先收尾后那一列不再出现)。
> ⚠ 还有一条是**真调用**:`exports.__treeRows` 注入了假的 `h`, 把树跑成行数组, 断言 顺序 / 深度 / `isLast` / `continues` /
> 目录行自带的引导线 —— 这是补"顶层参数传错位"那次事故的:光 grep `treeRows(` 存在是**拦不住**的(那条分支只在有目录时才走到)。
> `__pathTree` / `__treeRows` 是**只为离线校验**递出去的出口(浏览器 bundle 不能 require 本包自己的模块), 不是插件契约。
> 真浏览器验收见验收清单第 1、2、4、5 条。

### 15. 快捷键(Alt 系列)与焦点分流

「使用」里只留了一张表;这里放**为什么这么设** —— 四个 Alt 键各一条全局监听, 分流规则是统一的:

- **焦点在终端里 → 这一按归终端**(`Alt+R` 在 readline 里是 revert-line, `Alt+J`/`Alt+L` 在终端里也没有意义),
  与 Esc 的分流同款。**唯一例外是 `Alt+Ctrl+R`**: 终端侧没有这组绑定, 所以它**不设这道门**。
- **右栏收起时不切页签**(切了也看不见);`Alt+Ctrl+R` 反过来要接住 —— 页签体没挂载就**切到 Git 页签
  - 记一笔 `gitRefreshPending`**, 挂载时立刻刷一次, 否则这条键只在"正看着 git"时才灵。
- **输入框里不禁用**: 这几个键都不输入任何字符, 而在 composer 里打字时想切页签 / 刷新恰恰是最常见的时机。
- **切页签到边不环绕**(用户口径"不做无限切换"): 越界返回 `-1`, 什么都不做 —— 判据是纯函数 `tabNeighbor`,
  离线护栏直接跑它(见下方守门那段)。
- **`Alt+Ctrl+R` 挂 `window` 的捕获阶段**(不是 `document`): 官方快捷键也走捕获, `window` 比 `document` 更靠前,
  万一官方先把它当别的用了我们仍收得到; 认下就 `preventDefault` + `stopPropagation`, 不落到 xterm 变成发给 PTY 的字节。
- **它与页签上那枚 `⟳` 是同一条 `manualRefresh`**: 一个动作只有一个入口, 不另写一套刷新逻辑。
  ⚠ 第一版做的是光 `Alt+R`, 用户实测"按了没反应" —— 根因是撞上了同一批改动里的「终端自动聚焦」:
  焦点几乎总在终端里, 那一按被上面第一道门跳过了(真机验过: 焦点在终端里时 `Alt+R` 会被 xterm 当成 `ESC r` 发给 PTY)。
- 官方绑定已确认无冲突(官方那几个 `altKey: "any"` 全在 ArrowUp / ArrowDown / Enter 上);
  浏览器也不会先吃掉 `Alt+Ctrl+R`(真机验过: 页面 keydown 收得到 `altKey + ctrlKey + KeyR`)。

## 测试与静态检查

```bash
node tests/git.test.mjs      # git 纯函数层(porcelain v2 解析 / 白名单 / diff argv / 统一 diff→hunk)
node tests/address.test.mjs  # 文件地址与「复制内容」纯函数层(芯片逻辑的可执行规约)
node tests/pty.test.mjs      # 终端纯函数层(shell 绝对路径解析 / 尺寸钳制 / 帧编解码 / 回放缓冲 / LRU)
node tests/verify.mjs        # host 全链路冒烟: 真实 git + 真实 HTTP 栅栏 + vendor + 真 WS/PTY 端到端
eslint .                     # 仓库统一 lint(client bundle 按惯例忽略)
```

浏览器半边的**装配契约**(种子模块引用、槽位名 / key / priority)由仓库根的
`scripts/verify-client-bundles.mjs` 离线护栏 —— 其中一条就是「影子芯片必须是负数 priority」;
「git 页签上下两栏(上栏默认 3/4)」「按目录归类」「提交说明折叠两行」也有对应的 CSS / 纯函数断言(见实现事实 §14)。

### 浏览器验收清单(离线脚本盖不到, 需要真 boot)

在**隔离 `DSH_HOME` + 独立端口**起一个实例(先 `dsh plugin --profile <名> add link:<repo-abs-path>/plugins/file-git-explorer`,
再 `dsh --profile <名> --port <端口> --no-open`),在真浏览器里逐条走一遍:

0. **右栏外观与拖动**:默认宽度 = 15vw(1920 窗口下约 288px);**打开右栏是把中栏挤窄、不是浮在它上面** ——
   面板左缘恰好等于中栏右缘(不重叠),折叠后这一格宽度立刻还给中栏;**左栏宽度不受影响**(收起仍是 56px 细条);
   右栏顶部只剩「收起」与「+」,**「分栏」与「进全屏」都不在**(全屏不在这条 chrome 上, 见第 8 条);
   **左缘那根 8px 拖柄可拖**(悬停出现一条 3px 竖条):往左最宽到 15vw、往右最窄到 200px,松手后宽度
   **刷新页面 / 切会话仍在**(`localStorage`);
   **git 页签头部的底边线与会话头部(`wSkVaW_header`)的底边线是同一条水平线**(都在 y=76, 差 ≤1px)。

1. **开一个全新会话**并把右栏展开 → 页签条上**就是两格**: 官方「**文件**」工作区文件树(列表有行、路径是会话 cwd)
   与 **「Git」**,且**当前显示的是 Git**(官方文件树在左边一格,点一下就切过去);页签条上**没有 guide 占位页**;
   `+` 仍能回到 guide 列表。**用 `Alt+J` / `Alt+L` 在前两格之间来回切**:到边(最左按 J、最右按 L)
   什么都不发生、**不会绕回另一端**;焦点在终端里或右栏收起时这两个键不生效。
2. 正文是**上下两栏**: 上栏**变更列表**(默认占正文 3/4 高)、下栏**提交历史**,**两栏各自滚动**(滚一栏不动另一栏);
   中间那条拖柄可以拖、松手比例记住(刷新页面仍在)、**双击拖柄回到 3/4**;
   **鼠标悬停到那条拖柄上时它不得变色**(只变指针形状, 与终端上缘那条同一口径 —— 第 10 条);
   **往上拉到头时下栏不会超过页面高度的 60%**(变更列表始终留着);
   两份列表都**按目录归类 + 层级线** —— 同一目录只有一行目录名(带文件夹图标)、文件名缩进列在它下面,
   深层单链目录压成一行(如 `plugins/file-git-explorer/lib`),悬停能看到完整路径;
   **层级线是纵向虚线**,从目录行连到它最后一个子项的**行中**(下一组不会接着那条线)。
   **两栏顶上的标题栏是实色横条**:把它滚上去,行内容**不得**从字缝里透出来。
   **头上那颗刷新键是官方 SVG 图标**(与分支 / 箭头图标同一画风,不是 `⟳` 字形):点它先 `fetch` 再刷新,
   **忙时图标自转、按钮点不动**,转完停下;刷新不会把你从聚焦提交里踢出来。
3. 点头部那颗分支按钮 → 弹出**分支小浮窗**(`本地分支` / `远程分支`, 远程下面按 remote 名分层缩进);
   点一条远程分支 → 浮窗收起、提交历史换成该分支的历史,**头部那颗按钮仍显示当前检出的分支**;
   再点一条本地分支、按 Esc、点浮窗外面 → 浮窗都能收起。
4. **聚焦提交**:点一条提交 → 下栏**整栏**只剩这一条(带一层极淡的品牌色底),顶上是 `← 返回` | `作者 · 时间` | hash 胶囊;
   下栏**自动放大到 60%**。聚焦里:
   **说明默认只占两行**;长说明时**「展开」在说明文字的上方**,点开看全文后**按钮还在原地**(不往下跑、不用拉滚动条),
   再点「收起」回到两行;一行很短的说明**没有**这枚按钮;把右栏拖宽到放得下时,「展开」应自己消失。
   文件清单(±行数)同样按目录归类 + 层级线;merge 提交只出说明。
   **展开一段超长说明时,滚动条出现在说明那一段里**(最多约 14 行);两栏外层本来就不显示滚动条(见 §14),
   所以不会看到第二条, 整栏也不会因为滚动条出现而重排。
   **点「返回」(或按 Esc)→ 立刻回到列表**:比例还原、**列表滚回你点进去时那一处**、**没有重新加载/没有闪**;
   若在聚焦里**拖过拖柄**,返回时保留那个新比例;
   悬浮面板开着时按一次 Esc **只关它**,不会同时返回列表。
5. 列表里每行末尾那枚 **hash 胶囊**:点一下 → 胶囊变「已复制」,剪贴板是**完整** hash(不是显示的那 7 位),
   且**不会**连带聚焦这条提交;1.2s 后变回短 hash。
6. 点聚焦里的文件 → **悬浮面板**出现在右栏左侧:视口 1/2 宽、满高、右缘贴右栏左缘;正文是官方 `DiffBlock`(带复制按钮)。
   **页签条上不出现详情页签**(没有"闪一下"), 右栏活动页签仍是「Git」。
   **关掉悬浮面板回到 git 页签: 仍然聚焦在那条提交上, 滚动位置也在, 且没有重新加载。**
7. 官方文件树点一个文件 → 用**同一个**悬浮面板位显示官方正文;再点另一个文件 → 仍是**一个**面板、内容就地更换。
   **每次点文件, 右栏都停在「文件」页签**(不会自己跳到 git 树), 页签条同样不闪。
8. 悬浮面板头部:文件名前有文件类型图标,后随一枚**复制图标**;点它 → 图标变「已复制」,剪贴板是磁盘原文
   (只有带扩展名的文件有;`html`/`pdf`/图片与无扩展名文件没有这枚图标)。
   **文件名要完整显示**(长文件名不再被截成 "…" —— 卡它的是官方给**页面签**钉的 170px 上限, 浮窗里那一格已放开;
   真到没地方时才是省略号),**点文件名本身 → 剪贴板拿到这个文件名**(diff 详情里显示的是路径, 就复制路径; 两条路径都覆盖),
   (文件名只染一下色当反馈, 文字不变;这一下不影响页签的选中),
   **但"按住文件名把页签拖走"那一下不许复制**(拖动与点击的分界就是 4px, 与官方拖拽起手同一条线)。
   头部右端**只有「关闭」一枚图标** —— 官方那枚「送回侧栏」已按实现事实 §11 第 2 条藏掉;
   而把**别的东西**拖浮起来(官方页签拖出侧栏 / 页签菜单), 它头上的「送回侧栏」**仍然在**。
   **头部那枚「全屏」**(文件名/复制图标之后, 本插件加的): 点它 → **面板铺满整个视口**(左栏与中栏都被盖住)
   且提示变「退出全屏」, 再点一下回到 **1/2 宽 + 贴右栏左缘**那份几何; **页签条上不该有这枚按钮**。
9. 收起右栏 / 切换会话 / 切换工作区 / **按 Esc** → 面板消失(注意与第 4 条的 Esc 分层:悬浮面板在场时只关它)。
10. composer 下方有抽屉舌;点它**向上**展开终端(能跑 `vim` / 颜色 / 补全);抽屉**顶部两角圆角**、
    **展开后不用点、直接敲键就该进终端**(焦点自动在终端里);此刻 **Esc 归终端、不再收起抽屉** ——
    想收起点条空白处 / 页签上的 `×`(把焦点点出去再按 Esc 也是收起, 见下面那句);
    **抽屉与 composer 卡片同宽同列**(拖顶部那条宽度手柄,两者一起变宽变窄),
    **抽屉和页面分得开** —— 终端体是官方终端卡片底色(浅色主题下比页面略灰), **标题条没有自己的底色**;
    **标题条那条分隔线在页签下面也不断**(页签不许压线), **页签与终止键在"拖柄 + 标题条"这条带子里垂直居中**
    (不是贴着底边那条线), 终端滚动条是**细条 + 圆角**(不是 xterm 默认的 14px 粗条);
    在终端里**拖选一段文字、一松手剪贴板就该有它**(不用按键; 双击选词 / 三击选行同理), 普通单击**不许**动剪贴板,
    再按 **Alt+C** 也能拿到同一段(且 Ctrl+C 仍然照常送 SIGINT);
    **从有内容的地方一路拖到下面那片空白里, 拖蓝不许漫过去、松手后选区就停在最后一行有内容处, 复制出来不许带尾巴空行**
    (中间本来就有空行的那种照样留着), **从空白处往上拖**同样收干净, **整段都拖在空白里**则什么都不选;
    **条右侧那枚开关**: 关掉它之后选中**不再自动进剪贴板**, 但 `Alt+C` 照旧、选区照样收尾巴, 点它**不能把抽屉收起来**,
    状态刷新页面后还记得(默认开); **开关里的文字与轨道上下对齐**(文字行盒与轨道同顶同高、中心线重合),
    **终止键是官方 SVG 方块图标**(不是 `■` 文字字形, 取危险色), 拉近看图标与页签文字的中心在同一条线上;
    **鼠标移到抽屉上缘时, 那条 5px 的拖柄不得变色**(只变指针形状; git 页签里那条分栏拖柄同一口径, 见第 2 条);
    **终端底色 = 主题色而非 xterm 的黑**, **切明/暗主题时已经开着的终端就地换色**(不必重开抽屉);
    **彩色输出看得清** —— 16 色 ANSI 按明暗自成一套、逐个颜色验过对比度(浅色面最紧 5.2:1),
    加粗的高亮词不会切到"亮白 / 亮黄"那种在浅底上糊掉的颜色;
    **点终止键杀掉终端再重开, 回放里不该出现旧的输出、也不该出现一屏 `PowerShell …` banner**(只剩一条"已开启新终端"标记);
    顶上**终端标题条**里恰好**一枚页签**(`>_` 字形 + 尾部省略号的
    工作区路径, **没有 `+`**),悬停页签才出现 `×` 且点它只收起、右端**终止键**是**红色**且只杀进程、
    **点条空白处也能收起**;刷新页面后重开抽屉应看到历史输出;Esc(焦点在终端外)收起。
11. **刷新快捷键**:按 `Alt+Ctrl+R` → 与点 `⟳` 同一效果(先 sync 再重取变更列表与历史首页, `⟳` 转起来);
    **焦点在终端里时也照样触发**(这正是从光 `Alt+R` 改成 `Alt+Ctrl+R` 的原因: 光 Alt+R 要留给终端的 readline);
    右栏收起 / 当前不是 Git 那格时按它 → **切到 Git 页签并刷新**;从 composer 里按也灵, 且不许把这一按漏成终端输入。
12. 全程 DevTools 控制台**零 pageerror**、零插件 `console.error`。

## 已知限制(接受, 不是 bug)

- 悬浮面板头部的「送回侧栏」**已被本插件藏掉**(见 §11 第 2 条), 但拖页签 / 页签菜单仍能把详情变回右栏页签;
  被送回去之后再点同一个文件即可重新浮起。
- 悬浮面板**不吸**右栏边缘, 可以被拖走 / 缩放; 换窗口尺寸后也不会自动跟着重排(几何只在浮起那一刻算)。
  (例外是**全屏态**: 那是 CSS 的 `inset:0`, 所以它会跟着窗口尺寸走 —— 不过退出全屏回到的是浮起时
  那一份几何, 中间改过窗口尺寸的话要重新浮起才准。)
- Windows 下 PTY 退出后 ConPTY 会滞留句柄直到事件循环排空, **dsh 重启清零**; 终端进程生命周期与 dsh 进程绑定。
- 终端尺寸同步依赖浏览器 `ResizeObserver`, 极端布局变化下可能差一格, 下一次 resize 自愈。
- 悬浮面板的状态是**按会话**存的(官方 `sidebarRight` 的 store 就是按会话的), 所以切走再切回来会看到它还在;
  切到别的会话时它不会跟过去。

## 术语

「右侧栏页签」「git 页签」「变更列表」「diff 范围」「提交历史」「聚焦提交」「提交说明」「查看分支」「刷新」「悬浮面板」「详情」
「git 页签分栏」「目录归类」「层级线」「composer 座」「抽屉舌」「终端抽屉」「终端标题条」「工作区终端」「回放缓冲」「工作区」的定义见仓库根 `CONTEXT.md`。
