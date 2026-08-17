#!/usr/bin/env bash
# 把仓库推到 GitHub 后, 用 GitHub rulesets 开启 main 分支保护:
#   - 禁止删除 / 禁止 force-push
#   - 必须走 PR(单人项目: 0 个必需评审, 自己可合)
#
# 用法: scripts/enable-branch-protection.sh <owner>/<repo>
set -euo pipefail

repo="${1:?用法: $0 <owner>/<repo>}"

gh api --method POST "repos/${repo}/rulesets" --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ]
}
JSON

echo "已开启 ${repo} 的 main 分支保护(必须 PR)"
