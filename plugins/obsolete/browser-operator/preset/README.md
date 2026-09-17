# browser-operator 的 agent preset(留档快照)

退役当天从 `~/.dsh/.agent-presets/browser-operator/` 拷来的两份文件。**本目录不参与任何挂载** ——
它只是"这个 preset 当时长什么样"的记录,因为那份 preset 只存在于本机,不拷进仓库就没了。

- `preset.yml`:preset 的名字与描述(选择器里显示的那两行)。
- `agent.cordis.yml`:退役当天那份 **shipped `standard` preset 的副本**,只改了两处 ——
  开头的 `persona`(人设换成「浏览器操作员」,并在人设里申明产物目录规则)与末尾的
  `browser-operator` 插件行。其余行**不是本插件的东西**,是那天 `standard` 的样子,别当成仓库配置来读。

⚠ 本机那份把插件行写成**绝对路径**(预设的一条 `name` 只要是绝对路径,roster 就转成 `file:` URL
直接 import,因此不必把插件装进 profile)。拷进仓库时已换成 `<repo-abs-path>` 占位符,以符合仓库的路径约定。

⚠ 快照内**其余的文字一律保持退役当天的原样** —— 包括那些还写着老位置 `plugins/browser-operator` 的注释。
插件现在在 **`plugins/obsolete/browser-operator/`**(本目录的上一级)。

⚠ 这个文件带 `!!js` 自定义标签(`disabled: !!js process.platform === 'win32'`),PyYAML 解析不了,
所以 `.pre-commit-config.yaml` 里的 `check-yaml` 把它排除了 —— 与 `plugins/obsolete/tool-vision/cordis.yml`
同款处理(那条是 markdown 内容,这条是快照)。
