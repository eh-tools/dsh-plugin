# 任务入口 —— `just --list` 查看全部
# 与 pre-commit 的检查保持一致: 本地手动跑用 just, 门禁用 hooks

default:
    @just --list

# ---- lint (含自动修复) ----
lint:
    node_modules/.bin/eslint --fix .
    node_modules/.bin/prettier --write .

# ---- 单元测试 ----
# 全部离线可跑: 不需要 DSH 进程, 也不需要浏览器。
# (browser-operator 的浏览器自检会真的拉起一个有头浏览器窗口, 已从门禁里摘掉 ——
#  手动跑法见 plugins/browser-operator/README.md)
test:
    node plugins/obsolete/tool-vision/tests/smoke.mjs
    node plugins/obsolete/paste-image/tests/save.test.mjs
    node scripts/verify-ds-balance.mjs
    node plugins/obsolete/file-git-explorer/tests/verify-client-bundles.mjs
    node scripts/verify-plugin-manifests.mjs
    node plugins/obsolete/file-git-explorer/tests/git.test.mjs
    node plugins/obsolete/file-git-explorer/tests/address.test.mjs
    node plugins/obsolete/file-git-explorer/tests/verify.mjs
    node plugins/db-console/tests/pg.test.mjs
    node plugins/db-console/tests/smoke.mjs
    node plugins/db-console/tests/editor-metrics.mjs
    node plugins/browser-operator/tests/policy.test.mjs
    node plugins/browser-operator/tests/harness.test.mjs

# ---- E2E (需真实 llama-server, 仅手动) ----
e2e:
    node plugins/obsolete/tool-vision/tests/e2e.mjs

# ---- 依赖安全审计 ----
# ⚠ **不带 `--prod`**: 高危常常藏在 dev / 传递依赖里。这里原来只扫生产依赖, 于是
#    2026-09 那个 js-yaml 高危(eslint → @eslint/eslintrc → js-yaml, dev only)在
#    `just check` 里一直是绿的, 而 Dependabot 报了警 —— 口径现在与它对齐(全量)。
audit:
    pnpm audit
    # 仓库没有 pnpm workspace: 根 audit 覆盖不到插件的依赖。本行只扫 plugins/browser-operator
    # (本仓库唯一因本计划新增运行时依赖的插件目录);db-console 等其它带 lockfile 的插件目录尚未覆盖
    pnpm --dir plugins/browser-operator audit

# ---- 全量检查(等同 pre-push 的内容) ----
check: lint test audit

# ---- dev: 按项目实际需求填充 ----
dev:
    @echo "在 justfile 里定义本项目的 dev 命令"

# ---- worktree 开发流 ----
# 新功能: just wt <名字> (建 worktree + 装依赖 + 软链 .env)
wt name:
    git worktree add .worktrees/{{ name }} -b {{ name }}
    pnpm --dir .worktrees/{{ name }} install
    @test -f .env && ln -sf ../../.env .worktrees/{{ name }}/.env && echo "已软链主工作区 .env" || echo "(无 .env 可链)"
    @echo "进入开发: cd .worktrees/{{ name }}"

# 列出全部 worktree
wt-list:
    @git worktree list

# 合并完成后清理 worktree 与分支
wt-rm name:
    git worktree remove .worktrees/{{ name }} --force
    git branch -D {{ name }}
