# 0008 — browser-operator 退役:纯 host 插件与它的 agent preset 一起退

- 状态:已接受
- 日期:2026-09-18
- 关联词条:`plugins/obsolete/browser-operator/CONTEXT.md`(随插件一起留档)
- 关联决策:ADR-0007(同批退役的另一半:file-git-explorer)
- 触发:用户口径 —— 「等一下,浏览器操作预设,也归档了吧」

## 背景

`browser-operator` 是本仓库唯一的**纯 host 插件**:往 host 的 `tools` 注册表注册 9 个 `browser_*` 工具,
驱动一个常驻、有头、跨轮次的 Chrome 会话。它不装 profile,而是挂进一份 agent preset
(`~/.dsh/.agent-presets/browser-operator/`)—— 那份 preset 是 shipped `standard` 的副本,只改了两处:
人设换成「浏览器操作员」,末尾追加一行插件。

两件东西绑在一起:插件只服务那份 preset,预设只为了装那个插件。所以退役要一起退 —— 只退一边会留下一份
挂不起来的 preset,或一份没人挂的插件。另外,那份 preset **只存在于本机**(`.agent-presets/` 不进仓库),
不主动留档就会永久丢失那份人设。

## 决策点

### 决策点 1:插件与 preset 的退役范围

- 选项:插件与 preset 都退 / 只归档仓库插件、preset 由用户自理 / 只删 preset、插件留仓库
- 选择:都退
- 理由:两者是一对(插件只服务这份 preset,preset 只为了装这个插件),留任一半都是半截状态。
- 代价:用户失去"开一个带可见浏览器的会话"这条现成路径;要恢复得重建 preset 并把路径改回来。

### 决策点 2:本机 preset 的留档方式

- 选项:直接删除 / 删除前把两份 yml 拷进归档目录留档
- 选择:拷贝留档后再删
- 理由:那份人设(`persona` 那几百字)是原创内容,而 `agent.cordis.yml` 本来只是本机文件,
  不拷进仓库就永久没了。
- 代价:归档里多出一份 337 行的 `agent.cordis.yml` 快照 —— 它九成是 shipped `standard` 的内容,
  会与 shipped 版本漂移。已在 `preset/README.md` 里写明"这是退役当天的快照,别当成仓库配置读",
  并把本机绝对路径换成 `<repo-abs-path>`(仓库禁止在文档 / 配置里写本机绝对路径)。

### 决策点 3:自检是否继续跟着门禁跑

- 选项:继续跑 / 从门禁里摘掉
- 选择:摘掉
- 理由:与 ADR-0007 里 fge 的处理(继续跑)**不同** —— 这条自检会真的拉起一个有头浏览器窗口,
  也就是 `just check` 因此要求"本机装有 Chrome / Edge / Playwright chromium"。为一份不再演进的归档代码
  保留这个环境前提不划算。
- 代价:归档的 `tests/smoke.mjs` 不再有任何自动执行点,只能手动跑,它自身的能力不再被门禁保护。

### 决策点 4:`check-yaml` 的排除

- 选项:给快照改成非 YAML 后缀 / 在 `check-yaml` 里排除它 / 不排除(但它会炸)
- 选择:排除
- 理由:快照带 `!!js` 自定义标签(`disabled: !!js process.platform === 'win32'`),PyYAML 的 `safe_load`
  解析不了 —— 提交时 `check-yaml` 必红。仓库里已有同款先例(`plugins/obsolete/tool-vision/cordis.yml`
  因是 markdown 内容被排除),这次把 exclude 改成 alternation 并加注释说明两种特例。
- 代价:`.pre-commit-config.yaml` 多一条需要维护的排除规则。

## 后果

- **正面**:仓库不再有"只服务一份本机 preset"的插件;`just check` 脱离"必须装有浏览器"这个环境前提,
  本机与 CI 都更容易跑绿;那份人设(含产物目录规则)有档可查。
- **负面 / 技术债**:归档的 smoke 只能手动跑;preset 快照会与 shipped `standard` 漂移(文件头已写明);
  本机若还想用可见浏览器,需要重建 preset。
- **残留数据(本次未清理,属用户数据)**:`$DSH_HOME/browser-operator/profile`(独立 Chrome profile,
  含登录态)与 `$DSH_HOME/browser-operator/<session-id>`(历史产物)仍在磁盘上 —— 本次只退 preset 与插件,
  不动这些数据。
- **回滚**:把 `plugins/obsolete/browser-operator` 移回 `plugins/browser-operator`;把 `preset/agent.cordis.yml`
  里的占位符换回绝对路径后放回 `~/.dsh/.agent-presets/browser-operator/`;再在 `justfile` / `package.json`
  里加回那条 smoke —— 源码一个字符未改(纯重命名 + 注释内的路径)。
