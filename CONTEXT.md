# dsh-plugin(DeepSeek Harness 插件仓库)

本仓库承载 DSH 的插件:需要浏览器 UI 的是**静态双半插件**(Host 半 `lib/index.js` + Client bundle `lib/client.js`),纯功能性的可以是**纯 host 插件**(`package.json` + `lib/index.js` + `tests/`,无 client 半)。静态双半插件经 `dsh plugin --profile web add link:<abs-path>` 挂进 web profile,共享同一套挂载契约(`package.json` + `manifest.json` + `cordis.patch.yml`);纯 host 插件挂进 **agent preset**(本仓库当前没有在役的纯 host 插件;归档例子见 `plugins/obsolete/browser-operator/`)。

## db-console(数据库控制台插件)

**数据库页签(database view)**:
注册进会话头部的第三个视图(id `database`),与对话、轨迹平级、排在轨迹之后。
_Avoid_: 数据库标签页、DB 标签

**数据库连接(database connection)**:
项目级**单例**——隔离键取「仓库根」(cwd 向上找到的第一个 `.git` 所在目录,无仓库退化为 cwd 本身),一个项目至多一条,以完整 PostgreSQL 链接串描述,**明文**持久化在 Host 侧(UI 打码展示、配置文件权限收紧);切换项目即面对另一条连接。没有连接列表、没有命名连接,也不做加密。
_Avoid_: 多连接、连接管理器、工作区级(隔离的是项目,不是 DSH 会话工作区)、加密(明确放弃)、主口令(随加密一并放弃)
