#!/usr/bin/env python3
"""pre-commit hook: 拒绝在 main 上直接提交。

放行三种情况:
  - 非 main 分支(或 detached HEAD, 如 rebase 中途)
  - merge 提交(MERGE_HEAD 存在)
  - 仓库首个提交(尚无 HEAD)
"""

import subprocess
import sys


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)


def main() -> int:
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD")
    if branch.returncode != 0 or branch.stdout.strip() != "main":
        return 0
    if git("rev-parse", "--quiet", "--verify", "MERGE_HEAD").returncode == 0:
        return 0
    if git("rev-parse", "--quiet", "--verify", "HEAD").returncode != 0:
        return 0
    print(
        "禁止直接在 main 上提交。\n"
        "请用 worktree 开发: just wt <功能名>\n"
        "完成后回到主工作区合并: git merge --no-ff <分支>",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
