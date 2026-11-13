# dsh-plugin(DeepSeek Harness 插件仓库)

本仓库承载 DSH 的插件:需要浏览器 UI 的是**静态双半插件**(Host 半 `lib/index.js` + Client bundle `lib/client.js`),纯功能性的可以是**纯 host 插件**(`package.json` + `lib/index.js` + `tests/`,无 client 半)。静态双半插件经 `dsh plugin --profile web add link:<abs-path>` 挂进 web profile,共享同一套挂载契约(`package.json` + `manifest.json` + `cordis.patch.yml`);纯 host 插件挂进 **agent preset**(在役例子见 `plugins/browser-operator/`)。

## db-console(数据库控制台插件)

**数据库页签(database view)**:
注册进会话头部的第三个视图(id `database`),与对话、轨迹平级、排在轨迹之后。
_Avoid_: 数据库标签页、DB 标签

**数据库连接(database connection)**:
项目级**单例**——隔离键取「仓库根」(cwd 向上找到的第一个 `.git` 所在目录,无仓库退化为 cwd 本身),一个项目至多一条,以完整 PostgreSQL 链接串描述,**明文**持久化在 Host 侧(UI 打码展示、配置文件权限收紧);切换项目即面对另一条连接。没有连接列表、没有命名连接,也不做加密。
_Avoid_: 多连接、连接管理器、工作区级(隔离的是项目,不是 DSH 会话工作区)、加密(明确放弃)、主口令(随加密一并放弃)

## browser-operator(浏览器操作插件 + 预设)

**浏览器会话(browser session)**:
本插件在宿主进程里持有的那**一个** Playwright `BrowserContext`——有头可见、跨对话轮次存活、dsh 重启后重建。预设是 standing mount(每进程一份),所以同时刻只有这一个会话;它是惰性创建的(首次 `browser_*` 调用才拉起),`dispose` 时关掉。
_Avoid_: 浏览器实例、浏览器进程、tab、窗口(窗口是它的外观,不是它的身份)

**独立浏览器 profile(dedicated browser profile)**:
浏览器会话专用的 user-data-dir(`$DSH_HOME/browser-operator/profile`),与用户日常浏览器的 profile **完全无关**。登录态就存在这里,所以「登录一次长期复用」;也正因为它独立,Playwright 能带自己的 `--user-data-dir` 起新进程,不必碰调试端口。
_Avoid_: 用户 profile、默认 profile、Chrome 用户数据(那说的是日常浏览器那一份)

**浏览器操作预设(browser-operator preset)**:
`~/.dsh/.agent-presets/browser-operator/`,从 shipped `standard` 复制而来、只改两处的 agent preset:人设换成浏览器操作员(并在人设里申明产物目录规则),末尾追加一行 `browser-operator` 插件。它的存在理由是给一个会话装上那 10 个工具;插件本身是**纯 host 插件**,不做成 profile bundle。
_Avoid_: 浏览器插件(那是 profile 层的说法)、浏览器模式、browser profile

**浏览器产物目录(browser artifact directory)**:
截图等产物落盘的那个目录,**按会话工作区**解析、**优先选项目已经 ignore 的目录**(`logs/`、`output/`、`scripts/` 等)下的 `browser-operator/` 子目录;仓库里找不到就退到 `$DSH_HOME/browser-operator/<session-id>`,**绝不**往仓库写没被 ignore 的东西。判定以 `git check-ignore` 为准,git 不可用时退化到 `.gitignore` 解析。
_Avoid_: 截图目录、输出目录、workdir、临时目录(它是有规则的,不是随便一个 tmp)

**目标级工具(goal-level tool)**:
`browser_act` —— 接一个自然语言目标,内部用 Jev 决策回路连跑若干步才返回的工具。与 9 个**单步工具**(一次调用一个操作)相对。
_Avoid_: 高层工具、智能工具、agent 工具、复合工具

**Jev 决策回路(Jev decision loop)**:
`browser_act` 内部的那个循环:读一次页面快照 → 把索引元素表交给 TypeSafe 的 Jev 一次请求(同时问 operation 与所有兼容 target)→ 校验并执行 → 再来一轮。停在 `goal_met` / `stuck` 阈值、`BLOCKED`、步数或预算上;`status` 闭合在 8 个取值上。
_Avoid_: 循环、agent 循环、思考循环、System 2

**索引元素表(indexed element table)**:
回路每一步产出的那张表 —— 每个可见可交互元素一行,带一个当次快照内有效的序号(`[1] button "Round trip"`)。Jev 只能用这些序号指代元素,执行前会校验序号仍在白名单里且未被停用。**序号不跨快照有效。**
_Avoid_: DOM 摘要、元素列表、快照 id、选择器列表

## live-changes(实时变更页签插件)

**右侧栏页签(right sidebar tab)**:
官方**右侧栏**里的一格视图,与官方「工作区文件」「文档预览」以及官方的 `changes-review` 平级并列。注册页签类型与打开某一格是两件事:**注册**只是让右栏知道有这个类型,不占格。
_Avoid_: tag 侧栏、标签页、栏、面板
(本仓库 2026-09 退役的 file-git-explorer 曾用同一正名;那条词随插件留档在其 `CONTEXT.md`,本条目是在役版本。)

**实时变更页签(live changes tab)**:
本插件注册进右侧栏的那一格**只读**视图(页签 kind `live-changes`)。正文是**当前会话**按轮分组的变更列表:轮内先把「正在改」的路径即时上屏,轮末官方 `workspace/changes` 摘要到达后**整轮替换为官方行**,点任意一行进官方 `changes-review` 看该文件 diff。
_Avoid_: 变更看板、实时 diff(它不只是 diff)、改动文件卡片(那是官方收尾消息下方那张)

**轮内流式(in-turn streaming)**:
本插件的变更分两个阶段来源:轮进行中只有**路径**(逐条 `tool/call` 的 `write`/`edit`/有修改作用的 `str_replace_editor` 参数里取 `file_path`),行数与覆盖范围等轮末官方摘要补齐。它是**纯客户端的派生**,不新增 host 采集 —— 具体地,**不**做文件系统 watch、**不**做轮内重拍快照、**不**轮询。
_Avoid_: 文件监听、fs.watch(本插件未用)、轮询、实时快照

**轮末对账(turn-end reconciliation)**:
轮内临时行与官方 `workspace/changes` 摘要的交接:官方摘要一到即成为该轮**唯一**真相,官方没列的路径一律移除(官方已在轮末做过完整对账 —— 快照 diff 加未被快照覆盖路径的副本对比 —— 没列即内容确实没变);`maxFiles` 造成的截断只由摘要的 `total` 反映。
_Avoid_: 合并、增量合并、保留未变项

**首次自动打开(one-shot auto-open)**:
会话**第一次**出现变更时,本插件把实时变更页签自动打开一次;此后不再抢用户的格 —— 用户切走了就不再自动拉回。
_Avoid_: 常驻、默认铺格、自动聚焦(那是抢焦点)

**轮内预览(in-turn preview)**:
轮内点一条「正在改」的行所做的事:打开该文件的**当前内容**(走官方预览),**不是** diff —— 因为 diff 的坐标 `seq` 来自官方轮末才发的 `workspace/changes` 事件,轮内根本不存在。轮末对账后,同一行改为打开官方 `changes-review` 的真 diff。
_Avoid_: 临时 diff、假 diff(轮内不做任何自算 diff)

**详情已释放(released detail)**:
Host 重启后重开的对话里,旧轮的 `workspace/changes` 事件仍在会话日志(它是持久化事件类型),但摘要与逐文件对比只在 Host 进程内存里活着,已经没了。页签为这些轮保留**轮骨架**并如实标一行,不隐藏、不伪造。
_Avoid_: 丢失、不可用(要区分"确实没了"与"出错了")、历史轮

**会话级合计(session total)**:
页签抬头跨轮**去重**的文件数与合计增删。只覆盖当前 Host 进程内还看得见摘要的轮次 —— 它是本页签相对官方单轮改动文件卡片**唯一多给**的信息。
_Avoid_: 工作区脏文件数(那是 git 状态)、总计(没说口径)
