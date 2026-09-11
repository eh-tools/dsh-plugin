# dsh-files-lite

官方右侧栏**文件树**的轻量接管版:逐级懒加载 + 一个「显示隐藏文件」的眼睛开关。

纯客户端插件(host 半是空实现),随 web profile 启动自动加载。

## 安装

```bash
dsh plugin --profile web add link:<repo-abs-path>/plugins/files-lite
```

卸载后官方文件树自动复位(见下方「接管机制」)。

## 用法

- 右侧栏点「文件」。树根 = **当前会话工作区**(随工作区切换,会话无 cwd 时显示占位)。
- 点目录行展开 / 折叠,子项**首次展开才拉取**(逐级懒加载,无定时扫描)。
- 头部眼睛按钮切换 **显示隐藏文件**:
  - 关(默认):隐藏所有 `.` 开头的条目;
  - 开:显示 dotfile,**但 `.git` 在任何情况下都不显示**。
  - 开关状态按浏览器持久化(`localStorage` 的 `files-lite:show-hidden`)。
- 排序:目录优先,同级按 `zh-CN` 名称序。

本插件**只做「看」**——没有搜索、没有编辑 / 保存、没有新建 / 重命名 / 删除、
也没有行操作按钮。需要读文件内容或改文件时,用 agent 的 glob / grep / read / edit
工具;这些能力在 agent 侧本就更强。

## 接管机制

官方 `@deepseek-ai/dsh-client-ui-sidebar-files` 以 `priority: 'builtin'` 注册
`kind: 'files'`。右侧栏注册表(`dsh-client-ui-sidebar-right`)的优先级档为
`extension(3) > builtin(2) > fallback(1)`,且规定**同 kind 的 `extension` 与
`builtin` 可以配对,由高档次者接管**。

本插件因此以 `priority: 'extension'` 注册**同一个** `kind: 'files'`,并存期由本实现
接管该 kind 的页签体;一旦本插件卸载(或未装配),被压住的官方 builtin 实现自动复位。
两侧 `id` 必须不同(注册表对重名 `id` 抛错),本插件用自己的 `dsh-files-lite`。

数据不新增任何 host 路由:目录列表直接复用官方已有的 Remote face
`remote.workspaceFiles.list(sessionId, path, signal)`。

## 文件

| 文件            | 作用                                                          |
| --------------- | ------------------------------------------------------------- |
| `lib/index.js`  | host 半:空实现(全部逻辑在 client 半)                          |
| `lib/client.js` | 浏览器 bundle:注册 `kind: 'files'` 的接管页签 + 树 + 眼睛开关 |
| `lib/zones.js`  | 纯函数层(路径键拼接 / dotfile 判定 / 过滤排序),供单测         |

> `lib/zones.js` 与 `lib/client.js` 里的过滤排序逻辑是**同源的两份**(bundle 无法
> import host 的 ESM);`tests/zones.test.mjs` 是它们共享的可执行规约,**改其一时
> 必须同步另一处**。

## 测试与静态检查

```bash
node tests/zones.test.mjs   # 纯函数层单测(路径键 / dotfile 判定 / 过滤 / 排序)
eslint .                    # 仓库统一 lint(client bundle 按惯例忽略)
```

## 已知限制(接受, 不是 bug)

- 树只展示目录结构,不展示文件大小 / 修改时间 / git 忽略状态。
- 不跟随符号链接展开(交由 host 的列表实现决定)。
