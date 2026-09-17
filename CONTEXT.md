# dsh-plugin(DeepSeek Harness 插件仓库)

本仓库承载 DSH 的插件:需要浏览器 UI 的是**静态双半插件**(Host 半 `lib/index.js` + Client bundle `lib/client.js`),纯功能性的可以是**纯 host 插件**(`package.json` + `lib/index.js` + `tests/`,无 client 半)。静态双半插件经 `dsh plugin --profile web add link:<abs-path>` 挂进 web profile,共享同一套挂载契约(`package.json` + `manifest.json` + `cordis.patch.yml`);纯 host 插件挂进 **agent preset**(见下方 `browser-operator`)。

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
`~/.dsh/.agent-presets/browser-operator/`,从 shipped `standard` 复制而来、只改两处的 agent preset:人设换成浏览器操作员(并在人设里申明产物目录规则),末尾追加一行 `browser-operator` 插件。它的存在理由是给一个会话装上那 9 个工具;插件本身是**纯 host 插件**,不做成 profile bundle。
_Avoid_: 浏览器插件(那是 profile 层的说法)、浏览器模式、browser profile

**浏览器产物目录(browser artifact directory)**:
截图等产物落盘的那个目录,**按会话工作区**解析、**优先选项目已经 ignore 的目录**(`logs/`、`output/`、`scripts/` 等)下的 `browser-operator/` 子目录;仓库里找不到就退到 `$DSH_HOME/browser-operator/<session-id>`,**绝不**往仓库写没被 ignore 的东西。判定以 `git check-ignore` 为准,git 不可用时退化到 `.gitignore` 解析。
_Avoid_: 截图目录、输出目录、workdir、临时目录(它是有规则的,不是随便一个 tmp)
