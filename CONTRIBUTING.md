# 贡献指南

欢迎贡献!无论是修 Bug、加功能、补文档还是提建议,都请先读这份指南,保证流程顺畅。

## 目录

- [开发环境](#开发环境)
- [工作流](#工作流)
- [提交规范](#提交规范)
- [门禁检查](#门禁检查)
- [新增插件](#新增插件)
- [PR 检查清单](#pr-检查清单)

## 开发环境

- Node.js >= 20
- pnpm(Corepack:`corepack enable`)
- [just](https://github.com/casey/just)(任务入口)
- [pre-commit](https://pre-commit.com)(门禁)

```sh
git clone https://github.com/eh-tools/dsh-plugin.git
cd dsh-plugin
pnpm install
pre-commit install        # 安装 pre-commit / pre-push / commit-msg 三个钩子
just --list               # 查看全部任务
```

## 工作流

仓库默认分支为 `main` 且受保护,禁止直接向 `main` 提交(有钩子拦截),请走
worktree / 分支 + PR:

```sh
# 推荐:worktree 隔离开发(仓库已内置 just 任务)
just wt <功能名>          # 建 worktree + 装依赖
cd .worktrees/<功能名>
# ...开发...
just wt-rm <功能名>       # 合并后清理 worktree 与分支

# 或普通分支
git checkout -b feat/xxx
```

- 分支命名建议:`feat/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`。
- 合并用 PR(rebase 到最新 `main` 后提),合并后删分支。

## 提交规范

提交信息遵循 **Conventional Commits**,模板见 `.gitmessage`:

```
<type>(<scope>): <subject>

type: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
```

- subject 不超过 72 字符,不以句号结尾。
- body 解释 **why**,不解释 what(与 subject 空一行,可选)。
- 示例:`feat(tool-vision): add on-demand auto-start of llama-server`。

`commit-msg` 钩子会强制校验格式。

## 门禁检查

本地提交/推送前,`pre-commit` 会自动跑(分层见 `.pre-commit-config.yaml`):

| 阶段       | 内容                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| commit     | prettier + eslint(自动修复)、密钥扫描(gitleaks)、YAML/JSON 校验、主分支拦截 |
| commit-msg | Conventional Commits 格式校验                                               |
| pre-push   | `node --check` 语法检查 + tool-vision 冒烟测试 + `pnpm audit --prod`        |

手动等价命令:

```sh
just lint    # eslint --fix + prettier --write
just test    # 冒烟测试(无需真实模型/网络)
just audit   # pnpm audit --prod
just check   # lint + test + audit
```

> 密钥扫描:仓库装了 gitleaks,任何疑似密钥(token / sk-xxx)都会拦截提交。
> 凭证(如 `DEEPSEEK_API_KEY`)只允许出现在 `~/.dsh/.credentials.yaml` 或 `.env`
> (已被 gitignore),**绝不入代码、不入 git**。

## 新增插件

1. `mkdir plugins/<plugin-id>`(id 用 kebab-case)。
2. 需要浏览器 UI 的按「静态双半 npm 包」结构写:
   - `package.json` 声明 `dsh.bundle.patch` + `dsh.client`(参考 `ds-balance`);
   - `lib/index.js`(host 半,ESM,命名导出 `name` / `inject` / `apply`)+
     `lib/client.js`(client 半浏览器 bundle);
   - 自带 `cordis.patch.yml` 挂载层。
     纯 host 的按「纯 host 插件」写:`package.json` + `lib/index.js` +
     `cordis.yml` 挂载示例 + `tests/`(参考 `tool-vision`)。
3. 在插件目录写 `README.md`:用途、配置项、安装命令(路径用 `<repo-abs-path>`
   占位符,不要写本机绝对路径)。
4. 测试:纯 host 插件至少要有可离线跑的冒烟测试;静态双半插件至少要有 host 侧
   逻辑的校验脚本(参考 `scripts/verify-ds-balance.mjs`),并把命令加进根
   `package.json` 的 `test` / `justfile`。
5. 更新根 `README.md` 的「现有插件」表格与「目录约定」。
6. 本地自测:`just check` 全绿后提 PR。

## PR 检查清单

- [ ] `just check` 通过(lint + 冒烟测试 + audit)
- [ ] 提交信息符合 Conventional Commits
- [ ] 无密钥/凭证入库(`gitleaks` 通过)
- [ ] 文档路径用 `<repo-abs-path>` 占位符,无本机绝对路径
- [ ] 根 README 插件表格已同步
- [ ] 有对应的测试(新功能)或说明为什么不需要

## 其他

- 问题与讨论:开 Issue 或 PR,维护者会尽快回复。
- 行为准则:与人为善,评审意见对事不对人。
