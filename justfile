# 任务入口 —— `just --list` 查看全部
# 与 pre-commit 的检查保持一致: 本地手动跑用 just, 门禁用 hooks

default:
    @just --list

# ---- lint (含自动修复) ----
lint:
    node_modules/.bin/eslint --fix .
    node_modules/.bin/prettier --write .

# ---- 单元测试 ----
test:
    node plugins/tool-vision/tests/smoke.mjs
    node plugins/paste-image/tests/save.test.mjs
    node scripts/verify-ds-balance.mjs
    node plugins/file-git-explorer/tests/git.test.mjs
    node plugins/file-git-explorer/tests/shell.test.mjs
    node plugins/file-git-explorer/tests/verify.mjs
    node plugins/db-console/tests/pg.test.mjs
    node plugins/db-console/tests/smoke.mjs

# ---- E2E (需真实 llama-server, 仅手动) ----
e2e:
    node plugins/tool-vision/tests/e2e.mjs

# ---- 依赖安全审计 ----
audit:
    pnpm audit --prod

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
