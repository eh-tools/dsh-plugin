# AGENTS.md

> Agent 开发仓库时的约定。改这个仓库前读本文件,并按这里的规矩做。
> 完整的人向参考见 `CONTRIBUTING.md`(贡献指南)与 `CONTEXT.md`(领域术语表),本文件不与它们重复,只收敛 agent 每次改动都必须遵守的部分。

## 这是什么仓库

DeepSeek Harness (DSH) 的插件集合。**每个插件 = `plugins/<plugin-id>/` 下的独立 npm 包**,经
`dsh plugin --profile web add link:<repo-abs-path>/plugins/<plugin-id>` **link: 本地安装**挂进 web profile(link: 要求绝对路径)。

## 你改的是哪种插件

一个插件只可能是两种,改之前先分清,两者结构与门禁不同:

**静态双半包**(要浏览器 UI,绝大多数插件是这种):

- `package.json` 声明 `dsh.bundle.patch` → `./cordis.patch.yml`, `dsh.client`(`platform: web`)
- host 半 `lib/index.js`(ESM,命名导出 `name` / `inject` / `apply`)
- client 半 `lib/client.js`(浏览器 bundle)
- 自带 `cordis.patch.yml` 挂载层
- 参照 `plugins/ds-balance`、`plugins/file-git-explorer`、`plugins/stylevault-localchrome`

**纯 host 插件**(无浏览器 UI):`package.json` + `lib/index.js` + `cordis.yml` 示例 + `tests/`。参照 `plugins/obsolete/tool-vision`。

## 命名约定

- 插件 id 用 **kebab-case**;npm 包名 = `dsh-<plugin-id>`(如 `dsh-ds-balance`);卸载/移除也用 `dsh-<plugin-id>` 这个名字。

## 改代码的硬性约定

- **改动生效方式**:只改 `lib/client.js` → 刷新浏览器即可生效;改 `lib/index.js`(host 侧)→ 需**重启 DSH**。
- **路径占位符**:文档、安装命令里**绝不写本机绝对路径**,一律用 `<repo-abs-path>` 占位符。
- **密钥不入库**:凭证只能进 `~/.dsh/.credentials.yaml` 或 `.env`(已 gitignore);任何 `sk-xxx` / token 一进提交就被 gitleaks 拦截——绝不写进代码、文档或 git。

## 开发流

### 1) 先开一个隔离分支(worktree)

主分支 `main` 受保护,**禁止直接向 main 提交**。用 worktree 隔离开发:

```sh
just wt <功能名>     # 建 .worktrees/<功能名> + 装依赖 + 软链 .env
cd .worktrees/<功能名>
```

分支命名建议 `feat/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`;合并后 `just wt-rm <功能名>` 清理 worktree 与分支。

### 2) 提交前必过门禁

`just check`(= lint + test + audit)**必须全绿**才能提 PR。commit / commit-msg 钩子会自动跑
prettier+eslint 修复、密钥扫描、Conventional Commits 校验;手动即 `just lint` / `just test` / `just audit`。

### 3) 提交前更新根目录 README

每次改动都要**同步根目录 `README.md`**:

- 新增插件 → 「插件清单」表加一行,并在「快速上手」「插件使用说明」补对应安装命令与章节;
- 改插件行为 / 配置 → 同步对应使用说明小节;
- 一致的用 `<repo-abs-path>` 占位符。

## 提交规范

Conventional Commits:`<type>(<scope>): <subject>`;subject ≤72 字符、不以句号结尾;type 取自
`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`。完整清单与示例见 `CONTRIBUTING.md`。

## 术语与命名

涉及面板 / 交互 / 容器的命名先查 `CONTEXT.md`——它是本仓库的术语表,每条都标了 `_Avoid_`
同义词。**用正名,别自创或混用 `_Avoid_` 标记的名字**;新增概念按同样的正名 + `_Avoid_` 格式补进 `CONTEXT.md`。
