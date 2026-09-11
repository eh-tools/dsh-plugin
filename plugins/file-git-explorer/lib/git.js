/**
 * dsh-file-git-explorer — 纯函数层(可单测, 不依赖 ctx / 进程)
 *
 * 这里只放"给定输入字符串/条目数组就能算出结果"的解析与划分逻辑:
 *   - parseStatusV2:    解析 `git status --porcelain=v2 -z --branch` 输出
 *   - normalizeXY:      v2 的 `.` 占位符归一为 v1 的空格形态
 *   - statusBadge:      XY 状态码 → 单字母徽标
 *   - sortChanges:      变更列表排序(未跟踪沉底)
 *   - diffArgs:         按变更条目构造单文件 diff 的 git 参数
 *   - parseDiffHunks:   统一 diff → 官方 DiffBlock 的 diffs 形状(一个 hunk 一条)
 *   - resolveWithin:    相对路径 → 基目录内绝对路径(防目录穿越)
 *   - logArgs/parseLogOut:       提交列表
 *   - parseNumStatZ:            单提交文件级增删统计
 *   - parentsFromRevList:       父提交数(merge 判定)
 *
 * ======================== porcelain v2 实测事实 ========================
 * (Windows git 2.53.0; tests/git.test.mjs 以当时的真实输出为夹具)
 *
 * 命令: git status --porcelain=v2 -z --branch --untracked-files=all
 *   - 全 token 以 NUL 分隔, header 行也是独立 token。
 *   - header: `# branch.oid <hash>` 或 `(initial)`;
 *             `# branch.head <name>` 或 `(detached)`;
 *             `# branch.upstream <name>` 与 `# branch.ab +n -m` 只在有上游时出现。
 *
 * ⚠ 最大的坑(单测抓出, 改解析器前必读): **路径可能含空格**。
 *   三种记录都形如 `<固定字段...> <path>`, 且末尾的 path 自身可含空格
 *   (实测 `sub dir/nested file.txt` / `new name.txt`)。因此**绝不能**用
 *   `split(' ').pop()` 或"总字段数"取路径 —— 那样只会拿到最后一段
 *   (`file.txt`)。唯一正确做法是: 去掉 `1 `/`2 `/`u ` 两个字符的前缀后,
 *   **切掉固定数量的前导字段, 再把剩余部分用空格重新拼回**:
 *       1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>            → 7 个固定字段
 *       2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> → 8 个固定字段
 *       u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>  → 9 个固定字段
 *   (官方文档把记录类型也算作一个字段, 按文档字段数直接数会差一。)
 *
 *   - rename/copy (`2` 行): 新路径在行内, **旧路径是紧随其后的一个裸 token**
 *     (自身也含空格); 输出被截断时该 token 会孤悬, 解析器必须防御。
 *   - 未跟踪 `? <path>`; 被忽略 `! <path>`(本图标不展示, 解析时跳过)。
 *   - XY 未变更的一侧是 `.`(实测 `.M` / `A.` / `.D`), 本层归一为空格。
 */

import {
  resolve as pathResolve,
  relative as pathRelative,
  isAbsolute as pathIsAbsolute,
} from 'node:path';

/** `1` 行: 路径之前固定 7 个字段。 */
const ORDINARY_FIXED_FIELDS = 7;
/** `2` 行: 路径之前固定 8 个字段(多出的一个是 `<X><score>`)。 */
const RENAMED_FIXED_FIELDS = 8;
/** `u` 行: 路径之前固定 9 个字段。 */
const UNMERGED_FIXED_FIELDS = 9;

/**
 * 把以 `/` 分隔的相对路径解析到 base 之下, 返回绝对路径;
 * 若越过 base(穿越到外面)返回 null。
 */
export function resolveWithin(base, rel) {
  const abs = pathResolve(base, ...String(rel).split('/'));
  const rel2 = pathRelative(base, abs);
  if (rel2 === '') return abs; // 恰好等于 base
  if (rel2.startsWith('..') || pathIsAbsolute(rel2)) return null;
  return abs;
}

/** 与 localeCompare('zh-CN') 一致的名称比较, 供变更排序复用。 */
export function compareZh(a, b) {
  return String(a).localeCompare(String(b), 'zh-CN');
}

/**
 * v2 的 XY 归一为 v1 的空格形态: 未变更一侧的 `.` 换成空格。
 * 归一后 `xy[0] !== ' '` 表示已暂存, `xy[1] !== ' '` 表示工作区未暂存。
 */
export function normalizeXY(xy) {
  const s = typeof xy === 'string' ? xy : '';
  const x = s[0] === undefined || s[0] === '.' ? ' ' : s[0];
  const y = s[1] === undefined || s[1] === '.' ? ' ' : s[1];
  return x + y;
}

/** XY 状态码 → 单字母徽标(R > C > A > D > M > U)。 */
export function statusBadge(xy) {
  const x = xy[0];
  const y = xy[1];
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'C' || y === 'C') return 'C';
  if (x === 'A' || y === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'M' || y === 'M') return 'M';
  return 'U';
}

/**
 * 切出「前 fixed 个字段 + 路径」: 路径 = 剩余部分用空格拼回。
 * 字段不足(输出被截断)返回 null, 由调用方跳过该行。
 */
function splitFixedAndPath(rest, fixed) {
  const parts = rest.split(' ');
  if (parts.length < fixed + 1) return null;
  return { head: parts.slice(0, fixed), path: parts.slice(fixed).join(' ') };
}

/** 解析一条 header token(已去掉 `# `)，把结果写进 branch。 */
function applyHeader(branch, line) {
  if (line.startsWith('branch.oid ')) {
    const value = line.slice('branch.oid '.length).trim();
    if (value === '(initial)') branch.initial = true;
    else branch.oid = value;
    return;
  }
  if (line.startsWith('branch.head ')) {
    const value = line.slice('branch.head '.length).trim();
    if (value === '(detached)') branch.detached = true;
    else branch.head = value;
    return;
  }
  if (line.startsWith('branch.upstream ')) {
    branch.upstream = line.slice('branch.upstream '.length).trim();
    return;
  }
  if (line.startsWith('branch.ab ')) {
    const m = /\+(\d+)[ \t]+-(\d+)/.exec(line);
    if (m !== null) {
      branch.ahead = Number(m[1]);
      branch.behind = Number(m[2]);
    }
  }
}

/**
 * 解析 `git status --porcelain=v2 -z --branch --untracked-files=all` 输出。
 *
 * 不做排序 —— 这是忠实的反序列化层, 展示顺序由调用方(sortChanges)决定。
 *
 * @returns {{branch: {oid: string|null, head: string|null, upstream: string|null,
 *   ahead: number, behind: number, initial: boolean, detached: boolean},
 *   changes: Array<{xy: string, badge: string, path: string, origPath: string|null,
 *     kind: 'ordinary'|'renamed'|'unmerged'|'untracked', score?: string}>}}
 */
export function parseStatusV2(text) {
  const branch = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    initial: false,
    detached: false,
  };
  const changes = [];
  const tokens = String(text).split('\0');

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '') continue;

    if (token.startsWith('# ')) {
      applyHeader(branch, token.slice(2));
      continue;
    }

    const kind = token[0];

    if (kind === '1') {
      const parsed = splitFixedAndPath(token.slice(2), ORDINARY_FIXED_FIELDS);
      if (parsed === null) continue;
      const xy = normalizeXY(parsed.head[0]);
      changes.push({
        xy,
        badge: statusBadge(xy),
        path: parsed.path,
        origPath: null,
        kind: 'ordinary',
      });
      continue;
    }

    if (kind === '2') {
      const parsed = splitFixedAndPath(token.slice(2), RENAMED_FIXED_FIELDS);
      if (parsed === null) continue;
      // 旧路径是紧随的裸 token; 截断时缺失 → 留 null, 不当成下一条记录。
      const next = tokens[i + 1];
      let origPath = null;
      if (next !== undefined && next !== '') {
        origPath = next;
        i += 1;
      }
      const xy = normalizeXY(parsed.head[0]);
      changes.push({
        xy,
        badge: statusBadge(xy),
        path: parsed.path,
        origPath,
        kind: 'renamed',
        score: parsed.head[RENAMED_FIXED_FIELDS - 1],
      });
      continue;
    }

    if (kind === 'u') {
      const parsed = splitFixedAndPath(token.slice(2), UNMERGED_FIXED_FIELDS);
      if (parsed === null) continue;
      const xy = normalizeXY(parsed.head[0]);
      changes.push({
        xy,
        badge: statusBadge(xy),
        path: parsed.path,
        origPath: null,
        kind: 'unmerged',
      });
      continue;
    }

    if (kind === '?') {
      changes.push({
        xy: '??',
        badge: '?',
        path: token.slice(2),
        origPath: null,
        kind: 'untracked',
      });
      continue;
    }

    // '!' (被忽略) 与未知记录类型: 本图标不展示, 跳过。
  }

  return { branch, changes };
}

/** 变更列表排序: 未跟踪沉底, 其余按 zh-CN 名称比较。 */
export function sortChanges(changes) {
  return changes.slice().sort((a, b) => {
    const au = a.kind === 'untracked';
    const bu = b.kind === 'untracked';
    if (au !== bu) return au ? 1 : -1;
    return compareZh(a.path, b.path);
  });
}

/**
 * 按变更条目构造"单文件相对 HEAD 的 diff"git 参数。
 * rename/copy 需要同时给新、旧两个路径, 否则只给新路径时 git 会当 new file。
 * `from` 是条目不携带旧路径时的兜底来源。
 */
export function diffArgs(entry, from) {
  const args = ['-c', 'core.quotepath=false', 'diff', 'HEAD', '-M', '--'];
  const paths = [entry.path];
  const orig = entry.origPath ?? from;
  if (typeof orig === 'string' && orig !== '') paths.push(orig);
  return args.concat(paths);
}

// ---- 统一 diff → hunk(官方 DiffBlock 的 diffs 形状) ----
//
// ======================== 实测事实(真实 git 输出) ========================
//   · `\ No newline at end of file` 是**内容行之后的标记行**, 不是内容 —— 必须丢;
//   · 路径含空格 / 非 ASCII 时 `--- a/<路径>` 后面会补一个 **TAB** 作分隔
//     (`--- a/ren old.txt\t`), 所以要先在第一个 TAB 处截断再去引号;
//   · `core.quotepath=true` 时路径被 C 风格引号包住、非 ASCII 走**八进制字节**
//     转义(`"a/uni \344\270\255..."`)。本插件 host 一直传 `-c core.quotepath=false`,
//     但解析器不假设它永不出现 —— 且八进制是 UTF-8 **字节**, 必须按字节解码。
//   · 纯 mode 变化 / 二进制 / 100% rename 都没有 `@@`, 于是没有 hunk。

/** 一个 hunk 的 `@@ -o[,s] +n[,t] @@` 头(单行 hunk 省略 `,s`, 默认 1)。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 去掉 git 的 C 风格引号(仅当整段确实被 `"` 包住)。转义按 UTF-8 **字节**还原,
 * 否则 `\344\270\255`(即 `中`)会被解成三个拉丁字符。
 */
function unquoteGitPath(value) {
  const s = String(value);
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const body = s.slice(1, -1);
  const bytes = [];
  const pushText = (str) => {
    for (const byte of new TextEncoder().encode(str)) bytes.push(byte);
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      pushText(ch);
      continue;
    }
    i += 1;
    const esc = body[i];
    if (esc === undefined) {
      pushText('\\');
      break;
    }
    const oct = body.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(oct)) {
      bytes.push(parseInt(oct, 8) & 0xff);
      i += 2;
      continue;
    }
    const named = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
    if (Object.prototype.hasOwnProperty.call(named, esc)) bytes.push(named[esc]);
    else pushText(esc);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * `--- a/<路径>` / `+++ b/<路径>` 行 → 相对路径。
 * `/dev/null`(新增 / 删除的一侧)返回 null; 路径前没有 `a/` `b/` 前缀时原样返回。
 */
function diffSidePath(line) {
  const tab = line.indexOf('\t');
  const value = unquoteGitPath(tab === -1 ? line : line.slice(0, tab));
  if (value === '/dev/null') return null;
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

/** 若干内容行拼回 DiffBlock 期望的块: 行间 `\n`, 非空时带尾随 `\n`。 */
function joinDiffLines(lines) {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/**
 * 统一 diff → 官方 `DiffBlock` 的 `diffs` 形状: **一个 hunk 一条**
 * `{path, oldText, newText}`, 两侧都已是拆好的行块(上下文两边各一份)。
 *
 * 为什么放在 host 侧: DiffBlock **不做 diff 比对** —— 它把 `oldText` 整块当删除行、
 * `newText` 整块当新增行, 所以「统一 diff → 两侧行块」这一步必须有人做对; 落在纯函数层
 * 就同时拿到了单测(tests/git.test.mjs 用真实 git 输出当夹具)。
 *
 * hunk 的范围由 `@@` 头声明的增删数**界定**, 而不是靠"下一行像不像内容":
 *   - 于是一行内容本身以 `--` 开头的 `--- foo` 不会被误当成文件头;
 *   - 于是被 TEXT_CAP 截断的最后一个 hunk 也能在输入耗尽时按已收到的内容收尾。
 *
 * @param {string} text `git diff` / `git show --format=` 的输出
 * @returns {Array<{path: string, oldText: string, newText: string}>}
 */
export function parseDiffHunks(text) {
  const hunks = [];
  const lines = String(text).split('\n');
  let sideOld = null; // 当前文件的 a/ 侧(删除文件时为 null)
  let sideNew = null; // 当前文件的 b/ 侧(新增文件时为 null)
  let renameTo = null;
  let renameFrom = null;
  let current = null;

  const flush = () => {
    if (current === null) return;
    const path = sideNew ?? sideOld ?? renameTo ?? renameFrom ?? '';
    hunks.push({
      path,
      oldText: joinDiffLines(current.old),
      newText: joinDiffLines(current.new),
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      sideOld = null;
      sideNew = null;
      renameTo = null;
      renameFrom = null;
      continue;
    }

    if (current === null) {
      if (line.startsWith('--- ')) {
        sideOld = diffSidePath(line.slice(4));
        continue;
      }
      if (line.startsWith('+++ ')) {
        sideNew = diffSidePath(line.slice(4));
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('rename from ')) {
        renameFrom = line.slice('rename from '.length);
        continue;
      }
      const head = HUNK_HEADER.exec(line);
      if (head !== null) {
        current = {
          old: [],
          new: [],
          needOld: head[2] === undefined ? 1 : Number(head[2]),
          needNew: head[4] === undefined ? 1 : Number(head[4]),
        };
        if (current.needOld === 0 && current.needNew === 0) flush();
      }
      // 其余(index / mode / similarity / Binary files 等元信息)不进 hunk, 跳过。
      continue;
    }

    // 已在 hunk 内: 只认三种内容前缀 + 换行标记。
    if (line.startsWith('\\')) continue; // `\ No newline at end of file` 不是内容
    const marker = line[0];
    if (marker === '+') {
      current.new.push(line.slice(1));
      current.needNew -= 1;
    } else if (marker === '-') {
      current.old.push(line.slice(1));
      current.needOld -= 1;
    } else if (marker === ' ' || line === '') {
      // 空字符串只可能来自截断/收尾, 但上下文行本身也常是 " "(一个空格)。
      const content = marker === ' ' ? line.slice(1) : '';
      current.old.push(content);
      current.new.push(content);
      current.needOld -= 1;
      current.needNew -= 1;
    }
    if (current.needOld <= 0 && current.needNew <= 0) flush();
  }

  flush();
  return hunks;
}

// ---- 提交历史(commit history) ----

const LOG_FORMAT = '%H%x00%h%x00%an%x00%at%x00%s';

/**
 * ref 是否可安全作为 git argv 参数(无 shell, 主要防选项注入与区间语法):
 * 拒绝 `-` 开头、`..` 区间、空白/NUL、reflog `@{`。
 */
export function safeRef(ref) {
  if (typeof ref !== 'string') return false;
  const r = ref.trim();
  if (r === '' || r.length > 200) return false;
  if (r.startsWith('-') || r.includes('..') || r.includes('@{')) return false;
  if (/[\s\0]/.test(r)) return false;
  return true;
}

/** hash 是否为纯十六进制串(7~64 位), 供 git show 使用。 */
export function safeHash(hash) {
  return typeof hash === 'string' && /^[0-9a-fA-F]{7,64}$/.test(hash);
}

/**
 * git log argv: NUL 分隔字段(hash 全/短, 作者, unix 时间戳, subject)。
 * ref 为 null/非法时缺省 HEAD; skip 钳制 ≥0, limit 钳制 1..500。
 */
export function logArgs(ref, skip, limit) {
  const sk = Math.max(0, Math.floor(Number(skip) || 0));
  const lim = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)));
  const args = ['-c', 'core.quotepath=false', 'log', '--format=' + LOG_FORMAT];
  args.push('--skip=' + String(sk), '-n', String(lim));
  if (safeRef(ref)) args.push(ref.trim());
  return args;
}

/** 解析 logArgs 的输出; 字段不足或时间非数字的行跳过。 */
export function parseLogOut(text) {
  const commits = [];
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    const f = line.split('\0');
    if (f.length < 5 || f[0] === '') continue;
    const at = Number(f[3]);
    if (!Number.isFinite(at)) continue;
    commits.push({ hash: f[0], short: f[1], author: f[2], at: at, subject: f[4] });
  }
  return commits;
}

/**
 * 解析 `diff-tree --numstat -z` 输出(实测钉死):
 *   首个 token 是提交 hash; 普通条目 = "A\tD\t<path>\0";
 *   rename/copy 条目 = "A\tD\t\0<from>\0<to>\0"(计数 token 内路径位为空,
 *   紧跟旧、新两个裸路径 token)。二进制行 A/D 为 "-" → 归一为 null。
 */
export function parseNumStatZ(text) {
  const stats = [];
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : null);
  const tokens = String(text).split('\0');
  for (let i = 1; i < tokens.length;) {
    const t = tokens[i];
    if (t === undefined || t === '') {
      i++;
      continue;
    }
    const i1 = t.indexOf('\t');
    if (i1 < 0) {
      i++;
      continue;
    }
    const i2 = t.indexOf('\t', i1 + 1);
    if (i2 < 0) {
      i++;
      continue;
    }
    const adds = num(t.slice(0, i1));
    const dels = num(t.slice(i1 + 1, i2));
    const inlinePath = t.slice(i2 + 1);
    if (inlinePath !== '') {
      stats.push({ adds: adds, dels: dels, path: inlinePath });
      i++;
      continue;
    }
    // rename/copy: 计数 token 路径位为空, 后跟 旧路径、新路径 两个裸 token
    const from = tokens[i + 1];
    const to = tokens[i + 2];
    if (typeof to === 'string' && to !== '') {
      stats.push({ adds: adds, dels: dels, path: to, from: from });
      i += 3;
    } else {
      i++;
    }
  }
  return stats;
}

/** 由 `rev-list --parents -n1 <hash>` 输出计父提交数(首个 token 是自身)。 */
export function parentsFromRevList(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.length - 1;
}
