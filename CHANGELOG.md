# Changelog

本文件记录 dsh-plugin 的重要变更,格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循
[SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `browser-operator`:新增目标级工具 `browser_act` —— 给一个目标,内部用 TypeSafe 的 Jev
  连跑「观察 → 决策 → 执行」,最多 12 步(上限 40),返回精简轨迹与 `goalMet` 概率。需要
  `TYPESAFE_API_KEY`;没有它时只有这个工具报错,其余 9 个照常。决策与边界见 `docs/adr/0009`
- `browser-operator`:新增离线单测 `tests/policy.test.mjs`(策略层 + 回路 + 注册形状)与
  `tests/harness.test.mjs`(测试脚手架自身),进 `just check`

### Removed

- `file-git-explorer`:**退役归档** —— 源码、装配护栏(`verify-client-bundles`)与 3 条用例整体搬进
  `plugins/obsolete/file-git-explorer/`,不再维护、不列入默认安装;请从 profile 卸载
  (`dsh plugin --profile web remove dsh-file-git-explorer`)。决策与代价见 `docs/adr/0007`
- `db-console`:去掉对 `--dsh-fge-strip-clear-*`(file-git-explorer 广播的细条净空)的兜底内缩 ——
  变量从来缺省即 0,视觉无变化
- `browser-operator`:**退役归档** —— 纯 host 插件整体搬进 `plugins/obsolete/browser-operator/`,
  **同时把它的 agent preset 也从本机拿掉**(`~/.dsh/.agent-presets/browser-operator/`);
  退役当天的两份 yml 快照留档在该目录 `preset/` 下(绝对路径已换成 `<repo-abs-path>`)。决策见 `docs/adr/0008`

### Changed

- `just check` / `pnpm test`:browser-operator 的自检**从门禁里摘掉** —— 它会真的拉起一个有头浏览器窗口,
  门禁不再要求本机装有 Chrome / Edge / Playwright chromium;要跑请手动
  `node plugins/obsolete/browser-operator/tests/smoke.mjs`
- `.pre-commit-config.yaml`:`check-yaml` 的 exclude 改成 alternation,新增排除 preset 快照
  (`!!js` 自定义标签 PyYAML 解析不了)
- `just check` / `pnpm test`:fge 的用例与装配护栏改从 `plugins/obsolete/file-git-explorer/tests/` 跑
  (护栏脚本的 `ROOT` 随之改为**插件目录**相对,不再相对仓库根)
- 安装链预检(`scripts/verify-plugin-manifests.mjs`):`PLUGIN_IDS` 从**只列 fge** 改为列在役的 5 个
  静态双半包(ds-balance / db-console / deepseek-harness / stylevault-localchrome / batch-archive);
  随之修正 `stylevault-localchrome`、`batch-archive` README 里不合规的路径占位符
  (`<本目录绝对路径>` / `<本仓库绝对路径>` → `<repo-abs-path>`)
- 文档:根 README 把 fge 与 browser-operator 移入「已归档」、删掉各自的安装命令与使用说明小节、
  删掉「例外:挂 agent preset」那条;**删掉随之过期的「效果展示」全览图**
  (`png/home.png` 里还画着右栏 Git 页签与底部终端抽屉),以后要展示再重拍;AGENTS.md 的静态双半包参照换成在役
  插件、补上 `plugins/obsolete/` 归档口径;根 `CONTEXT.md` 的 § file-git-explorer 与 § browser-operator 词表
  整节搬进各自归档目录(`plugins/obsolete/<插件>/CONTEXT.md`),`docs/adr/0002`–`0006` 标注「插件已归档,
  仅作历史记录」
- `browser-operator`:**复活** —— 从 `plugins/obsolete/` 移回 `plugins/browser-operator/`
  (ADR-0008 写明的回滚路径),源码行为除新增 `browser_act` 外未改;它的 preset 快照改造成在役模板
- 测试接线:`justfile` 的 `test` / 根 `package.json` 的 `scripts.test` 与 `scripts.check` 三处都加入
  `browser-operator` 的离线单测;
  `audit` 只在 `justfile` 里加跑插件目录(`pnpm --dir plugins/browser-operator audit`)—— 仓库没有
  pnpm workspace,根 `pnpm audit` 覆盖不到插件的依赖
- `.pre-commit-config.yaml` / `.prettierignore`:两处针对 browser-operator preset 的排除路径
  随插件移出 `obsolete/` 而更新

## [0.4.0] - 2026-09-17

### Changed

- `file-git-explorer`:**终端内核易主** —— 抽屉里的终端改由官方 `ctx.webTerminals`
  (`@deepseek-ai/dsh-api-terminal-controller`)提供:PTY / shell 探测 / 进程归属 / 屏幕快照 /
  每会话配额全归官方,而**抽屉外壳一条没动**(抽屉舌、跟 composer 同宽、高度记忆、终端标题条、
  收起不杀进程、展开自动聚焦、选中即复制 / `Alt+C` / 尾巴收敛 / 那枚开关)。随之而来的行为变化:
  终端从"每工作区一个 / 同工作区多会话共享"改为**每会话一个**(官方配额 8);终止键改为官方
  "请求结束进程"(失败可在抽屉里重试);重连靠官方 host 的**屏幕快照**补屏,不再自留字节回放
- `file-git-explorer`:抽屉正文新增**状态行** —— 按官方 `phase` / `info.state` / `writable` 显示
  一行提示 + 至多一枚动作(正在连接 / 重新连接 / 重试 / 接管输入 / 进程已结束(退出码 N));
  连着且可写时整行不渲染
- 离线护栏:`client bundle 装配` 新增「官方帧桥契约」用例(假 xterm / 假 view 直接跑
  `snapshot → reset + resize → write → ack`);host 冒烟改为断言**零升级路由**且旧路径 404

### Removed

- `file-git-explorer`:自建 PTY 链路整体退场 —— `lib/pty.js`(终端池 / 环形回放 / 帧编解码 /
  shell 绝对路径解析)、`/fge/ws/terminal` 裸 socket 升级、以及 `node-pty` 与 `ws` 的 profile
  锚点解析,连同它们的单测 `tests/pty.test.mjs` 一并删除;host 半保留 `/fge/vendor/*`
  (xterm 仍由本插件自己渲染)

### Added

- 文档:ADR-0006(终端内核易主的决策 —— 为什么"内核归官方、外壳留本插件",以及被否掉的
  「把官方终端页签浮到抽屉位」与代价清单)

## [0.3.0] - 2026-09-13

### Added

- `browser-operator`:**全新纯 host 插件** —— 复现 / 定位 / 验证 Web bug 用的常驻有头浏览器:
  9 个工具(`browser_navigate` / `snapshot` / `click` / `fill` / `eval` / `screenshot` /
  `console` / `network` / `artifacts`);带独立 profile 拉起新进程,与日常 Chrome 并存
  (不占调试端口、不 taskkill);登录态落在 `$DSH_HOME/browser-operator/profile`,跨轮次与
  重启复用;截图等产物只写已 ignore 的目录。挂进 **agent preset**(`agent.cordis.yml`),
  不走 profile bundle
- `stylevault-localchrome`:**全新插件** —— 读本机 Chrome「自定义外观」用户色,解码成
  `#RRGGBB` 推导整套调色板,生成可导入上游 StyleVault 的预设 JSON;已装上游并同意后首次启动
  自动应用,之后可在 Settings 卡片改主意;不挂载也能用 `scripts/build-preset.js` 出预设
- `file-git-explorer`:**重做为 v0.7** —— 详情改走官方 `float`(文档正文原版渲染、diff 用官方
  `DiffBlock`),文件树回归官方、不再自绘;新增**真 PTY 终端抽屉**(`node-pty` ↔ WebSocket ↔
  `xterm.js`,vim / htop / 颜色 / 补全 / Ctrl+C 可用,跨刷新重连回放)
- `file-git-explorer`:git 页签改**上下两栏**(变更列表 / 提交历史),两份列表按目录归类 + 纵向
  层级虚线;提交历史改「聚焦提交」——聚焦时下栏只剩该条(说明默认两行、文件清单带 ±行数)
- `file-git-explorer`:头部**分支树小浮窗**(本地 / 远程分组,点选即换「查看分支」,不动工作区
  实际分支)+ **worktree 切换器**(有工作树时可切看主仓或任意工作树的分支 / 变更 / 历史 / diff)
- `file-git-explorer`:详情浮窗增**「全屏」开关**、`Alt`+滚轮横向滚动、文件名点击复制完整名;
  两份列表的 hash 胶囊点一下复制完整 hash
- `file-git-explorer`:终端选中即复制(带开关)、展开自动聚焦、标题条(页签 + 红色终止键)、
  抽屉宽度跟随对话区、高度按工作区记忆
- `db-console`:SQL 编辑器三级补全(关键字 / 表名 / `表名.` 出列)、`Ctrl/Cmd+Enter` 执行光标
  所在语句或选区、行尾空白以极淡底色标出
- `ds-balance`:`DSH_DS_BALANCE_DEMO=1` 演示模式(写死假数据、不联网,仅供伪造演示环境截图)
- 工具链:`AGENTS.md`(agent 开发约定)、PR 模板与 `commit-msg` 内容完整性门禁、client bundle
  装配冒烟、安装链预检(含跨插件冲突检查)、`audit` 改扫全部依赖(含 dev)
- 文档:ADR-0002 / 0003 / 0004 / 0005(file-git-explorer 的实现取舍)

### Changed

- `file-git-explorer`:右栏宽度可拖(**200px ~ 15% 视口**),隐藏官方那两枚「分栏」「进全屏」
  按钮;手动 `⟳` 刷新带 `git fetch --all --prune`(限时 8s);新增 `Alt+Ctrl+R`(刷新)、
  `Alt+J` / `Alt+L`(切右栏页签)
- `file-git-explorer`:切会话不再重读 git —— 同工作区 30s 内一次请求都不发,更久则先铺快照再后台重取
- `batch-archive`:面板去掉 `backdrop-filter` 毛玻璃、关闭即不挂载主体、行与分组头 `React.memo`,
  归档改 8 路并发
- 根 `README.md` 收敛为速览口径(352 → 153 行):插件清单合并为一句一行,使用说明只留功能点,
  原理与配置表移交插件自身 README;仓库不再内嵌逐插件截图,只保留一张全局全览图

### Fixed

- `file-git-explorer`:仓库根解析不再缓存(修新建仓库后失效);切工作区 shell 输入框不再残留上
  一个工作区的命令;点文件后 git 页签不再被重置;`xterm` 加载失败不再被永久缓存(重开抽屉可重试);
  终端选区不再拖进空白区;分支下拉与浮动栏互斥;深层被忽略目录可达;详情文件名不再被提前截断
- `db-console`:修正 SQL 编辑器光标与高亮文本错位、补全上屏后光标跳回开头、underlay 与输入层
  尺寸不共享等一组渲染问题;smoke 的 0600 断言改为只在 POSIX 上生效
- `deps`:`js-yaml` 升到 4.3.2,修 `GHSA-2883-xcg3-v3hh` 高危 DoS

## [0.2.0] - 2026-08-29

### Changed

- `file-git-explorer`:左树**删除确认改为 DSH 风格模态**——遮罩 + 居中卡片 + 取消/删除按钮(删除为危险色), Esc 或点遮罩取消, 替代原生 `window.confirm`;删除失败提示改为同款模态并中文化错误码(替代原生 `window.alert`)
- `file-git-explorer`:shell 行改进——**运行中锁定输入框**:Enter / ✓ 执行后光标离开、输入框只读不可编辑(↑/↓ 历史导航一并禁用), 任务结束后恢复可编辑
- `file-git-explorer`:提交历史详情改版——点条目**仍在历史面板内**展示完整提交说明 + 文件 ±行数列表;点某条文件记录改为在历史面板**左侧单开该文件的 diff 悬浮栏**(复用右侧变更列表的 diff 面板与交互, 不再在面板内展开), 历史列表与详情保持不动、互不关闭;换提交 / 回列表 / 收起右栏 / Esc / 切换工作区时随历史一并关闭

### Changed

- `file-git-explorer`:shell 输出窗内容**不自动换行**(`white-space:pre`,长行横向滚动,终端式阅读),去掉 `word-break:break-all`
- `file-git-explorer`:shell 输出窗边框改版——**上下边框均为粒子鲸鱼淡化蓝**(`rgb(103,153,254)`,与 deepseek-harness 插件鲸鱼背景同色系),展开态**同步呼吸、上强下弱**(上 .28↔.9 / 下 .08↔.32,只脉动边框颜色无光晕扩散),遵循 `prefers-reduced-motion` 关闭动画

### Added

- `file-git-explorer`:**文件编辑与树内写操作**——内容悬浮面板新增纯 textarea
  编辑态(`⌘S/Ctrl+S` 保存、Esc 退出、Tab 补两空格、未保存关闭/退出拦截确认);
  保存带 `mtimeMs` 乐观并发校验(磁盘被外部改动 → 冲突提示「重新加载磁盘版 /
  仍要覆盖写入」);左树新增**新建**(分区头 `+` 与目录行 `+`, 名称以 `/` 结尾建
  目录、支持 `a/b` 嵌套自动补建父目录)、**重命名**(行悬停 `✎`, 行内输入)与
  **删除**(行悬停 `✕`, 目录需确认框 + host 侧显式 `recursive` 双保险);保存后
  自动刷新右侧 git 状态, 树内结构变更局部重载不打断展开, 已打开面板跟随重命名 /
  删除时自动关闭;写类接口路径逐段白校验, 拒绝触及 `.git` 段, save 路由单独放宽
  body 上限至 3 MiB(内容仍限 1 MiB)。新增 `tests/edit.test.mjs`(8 组)
- `db-console`:全新**数据库控制台插件**——会话头部新增「数据库」页签(排在轨迹后),
  粘贴完整 PostgreSQL 链接串登录;连接按仓库根(项目)单例保存在
  `~/.dsh/storages/db-console.json`(明文 + 0600, 口径见 `docs/adr/0001`),
  切工作区/刷新/重启均不失效;已连接态提供 schema 内省树(表/列, 手动刷新)、
  SQL 编辑器(关键字/表名/列名三级补全 + 高亮 underlay, `Ctrl/Cmd+Enter` 执行)
  与结果网格(500 行截断提示、单元格点击复制、多语句分段、影响行数);执行不拦截
- `file-git-explorer`:侧栏联动升级——切到轨迹/数据库等非对话页签时两树自动收成
  细条(悬停细条仍可展开), 切回对话还原进入前的固定/开合快照;悬停保持改为
  「侧栏 + 其悬浮栏」联合区域追踪, 鼠标在两者之间移动不再误触延迟收起
- `tool-vision`:支持 on-demand 自动拉起 llama-server 与用后即退(`keepAliveMs`),
  外部已有服务时优先复用,不重复拉起;`dispose` 时清理自拉进程
- `tool-vision`:新增 `apiKey` 配置(支持 `env:NAME` 引用环境变量,避免明文入库),
  可接入任意 OpenAI 兼容**云端**视觉服务(OpenAI / 智谱 / qwen-vl / OpenRouter 等)
- `tool-vision`:Windows 平台适配(路径按 `os.homedir()` 解析、`taskkill /T` 整树
  清理、`windowsHide` 不弹控制台窗口);支持 LM Studio / Ollama / vLLM 等任意
  OpenAI 兼容视觉服务
- 仓库开源化:MIT 协议、贡献指南、安全政策、变更日志
- 根 README 改为**使用导向**:新增各插件使用说明与「常见问题」FAQ 速查,
  弱化开发/贡献篇幅
- `file-git-explorer`:提交历史面板头部新增**查看分支切换器**——分支名可点,
  弹出与右树同款的本地/远程分组菜单(标记「当前 / 查看中」), 点选即按该分支
  重拉历史列表;历史列表条目之间、单条详情的文件行与展开 diff 块之间增加分割线

### Fixed

- `file-git-explorer`:shell 状态点改为**按需显示**——运行/启动中显示绿点,已停止的任务(命令保留在输入框内)显示红点;空闲(无任务)或输入框为空时不显示任何点,不再有空闲红点的噪音
- `file-git-explorer`:shell 输出窗改为**常驻一行显示**——默认一行高(自动滚底显示最新一行),输入框**左侧小箭头**切换一行/完整显示,**▶ 只执行、不再控制输出窗显示**(执行/刷新/认领任务都不自动展开);输出窗不再带头部,开关回到行首箭头
- `file-git-explorer`:右树顶部分支下拉新增**点外收起**——鼠标单击下拉外任意位置(面板内其他区域 / 页面其他处)即关闭分支列表,不再必须再点一次分支名
- `ds-balance`:修复"今日"调用量在每天本地凌晨(UTC+8 的 00:00~08:00)显示 **0** 的问题。
  平台用量接口 `usage/amount` 的 `days[].date` 按 **UTC** 切天(实测忽略 `tz` 参数),
  而插件原按**本地日期**匹配 `todayKey`,导致该时段请求落入上一 UTC 日、"今日"桶尚未
  累积,于是今日显示 0 而本月却很大。现改为按 UTC 取今日日期与 `month`/`year`,与平台
  桶标签对齐;并新增 `usage/amount`(userToken)路径的冒烟回归测试。
- `file-git-explorer`:右树分支下拉与 diff / 提交历史悬浮栏都出现在面板左侧
  同一留白带,同时打开会互相遮挡 —— 现改为**互斥**(开一关一);顺带修复移入
  分支下拉会误触发面板延迟收起的问题。
- `file-git-explorer`:修复左树忽略区看不到**深层被忽略目录**的问题。忽略分区
  原先只列"自身被 .gitignore 忽略"的条目,而 `src/__pycache__` 这类深层忽略路径
  的各级父目录(`src`)都未被忽略,导致它在可见区被过滤、在忽略区又走不到,
  整棵树任何分区都不显示。现忽略区引入**桥接目录**(自身未忽略但子树含忽略项的
  普通目录,经一次 `ls-files -o -i --exclude-standard --directory` 批量探测标记
  `subIgnored`),逐级展开即可到达任意深度的忽略项;可见/隐藏区分桶不受影响。
- `file-git-explorer`:修复 shell 行**切换工作区后输入框残留上一个工作区命令**的
  问题——`ShellBar` 在 `root` 变化时未重置输入 `value`,已执行/已输入的命令文本会
  随工作区切换带进新工作区(新工作区无任务记录时尤其明显)。现在切走即清空输入框,
  再按新工作区自身认领的任务(若存在)把命令文本放回,与「执行后命令保留不清空」
  的既有语义一致。

## [0.1.0] - 2025-08-17

首个可用版本。

### Added

- `ds-balance`:官方 stats 行下方显示 DeepSeek 余额 + 今日/本月调用量,每 5 分钟
  刷新;浏览器一键登录获取 `userToken`;非官方 API 或未配置 key 时整行隐藏
- `tool-vision`:本地识图工具,把图片发给本地 OpenAI 兼容视觉服务并返回描述
  (零依赖,直接挂载任意绝对路径)
- `paste-image`:输入框粘贴图片即落盘到会话工作目录 `attachments/`,路径写入草稿,
  供 `tool-vision` 识别
- 工具链:prettier / eslint / justfile / pre-commit 门禁(lint、冒烟测试、依赖审计、
  密钥扫描、Conventional Commits)

### Changed

- `ds-balance` / `paste-image`:由动态插件(`cordis_define` / `cordis_run`)改造为
  **静态双半 npm 包**(`dsh.bundle.patch` + `dsh.client`),随 `dsh web` 启动自动
  挂载,无 Run 卡批准,重启不丢;client→host 通信改用 `ctx.webServer` HTTP JSON 路由

### Removed

- 删除已废弃的动态插件参考文件(`ds-balance` / `paste-image` 的 `host.js` /
  `client.js` 与 `ds-balance/install-v2.md`);`verify-ds-balance.mjs` 冒烟测试
  改为直接挂载静态实现 `lib/index.js`(走 `/ds-balance/api/query` 路由入口)

### Fixed

- `paste-image`:落盘改用 `node:fs` 直写(绕开代理沙箱 `ctx.shell` 的 read-only
  seatbelt 限制,修复 mkdir EPERM);补充回归测试并修正 pre-push 语法检查
