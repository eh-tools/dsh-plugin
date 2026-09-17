# browser-operator 领域词表(留档)

> 本文件从根 `CONTEXT.md` 整体搬来:browser-operator 已于 2026-09 退役归档到 `plugins/obsolete/`,
> 它当时的正名 / `_Avoid_` 词表跟着一起留档。**在役代码不再引用这些词条**,新改动一律查根 `CONTEXT.md`。
> 它的 agent preset 也已从本机拿掉,退役当天的两份 yml 快照见同目录 `preset/`。

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
