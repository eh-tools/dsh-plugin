# scripts/ 索引

这个目录放**仓库自己的工具脚本** —— 门禁钩子的入口,以及能离线跑的自检。它不是插件目录:
插件在 `plugins/`,每个插件是一个独立 npm 包。

新增脚本时:放这里,在下面表格里加一行,写清**谁调用**;如果它要接进门禁,同步
`justfile` 与 `.pre-commit-config.yaml`(两处口径必须一致)。

## 一览

| 脚本                                                         | 语言   | 谁调用                                   | 干什么                                                              |
| ------------------------------------------------------------ | ------ | ---------------------------------------- | ------------------------------------------------------------------- |
| [`verify-plugin-manifests.mjs`](verify-plugin-manifests.mjs) | Node   | `just test` / `just check` / `pnpm test` | 离线重放 dsh 的插件安装链校验,把"重启才发现装不上"提前到提交前      |
| [`verify-ds-balance.mjs`](verify-ds-balance.mjs)             | Node   | `just test` / `just check` / `pnpm test` | ds-balance 的 host 逻辑冒烟测试(mock ctx + HTTP 路由,无网络)        |
| [`check-theme-token-drift.mjs`](check-theme-token-drift.mjs) | Node   | 手动 / `just theme-drift`                | 对比官方语义 token 与方案覆盖,列升级 dsh 后漏掉的主题 token         |
| [`no-commit-on-main.py`](no-commit-on-main.py)               | Python | pre-commit(`pre-commit` 阶段)            | 拒绝在 main 上直接提交,放行非 main / merge / 首个提交               |
| [`commit-message-body.py`](commit-message-body.py)           | Python | pre-commit(`commit-msg` 阶段)            | `fix`/`perf`/`refactor` 必须用「标签: 内容」行补齐 body             |
| [`enable-branch-protection.sh`](enable-branch-protection.sh) | Bash   | 手动,一次性                              | 用 GitHub rulesets 给 main 开分支保护(禁删、禁 force-push、必须 PR) |

个人自动化脚本不放这里 —— 它们在同级的 `demos/`(已 gitignore,见文末)。

## 门禁类(被 pre-commit 钩子调用)

### `no-commit-on-main.py`

`pre-commit` 阶段的守门人,`always_run`。分支是 `main` 就退出码 1,并提示 `just branch <名字>`。

放行三种情况,都不是"漏洞"而是必要例外:非 `main` 分支(含 rebase 中途的 detached HEAD)、
merge 提交(`MERGE_HEAD` 存在)、仓库首个提交(还没有 HEAD)。

这条规则的正本在 `AGENTS.md` 的「本仓库走分支模式,不用 worktree」—— 主工作区同时只能进行
一个任务,是这个选择的代价。

### `commit-message-body.py`

`commit-msg` 阶段,接在 `conventional-pre-commit` **之后**跑:header 格式已经由那个钩子保证,
这个脚本只管 body 的内容完整性。

| 类型       | 必填标签           |
| ---------- | ------------------ |
| `fix`      | 现象 / 成因 / 复测 |
| `perf`     | 基线 / 优化 / 度量 |
| `refactor` | 动机 / 验证        |

其余类型(`feat` / `docs` / `style` / `test` / `chore` / `ci` / `build`)不强制 —— 小提交的
subject 已能承载上下文。工具链自动生成的提交(`fixup!` / `squash!` / `amend!` / `revert!` /
`Merge` / `Revert`)直接放行。

### `enable-branch-protection.sh`

**不是**钩子,是仓库推到 GitHub 后手动跑一次的一次性配置:

```sh
scripts/enable-branch-protection.sh <owner>/<repo>
```

它 POST 一个名为 `protect-main` 的 ruleset,三条规则:禁止删除、禁止 non-fast-forward(即
禁 force-push)、必须走 PR。单人项目所以 `required_approving_review_count: 0` —— 必须开 PR,
但自己就能合。需要本机已登录 `gh`。

## 自检类(离线可跑,进 `just test`)

两个都是 **`just check`(= lint + test + audit)的组成部分**,不需要 DSH 进程、不需要浏览器,
所以能进 CI 和 pre-push。

### `verify-plugin-manifests.mjs`

为什么值得单独写一个:这条链上的错误**只在真实 boot 时才炸**,而 boot 失败会把整个 profile
拉成 FAILED fiber。本脚本把 dsh 自身的校验规则与挂载契约在本地重放一遍。

重放的规则(与 dsh 实现对齐):

- `dsh.client.platform` 必须存在且为 `"web"`,否则该包被**静默忽略**;
- 声明了 `dsh.client` 就必须有可解析的 `exports["./client"]`,且文件真实存在;
- 包名出现在 `dsh.profile.bundles` 时,必须有 `dsh.bundle.patch` 且文件存在;
- 挂载行(`cordis.patch.yml` 的 insert)里的 `name` 必须**等于包名** —— 否则那一行挂的是别的
  包,而 boot 不会因此报错,只会静默少一个插件;
- `manifest.json` 的名字 / `files[]` 与磁盘一致。

在役插件清单写在脚本内的 `PLUGIN_IDS`(`plugins/obsolete/**` 的归档插件不入列)。

### `verify-ds-balance.mjs`

直接 `import` `plugins/ds-balance/lib/index.js`,用 mock ctx 挂载,再经注册的 HTTP 路由
(`POST /ds-balance/api/query`)校验:余额 / 用量解析、official 判定、失败回退与缓存行为。

它替身掉 `globalThis.fetch` 喂固定的真实响应结构,所以全程无网络。改 ds-balance 的 host 逻辑
后跑它,别只靠肉眼看面板。

## 诊断类(手动, 不进 `just check`)

### `check-theme-token-drift.mjs`

升级 dsh 后跑一次:`just theme-drift`(或 `node scripts/check-theme-token-drift.mjs`)。

StyleVault 那一层是「按 token 名覆盖」的 —— 它只认自己清单里的 90 来个语义 token。
DSH 每加一批 token(`0.2.1` 的 `--dsw-menu-surface-fill` 就是一例),这些新 token 就退回
官方配色;浅色方案跑在深色外壳上时,弹层会变成深色底板 + 深色字。这类回归靠肉眼看,通常
要等某个弹层变灰才发现。

脚本从本机 dsh 的 `dsh-client-ui-theme` stylesheet 提取官方语义 token(alias / specific /
menu / elevation / mask / shadow / linear / gradient),再与方案 JSON 的 `tokens`、以及
profile 里 `patches/dsh-stylevault@0.3.0.patch` 的补丁层做差集,按影响面(弹层/菜单、
设置面板、引导页、diff、状态色…)列出缺口与官方浅/深值。

口径里**不含** `--dsw-static-*`(原始色板)与 `--dsw-font-*`(字号体系) —— 它们不是主题
该逐个覆盖的东西。`--json` 给脚本消费;`--fail-on-drift` 让有缺口时退出 1(默认只报告);
`--dsh-root` / `--scheme` / `--patch` 可覆盖默认路径。

为什么放进本仓库而不是插件里:它检查的是「本机 dsh ↔ 方案 ↔ 本地补丁」三方关系,
需要读本机 dsh 安装,跟着仓库的升级节奏走最合适。

## 个人脚本在哪

个人的自动化 / 试验脚本不放这个目录,而是仓库根的 `demos/`(与 `docs/` 平级),整个目录已写进
`.gitignore`,所以克隆仓库的人看不到它们,本索引也不收录 —— 保持 `scripts/` 只放仓库自己的工具,
`just check` 与两条 commit 钩子才不会因为个人脚本的风格问题变红。

目前 `demos/` 下有一个 `jd-auto-review/`:把「京东评价中心 → 待评价 → 五星好评」固化成命令,
三个文件分工(`review.mjs` API 主入口 / `review-ui.mjs` 点击兜底 / `presets.mjs` 共享文案),
完整说明与「已验证 / 未验证」清单见其目录内的 `README.md`。
