# browser-operator 的 agent preset(模板)

这个目录是**模板**,不是自动挂载的配置 —— 它不参与任何挂载。挂载要把它拷到本机:

```sh
cp -r plugins/browser-operator/preset ~/.dsh/.agent-presets/browser-operator
# 然后把 agent.cordis.yml 里的 <repo-abs-path> 换成仓库的绝对路径
```

拷过去之后**新建会话**即可生效。改插件源码要**重启 DSH**(host 侧插件不热更)。

- `preset.yml`:preset 的名字与描述(选择器里显示的那两行)。
- `agent.cordis.yml`:一份 **shipped `standard` preset 的副本**,只改了两处 —— 开头的 `persona`
  (人设换成「浏览器操作员」,并在人设里申明产物目录规则与 `browser_act` 的用法)与末尾的
  `browser-operator` 插件行。**其余行不是本插件的东西**,是那份 `standard` 的样子,别当成仓库配置来读。

⚠ 它是模板,不是完整组合:它与 shipped `standard` 会漂移(这是 ADR-0008 就记下的既有债)。
上游 `standard` 更新后,正确做法是重新拷一份新的 `standard`、再把 persona 与插件行两处改上去。

⚠ 插件行的 `name` 写成绝对路径 —— 预设的一条 `name` 只要是绝对路径,roster 就转成 `file:` URL
直接 import,因此**不需要**把插件装进 profile。代价是这份 preset 绑定了本机路径,仓库搬家后要跟着改。
仓库里这份用 `<repo-abs-path>` 占位符,符合仓库的路径约定。

⚠ **`agent.cordis.yml`** 带 `!!js` 自定义标签(`disabled: !!js process.platform === 'win32'`),
PyYAML 解析不了,所以 `.pre-commit-config.yaml` 的 `check-yaml` 把它排除了 —— 排除项**只有它**这一个
文件(`preset.yml` 与本文件都不在那个排除项里)。

⚠ `.prettierignore` 另外排除的是**整个 `preset/` 目录**,与上面的 `check-yaml` 是两套机制:
理由是 prettier 会重排 YAML,包括 persona 的 `>-` 折叠块缩进,那会改变语义。
