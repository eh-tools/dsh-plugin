# PERSONAL.md

个人偏好(使用者维护,模板之外的文件)。

## 开发流

- 偏好:**新分支** —— 在主工作区 `git switch -c <名字>`(或 `just branch <名字>`)开发,完成后提 PR。
- **不用 worktree**:不执行 `git worktree add`,不在主工作区之外另建检出。
  代价是主工作区同时只能进行一个任务;换来的是路径 / 依赖 / `.env` 只有一份。
- `main` 仍受保护:禁止直接向 `main` 提交(`no-commit-on-main` 钩子拦截),走分支 + PR。
