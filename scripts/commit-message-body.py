#!/usr/bin/env python3
"""commit-msg hook: 行为相关提交必须用「标签: 内容」行补齐上下文。

在 conventional-pre-commit 之后运行(它已保证 header 格式合法), 本脚本只做
body 内容完整性检查:

  fix      必填 现象 / 成因 / 复测   (bug 表现 -> 根因 -> 如何验证修复)
  perf     必填 基线 / 优化 / 度量   (慢在哪 -> 改了什么 -> 提升数据与度量方法)
  refactor 必填 动机 / 验证          (为什么重构 -> 凭什么保证行为不变)

feat 及 docs/style/test/chore/ci/build 不强制(小提交 subject 已能承载上下文);
工具链自动生成的提交(fixup!/squash!/amend!/revert!/Merge/Revert)直接放行。

用法: commit-message-body.py <message-file>  (commit-msg hook 约定传入 $1)
"""

import re
import sys
from pathlib import Path

# 标签顺序即建议书写顺序; 值为空列表的类型不强制
REQUIRED_TAGS: dict[str, list[str]] = {
    "fix": ["现象", "成因", "复测"],
    "perf": ["基线", "优化", "度量"],
    "refactor": ["动机", "验证"],
}

# git 工具链自动生成的提交, 内容由 git 填充, 跳过校验
SKIP_PREFIXES = (
    "Merge ",
    "Revert ",
    "fixup! ",
    "squash! ",
    "amend! ",
    "revert! ",
)

EXAMPLES: dict[str, str] = {
    "fix": """fix(scope): 一句话说明修了什么

现象: bug 的表现 / 触发条件(用户看到什么)
成因: 根因分析(不是症状描述)
复测: 如何验证已修复, 以及回归命令(如有)
""",
    "perf": """perf(scope): 一句话说明哪里变快了

基线: 现状多慢/多重, 最好带压测或 profile 证据
优化: 改了什么, 为什么这样更快
度量: 优化前后对比数据, 及度量方法
""",
    "refactor": """refactor(scope): 一句话说明重构内容

动机: 为什么此刻重构(当前实现的痛点)
验证: 靠什么确认行为不变(相关测试名 / 类型检查 / 契约测试)
""",
}

_ALL_TAGS = "|".join(tag for tags in REQUIRED_TAGS.values() for tag in tags)
# 标签行: 行首(允许缩进/markdown 列表前缀) + 标签 + 半角或全角冒号, 且冒号后同行有内容
# (全角冒号以 \\uff1a 形式书写, 源码不含字面全角字符, 避免 RUF001)
_TAG_RE = re.compile(r"^\s*(?:[-*]\s+)?(" + _ALL_TAGS + r")\s*(?:[:]|\uff1a)\s*\S")


def _header(message: str) -> str:
    return next((line.strip() for line in message.splitlines() if line.strip()), "")


def parse_type(message: str) -> str:
    """从 header 提取 type(兼容 scope 与 !), 非 conventional 格式返回空串。"""
    header = _header(message)
    match = re.match(r"^([A-Za-z]+)(?:\([^)]*\))?!?:", header)
    return match.group(1).lower() if match else ""


def should_skip(message: str) -> bool:
    return _header(message).startswith(SKIP_PREFIXES)


def _body_lines(message: str) -> list[str]:
    """header 之后的正文行(git 语义: body 与 subject 之间需有空行)。"""
    lines = message.splitlines()
    try:
        sep = lines.index("")
    except ValueError:
        return []
    return lines[sep + 1 :]


def missing_tags(message: str, type_: str) -> list[str]:
    """返回缺失的必填标签(空列表 = 通过)。"""
    required = REQUIRED_TAGS.get(type_, [])
    if not required:
        return []
    found: set[str] = set()
    for line in _body_lines(message):
        match = _TAG_RE.match(line)
        if match:
            found.add(match.group(1))
    return [tag for tag in required if tag not in found]


def check_message(message: str) -> list[str]:
    """完整校验入口(供测试调用): 返回缺失标签, 空列表即通过。"""
    if should_skip(message):
        return []
    return missing_tags(message, parse_type(message))


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else ".git/COMMIT_EDITMSG"
    message = Path(path).read_text(encoding="utf-8", errors="replace")
    type_ = parse_type(message)
    missing = check_message(message)
    if not missing:
        return 0
    print(
        f"commit message 被拒: {type_} 提交需在 body 中用标签行补齐上下文,"
        f" 当前缺失: {', '.join(missing)}\n"
        "(body 需与 subject 空一行; 每行格式: 标签: 内容, 内容写在标签同行)\n"
        f"\n参照格式:\n{EXAMPLES[type_]}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
