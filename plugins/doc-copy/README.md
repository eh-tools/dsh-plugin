# dsh-doc-copy

文档预览的**「复制内容」**——在文档页签的 **⋯ 菜单**末尾加一项,一键把该文件**在磁盘上的原始文本**(例如 markdown 源码)复制到剪贴板。

纯客户端插件(host 半是空实现),随 web profile 启动自动加载。

## 安装

```bash
dsh plugin --profile web add link:<repo-abs-path>/plugins/doc-copy
```

## 用法

1. 在右侧栏打开任意文档(如 `README.md`)。
2. 点页签的 **⋯** 菜单 → **复制内容**。
3. 剪贴板里就是该文件的原文(markdown 源码,不是渲染后的 HTML)。

- **只对「有源码」的文件出现**:markdown / 纯文本 / 代码预览都有这一项;`html` / `pdf` / 图片等**渲染型**文件不会出现(它们没有「原始文本」这回事)。
- 复制的是**磁盘上的原件**(经官方 `remote.workspaceFiles.readAll`),与预览是否渲染完、是否滚动到末尾无关。
- 复制成功后就地显示「已复制」并关闭菜单;失败显示「复制失败」。

## 为什么是菜单项,而不是正文上的悬浮按钮

官方文档正文注册在 `sidebar.right.tab.document`,那是一个 **keyed** 槽:

- 注册项**只有 `key`**,没有 `priority`(官方六个占用者 —— text / markdown / html / image / pdf / code —— 的 priority 字段都是框架默认值 0,不是注册选项);
- 槽的语义是「注册已占用的 `key` 会**替换**该占用者」。

也就是说,想往正文上叠一个按钮,就必须**整块顶掉官方正文组件**;而官方组件没有对外导出,自渲染 markdown 会让富文本预览退化。因此本插件改走:

| 取舍                     | 本插件的做法                                                          |
| ------------------------ | --------------------------------------------------------------------- |
| 入口位置                 | 文档页签的 ⋯ 菜单(`sidebar.right.tab.menu.item`,list 槽,不动任何组件) |
| 与「打开方式」菜单的关系 | **不碰** `documentPreviews` 注册表 → 菜单**不会**出现重复项           |
| 卸载                     | 只注销自己那一项,官方行为原样保留                                     |
| 「流式未读完时禁用」     | **不再需要** —— 复制源是磁盘原件,不是部分渲染的预览缓冲               |

## 数据来源

复用官方已有的 Remote face:

```js
ctx.remote.workspaceFiles.readAll(sessionId, path, signal);
```

因此**没有任何自己的 host 路由**,也没有新的信任面。

文件路径从页签地址解析(官方 `dsh-resource://file/…` 格式,两种 scope):

```
dsh-resource://file/session/<sessionId>/<绝对路径>
dsh-resource://file/absolute/<绝对路径>        // 含 Windows 盘符与 UNC
```

## 文件

| 文件             | 作用                                                           |
| ---------------- | -------------------------------------------------------------- |
| `lib/index.js`   | host 半:空实现(全部逻辑在 client 半)                           |
| `lib/client.js`  | 浏览器 bundle:注册文档页签的菜单项,读原文并写剪贴板            |
| `lib/address.js` | 纯函数层(地址解析 / 扩展名 / 可复制判据 / 读取结果归一),供单测 |

> `lib/address.js` 与 `lib/client.js` 里的逻辑是**同源的两份**(bundle 无法 import
> host 的 ESM);`tests/address.test.mjs` 是它们共享的可执行规约,**改其一时必须
> 同步另一处**。
>
> `parseFileAddress` 是对官方 `util/workspace-path/file-address.ts` 的逐语义复刻;
> 地址格式若变, 必须同步。

## 测试与静态检查

```bash
node tests/address.test.mjs   # 纯函数层单测(地址解析 / 扩展名 / 可复制判据 / 归一)
eslint .                      # 仓库统一 lint(client bundle 按惯例忽略)
```

## 已知限制(接受, 不是 bug)

- 只复制**原文**:不做语法高亮、不做选区、不改写换行。
- 二进制文件即使有扩展名也不保证可读 —— 判据是扩展名(渲染型黑名单),不是内容嗅探;真去复制一个 `.bin` 会得到解码后的乱码。
