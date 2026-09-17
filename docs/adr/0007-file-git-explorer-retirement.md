# 0007 — file-git-explorer 退役:右栏 Git 页签 / 详情悬浮面板 / 终端抽屉整体归档

- 状态:已接受
- 日期:2026-09-18
- 关联词条:`plugins/obsolete/file-git-explorer/CONTEXT.md`(随插件一起留档)
- 关联决策:ADR-0002 / 0003 / 0004 / 0005 / 0006(它们描述的能力随本插件一起进入历史)
- 触发:用户口径 —— 「我们的 file git 插件可以退休了」

## 背景

`file-git-explorer` 是本仓库体量最大的插件:自绘右栏 Git 页签(上下两栏 / 目录归类 / 聚焦提交)、
由官方 float 承载的详情悬浮面板、composer 座下方的终端抽屉。client 半是一份 **4633 行**的手写浏览器闭包,
另有 **2088 行专属装配护栏**与 **178 行领域词表**(45 个词条 / 33 条 `_Avoid_`)。

它在本机 web profile 里早已 `enabled: false`(装着但不加载),而它承担的能力在官方右栏里已有对应物
(工作区文件树、文档预览、终端页签)。继续维护的代价是实打实的:官方每动一次 client 契约,都要同时维护
这 4.6k 行闭包 + 2k 行护栏 + 一整节词表 —— 而收益是零,没有任何会话在用它。

## 决策点

### 决策点 1:退役方式

- 选项:**归档到 `plugins/obsolete/`** / 从仓库删除 / 只从 profile 卸载而不动仓库
- 选择:归档
- 理由:与既有两个归档插件(`tool-vision` / `paste-image`)同一口径 —— 源码、护栏、词表、ADR 链一起留档,
  日后想翻"当时怎么做右栏浮窗 / 怎么接官方终端"时还在;root README 的「插件清单」把它标成「已归档」
  并移出默认安装。
- 代价:仓库里仍带着约 2.4k 行不再演进的代码,且它的用例继续跟着 `just check` 跑(见决策点 2)。

### 决策点 2:专属护栏的归属

- 选项:随插件搬进 `plugins/obsolete/file-git-explorer/tests/` 并继续跑 / 留在 `scripts/` 只改路径 / 直接删掉
- 选择:随迁 + 继续跑
- 理由:这套护栏是**这个插件**的装配契约(26 项:种子模块引用、槽位 / key / priority、终端帧桥),不是仓库通用能力;
  留在 `scripts/` 等于让"仓库级脚本"里躺着一份只服务归档代码的文件。`ROOT` 随之从「仓库根」改成「插件目录」,
  26 项检查一项没少。
- 代价:归档用例在**没有 `pnpm --dir plugins/obsolete/file-git-explorer install`** 的环境里,依赖 xterm 的
  vendor 小节会打印 skip 而不失败 —— 那是既有的降级设计(见该插件 README),不是本次引入的。

### 决策点 3:安装链预检的名单

- 选项:改列在役的 5 个静态双半包 / 保留 fge(指向归档路径) / 留空
- 选择:改列在役 5 个(ds-balance / db-console / deepseek-harness / stylevault-localchrome / batch-archive)
- 理由:`PLUGIN_IDS` 原本**只列了 fge 一个**。它退役后这个预检要么空转、要么去守一份不安装的归档包,
  两种都没意义。改列在役插件让「装不上会在 boot 期把 profile 拉成 FAILED fiber」这条预检重新有用(8 项 → 45 项)。
- 代价:覆盖面一变宽就立刻暴露两处**既有**违规 —— `stylevault-localchrome` 的 `<本目录绝对路径>`、
  `batch-archive` 的 `<本仓库绝对路径>` 都不符合 AGENTS.md 的 `<repo-abs-path>` 占位符规定,本次一并修正。
  这属于顺带扩大范围,若 review 认为该拆开,把这两行与这段名单还原即可 —— 与本插件的退役无耦合。

### 决策点 4:领域词表的去向

- 选项:从 root `CONTEXT.md` 整节删除 / 整节搬进归档目录
- 选择:搬进 `plugins/obsolete/file-git-explorer/CONTEXT.md`
- 理由:那 178 行是这 4.6k 行代码唯一的词表,删掉等于让归档代码失去可读性;搬走则主词表回到"只讲在役概念"。
  逐项核对过条数一致(45 个词条 / 33 条 `_Avoid_`,内容无损,只加了 5 行说明头)。
- 代价:ADR-0002~0006 的「关联词条」链接从 `CONTEXT.md` 改成归档路径(已同步改完)。

### 决策点 5:过期的界面全览图

- 选项:重拍 `png/home.png` / 删掉
- 选择:删掉(用户口径「截图直接清理了吧」)
- 理由:那张图里画着右栏 Git 页签与底部终端抽屉,退役后不可能再拍到同样的画面;留着就是一张"与当前产品不符"的文档。
- 代价:README 暂时没有界面展示图,以后要展示得重拍一张只含在役插件的。

## 后果

- **正面**:维护面收窄到一个明确集合;`just check` 输出里不再有 fge 专属护栏;安装链预检从守 1 个插件升到守 5 个;
  词表与 5 篇 ADR 都可追溯。
- **负面 / 技术债**:归档代码仍跟着门禁跑(依赖缺失时部分小节 skip);README 暂无界面展示图;
  ADR-0002~0006 的五条决策从此只具历史价值 —— 它们描述的能力已不在产品里。
- **回滚**:把 `plugins/obsolete/file-git-explorer` 移回 `plugins/file-git-explorer`,再把 `package.json` /
  `justfile` / `eslint.config.js` / `.prettierignore` / `scripts/verify-plugin-manifests.mjs` 里的路径与名单
  改回来即可 —— 源码本身一个字符都没动(`lib/client.js` 与 `lib/git.js` 是纯重命名)。
