/**
 * dsh-file-git-explorer — host half(静态双半插件)
 *
 * 职责: 为浏览器端左右树面板提供文件系统 + git 数据。
 * 根目录 = 每个请求携带的 `root`(客户端跟随当前会话工作区下发, 切换工作区
 * 即切换树根), 缺省回退 DSH 进程 cwd(process.cwd())。
 *
 * 静态插件的 client→host 通信不走动态插件的 harness 私有 RPC, 而是注册一个
 * HTTP JSON 路由(与 dsh-ds-balance 的 /ds-balance/api 同款信任栅栏):
 *
 *   POST /fge/api/info    → { root? } → { cwd(root), repoRoot, currentBranch }
 *   POST /fge/api/tree    → { root?, path, mode, reveal } → 目录三区分组条目
 *   POST /fge/api/status  → { root?, repoRoot } → 分支列表 + 工作区变更列表
 *   POST /fge/api/diff    → { repoRoot, path, status, from } → 单文件 diff
 *   POST /fge/api/file    → { root?, path } → 文件内容预览(≤1MiB, NUL 探测)
 *   POST /fge/api/search  → { root?, query } → 按名搜索命中项(三区徽标, 截断上限)
 *   POST /fge/api/log     → { repoRoot, ref?, skip?, limit? } → 分页提交列表 + head
 *   POST /fge/api/show    → { repoRoot, hash, path? } → 单提交详情/merge 标记/单文件 diff
 *   POST /fge/api/save    → { root?, path, content, mtimeMs?, force? } → 保存文件
 *       读取时的 mtimeMs 回传做乐观并发校验: 磁盘已变(±1ms)且未 force → conflict;
 *       内容 ≤1MiB(与 file 预览对称, save 路由单独放宽 body 上限)。
 *   POST /fge/api/create  → { root?, path, kind: 'file'|'dir' } → 新建(父目录自动补建)
 *   POST /fge/api/rename  → { root?, path, newName } → 同目录重命名(目标存在即拒绝)
 *   POST /fge/api/remove  → { root?, path, recursive? } → 删除文件/符号链接/目录
 *       目录必须显式 recursive=true 才整体删除; 所有写类接口拒绝触及 .git 段。
 *   POST /fge/api/shellStart  → { root?, command } → 该工作区启动后台命令(挂 ctx.jobs, kind 'shell')
 *   POST /fge/api/shellState  → { root? } → 该工作区槽内任务快照(GUI 刷新恢复用)
 *   POST /fge/api/shellOutput → { root?, outFrom?, errFrom? } → 尾部输出增量(绝对字符位切片)
 *   POST /fge/api/shellStop   → { root? } → 终止该工作区当前任务(TERM→宽限→KILL 整树)
 *
 * git 一律经 subprocess 服务执行(argv 数组, 无 shell), 路径全部做防穿越校验:
 * 文件树/file 只能落在 root 之下, diff/status 的仓库根必须是绝对路径。
 * shell 行是唯一经用户 shell 解释命令串的入口(解释器解析见 lib/shell.js),
 * 同样只服务信任栅栏之后的本机请求; 启动即注册为无主后台任务(完成不通知模型)。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import {
  isDotName,
  resolveWithin,
  parseStatusZ,
  statusBadge,
  partitionChildren,
  diffArgs,
  compareZh,
  searchZone,
  dirsFromPaths,
  matchEntries,
  safeRef,
  safeHash,
  logArgs,
  parseLogOut,
  parseNumStatZ,
  parentsFromRevList,
  validSegmentName,
  splitEditRel,
} from './git.js';
import {
  resolveShellArgv,
  appendTail,
  sliceSince,
  validShellCommand,
  SHELL_STREAM_CAP_CHARS,
} from './shell.js';

export const name = 'dsh-file-git-explorer';

/** webServer 是唯一硬依赖; subprocess 走可选访问。 */
export const inject = ['webServer'];

const FILE_CAP = 1024 * 1024; // 单文件内容预览上限 1 MiB
const BODY_CAP = 256 * 1024; // 请求体上限
// save 路由单独放宽: 内容上限同 FILE_CAP(1MiB), JSON 转义最坏 ~2 倍膨胀 + 余量
const SAVE_BODY_CAP = 3 * 1024 * 1024;
const ROUTE_PREFIX = '/fge/api';
const SEARCH_SCAN_CAP = 20000; // 搜索扫描条目上限(超出即截断, 忽略区可能巨大)
const SEARCH_RETURN_CAP = 300; // 搜索返回条目上限(排序后截断)

export function apply(ctx) {
  const CWD = process.cwd();

  // ---- 通用工具 ----

  /**
   * 请求根目录: 每个请求可携带 `root`(绝对路径), 由客户端跟随当前会话
   * 工作区下发; 缺省回退 DSH 进程 cwd。非法(非绝对路径)返回 null。
   */
  function baseOf(body) {
    const r = typeof body.root === 'string' ? body.root : '';
    if (r === '') return CWD;
    if (!path.isAbsolute(r)) return null;
    return path.normalize(r);
  }

  /** 从 start 向上找含 .git 的目录(仓库根); 找不到返回 null。 */
  async function findRepoRoot(start) {
    let dir = start;
    for (;;) {
      try {
        const st = await fsp.stat(path.join(dir, '.git'));
        if (st.isDirectory() || st.isFile()) return dir;
      } catch {
        // 继续向上
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /**
   * 某根目录的仓库根。
   *
   * 刻意不做按 root 缓存: 仓库根会随 .git 的新建/删除/移动而变化, 任何固定键缓存都可能在
   * 首次查询(工作区尚未成为仓库)后永久失效。历史 bug 正是如此 —— s3 工作区首次打开时
   * 还没有 .git, 向上命中了父仓库并在缓存里记下 `s3 → 父仓库`; 之后 s3 建了自己的 .git,
   * 缓存却仍返回父仓库, 右侧 git 树因此渲染成了父仓库的变更。
   *
   * 不能用"命中时重验已缓存 root 的 .git 是否还在"来救: findRepoRoot 返回的是从 base 向上
   * 最近的 .git, 要验证其仍是最新最近值, 唯一正确做法是把向上遍历重跑一遍 —— 一旦重跑,
   * 缓存就不再省任何事。所以直接每次实时算。
   *
   * findRepoRoot 向上遍历只做 O(目录深度) 次 stat(microseconds 级, 远小于一次 readdir 或
   * git 子进程), 每次重算成本可忽略, 却能彻底消除这类失效问题。
   */
  async function repoRootFor(base) {
    return findRepoRoot(base);
  }

  /** 校验 body.repoRoot: 缺失 → no-repo, 非绝对路径 → invalid-root; 否则给绝对路径。 */
  function absRepoRootOf(body) {
    const root = typeof body.repoRoot === 'string' ? body.repoRoot : '';
    if (root === '') return { error: 'no-repo' };
    if (!path.isAbsolute(root)) return { error: 'invalid-root' };
    return { dir: path.resolve(root) };
  }

  /** 某目录下的 HEAD 全 hash(空仓库 / 失败返回 null)。 */
  async function headOf(cwd) {
    const r = await runGit(['rev-parse', 'HEAD'], { cwd });
    return r.exitCode === 0 ? r.stdout.trim() || null : null;
  }

  /** 执行 git。input 存在时走 stdin pipe; 非零退出不抛错, 由调用方判断。 */
  async function runGit(args, opts = {}) {
    const subprocess = ctx.get('subprocess');
    if (subprocess === undefined) throw new Error('subprocess service unavailable');
    const handle = subprocess.spawn({
      argv: ['git', ...args],
      cwd: opts.cwd ?? CWD,
      stdio: {
        stdin: opts.input !== undefined ? 'pipe' : 'ignore',
        stdout: { maxBytes: opts.maxBytes ?? 16 * 1024 * 1024 },
        stderr: { maxBytes: 2 * 1024 * 1024 },
      },
      graceMs: 15000,
    });
    if (opts.input !== undefined && handle.stdin !== undefined) {
      try {
        handle.stdin.write(opts.input);
        handle.stdin.end();
      } catch {
        // 进程可能已退出, EPIPE 忽略
      }
    }
    const outcome = await handle.done;
    const read = (reader) => (reader !== undefined ? reader.readFrom(0).text : '');
    return {
      exitCode: outcome.exitCode,
      stdout: read(handle.collected.stdout),
      stderr: read(handle.collected.stderr),
    };
  }

  /** 批量 check-ignore: 输入相对 base 的路径数组, 返回被忽略的路径集合。 */
  async function checkIgnore(relPaths, base) {
    if (relPaths.length === 0) return new Set();
    const r = await runGit(['check-ignore', '--stdin', '-z'], {
      cwd: base,
      input: relPaths.join('\0') + '\0',
    });
    const set = new Set();
    if (r.exitCode === 0 || r.exitCode === 1) {
      for (const token of r.stdout.split('\0')) {
        if (token !== '') set.add(token);
      }
    }
    return set;
  }

  const joinRel = (rel, name) => (rel === '' ? name : rel + '/' + name);

  /** 读文件预览(前 1MiB + NUL 二进制探测); >1MiB 只提示、不读取。 */
  async function readFilePreview(abs) {
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return { ok: false, error: 'not-found' };
    }
    if (!st.isFile()) return { ok: false, error: 'not-file' };
    const size = st.size;
    const truncated = size > FILE_CAP;
    if (truncated)
      return { ok: true, text: '', binary: false, truncated: true, size, mtimeMs: st.mtimeMs };
    const sizeToRead = size;
    const buf = Buffer.alloc(sizeToRead);
    let bytesRead = 0;
    try {
      const fd = await fsp.open(abs, 'r');
      try {
        const result = await fd.read(buf, 0, sizeToRead, 0);
        bytesRead = result.bytesRead;
      } finally {
        await fd.close();
      }
    } catch {
      return { ok: false, error: 'read-failed' };
    }
    const data = bytesRead < sizeToRead ? buf.subarray(0, bytesRead) : buf;
    const probe = data.subarray(0, 8192);
    const binary = probe.includes(0); // NUL 字节 → 视为二进制
    return {
      ok: true,
      text: binary ? '' : data.toString('utf8'),
      binary,
      truncated,
      size,
      mtimeMs: st.mtimeMs, // 保存接口做乐观并发校验用
    };
  }

  // ---- API handlers ----

  /** info: 返回某根目录(缺省 cwd)的仓库根、当前分支与 HEAD。 */
  async function handleInfo(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const repoRoot = await repoRootFor(base);
    let branch = null;
    let head = null;
    if (repoRoot !== null) {
      const r = await runGit(['branch', '--show-current'], { cwd: repoRoot });
      if (r.exitCode === 0) branch = r.stdout.trim() || null;
      head = await headOf(repoRoot);
    }
    return { ok: true, cwd: base, repoRoot, branch, head };
  }

  /**
   * 忽略区桥接标注: 标出"自身未忽略但子树含忽略项"的普通子目录(subIgnored)。
   * 不做此标注时, 深层忽略路径(src/__pycache__ 形态)在忽略区内不可达 ——
   * 各级父目录都未被忽略, 忽略区逐级展开永远走不到它, 左树任何分区都不显示。
   * 用一次 `ls-files -o -i --exclude-standard --directory` 批量探测
   * (输出把整体被忽略的子目录折叠成单条, 开销与直接子项数同阶);
   * 失败只损失桥接, 不影响文件树展示。
   */
  async function markIgnoredBridges(entries, rel, base) {
    const candidates = entries.filter((e) => e.type === 'dir' && !e.dot && !e.ignored);
    if (candidates.length === 0) return;
    const byRel = new Map();
    for (const e of candidates) byRel.set(joinRel(rel, e.name), e);
    let r;
    try {
      r = await runGit(
        [
          'ls-files',
          '-o',
          '-i',
          '--exclude-standard',
          '--directory',
          '-z',
          '--',
          ...Array.from(byRel.keys()).map((p) => ':(literal)' + p),
        ],
        { cwd: base },
      );
    } catch {
      return; // git 不可用等: 无桥接, 与 check-ignore 失败同口径
    }
    if (r.exitCode !== 0) return;
    for (const token of r.stdout.split('\0')) {
      if (token === '') continue;
      for (const [p, e] of byRel) {
        if (token === p || token.startsWith(p + '/')) e.subIgnored = true;
      }
    }
  }

  /** 目录条目(三区分组)。path = root 相对路径, '' 表示根本身。 */
  async function handleTree(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const rel = typeof body.path === 'string' ? body.path : '';
    const mode =
      body.mode === 'hidden' ? 'hidden' : body.mode === 'ignored' ? 'ignored' : 'visible';
    const reveal = body.reveal === true;
    const abs = resolveWithin(base, rel);
    if (abs === null) return { ok: false, error: 'outside-root' };
    let entries;
    try {
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) return { ok: false, error: 'not-directory' };
      const dirents = await fsp.readdir(abs, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.name !== '.git')
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
          dot: isDotName(d.name),
          ignored: false,
        }));
    } catch {
      return { ok: false, error: 'readdir-failed' };
    }
    // 忽略判定: 仅当根位于 git 仓库内才需要。
    const repoRoot = await repoRootFor(base);
    if (repoRoot !== null) {
      try {
        const relPaths = entries.map((e) => joinRel(rel, e.name));
        const ignoredSet = await checkIgnore(relPaths, base);
        for (const e of entries) {
          if (ignoredSet.has(joinRel(rel, e.name))) e.ignored = true;
        }
      } catch {
        // check-ignore 失败不影响文件树展示(忽略组为空)。
      }
      // 桥接标注只在忽略区非 reveal 列表需要(reveal 时本就全量展示)。
      if (mode === 'ignored' && !reveal) {
        await markIgnoredBridges(entries, rel, base);
      }
    }
    const groups = partitionChildren(entries, mode, reveal);
    const wire = groups.list.map((e) => ({
      name: e.name,
      rel: joinRel(rel, e.name),
      type: e.type,
      dot: e.dot,
      ignored: e.ignored,
      subIgnored: e.subIgnored === true,
    }));
    return { ok: true, path: rel, mode, entries: wire };
  }

  /** git 状态: 分支列表 + 变更列表(相对 HEAD, 含未跟踪)。 */
  async function handleStatus(body) {
    const rr = absRepoRootOf(body);
    if (rr.error) return { ok: false, error: rr.error };
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const absRoot = rr.dir;
    const r = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: absRoot,
    });
    if (r.exitCode !== 0) {
      return { ok: false, error: 'git-status-failed', stderr: r.stderr.slice(0, 500) };
    }
    const toPosix = (p) => p.split(path.sep).join('/');
    const changes = parseStatusZ(r.stdout)
      .map((e) => {
        // cwdRel: 相对根(base)的路径, 与左树 rel 同基准, 供联动匹配;
        // path 仍为仓库根相对(供 diff 使用)。根恰为仓库根时两者相同。
        const abs = path.join(absRoot, e.path);
        return {
          path: e.path,
          cwdRel: toPosix(path.relative(base, abs)),
          from: e.from,
          xy: e.xy,
          status: statusBadge(e.xy),
        };
      })
      .sort((a, b) => compareZh(a.path, b.path));
    const branches = [];
    const rb = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], {
      cwd: absRoot,
    });
    if (rb.exitCode === 0) {
      for (const line of rb.stdout.split('\n')) {
        const ref = line.trim();
        if (ref === '') continue;
        // refs/remotes/origin/HEAD 是符号引用(指向默认分支), 对用户是噪音。
        if (ref.endsWith('/HEAD')) continue;
        branches.push({
          ref,
          name: ref.startsWith('refs/remotes/')
            ? ref.slice('refs/remotes/'.length)
            : ref.slice('refs/heads/'.length),
          remote: ref.startsWith('refs/remotes/'),
        });
      }
    }
    const cur = await runGit(['branch', '--show-current'], { cwd: absRoot });
    const current = cur.exitCode === 0 ? cur.stdout.trim() : null;
    const head = await headOf(absRoot);
    return { ok: true, current, head, branches, changes };
  }

  /**
   * 提交历史: 查看分支(缺省 HEAD)的分页 log。
   * ref 显式给出但不合法时拒绝(invalid-ref), 缺省时回退 HEAD。
   */
  async function handleLog(body) {
    const root = typeof body.repoRoot === 'string' ? body.repoRoot : '';
    if (root === '') return { ok: false, error: 'no-repo' };
    if (!path.isAbsolute(root)) return { ok: false, error: 'invalid-root' };
    const absRoot = path.resolve(root);
    let ref = null;
    if (body.ref !== undefined && body.ref !== null) {
      if (typeof body.ref !== 'string' || !safeRef(body.ref)) {
        return { ok: false, error: 'invalid-ref' };
      }
      ref = body.ref.trim();
    }
    const r = await runGit(logArgs(ref, body.skip, body.limit), { cwd: absRoot });
    if (r.exitCode !== 0) {
      return { ok: false, error: 'git-log-failed', stderr: r.stderr.slice(0, 300) };
    }
    const rh = await runGit(['rev-parse', 'HEAD'], { cwd: absRoot });
    const head = rh.exitCode === 0 ? rh.stdout.trim() || null : null;
    return { ok: true, ref, head, commits: parseLogOut(r.stdout) };
  }

  /**
   * 单提交详情: message + 按文件 ±行数(diff-tree --root --numstat);
   * merge 提交(combined diff 无阅读价值)只返回 message; 带 path 时返回该文件 diff。
   */
  async function handleShow(body) {
    const root = typeof body.repoRoot === 'string' ? body.repoRoot : '';
    if (root === '') return { ok: false, error: 'no-repo' };
    if (!path.isAbsolute(root)) return { ok: false, error: 'invalid-root' };
    const absRoot = path.resolve(root);
    const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
    if (!safeHash(hash)) return { ok: false, error: 'invalid-hash' };
    const rp = await runGit(['rev-list', '--parents', '-n', '1', hash], { cwd: absRoot });
    if (rp.exitCode !== 0) {
      return { ok: false, error: 'git-show-failed', stderr: rp.stderr.slice(0, 300) };
    }
    const parentCount = parentsFromRevList(rp.stdout);
    if (parentCount === null) return { ok: false, error: 'git-show-failed' };
    const rm = await runGit(['-c', 'core.quotepath=false', 'show', '-s', '--format=%B', hash], {
      cwd: absRoot,
    });
    const message = rm.exitCode === 0 ? rm.stdout : '';
    const rel = typeof body.path === 'string' ? body.path : '';
    if (parentCount > 1) return { ok: true, kind: 'merge', message };
    if (rel !== '') {
      const abs = resolveWithin(absRoot, rel);
      if (abs === null) return { ok: false, error: 'outside-repo' };
      const rd = await runGit(
        ['-c', 'core.quotepath=false', 'show', '--format=', hash, '--', rel],
        { cwd: absRoot },
      );
      if (rd.exitCode !== 0) return { ok: false, error: 'git-show-failed' };
      return { ok: true, kind: 'diff', text: rd.stdout };
    }
    const rs = await runGit(
      ['-c', 'core.quotepath=false', 'diff-tree', '--root', '-r', '--numstat', '-M', '-z', hash],
      { cwd: absRoot },
    );
    if (rs.exitCode !== 0) return { ok: false, error: 'git-show-failed' };
    return { ok: true, kind: 'commit', message, files: parseNumStatZ(rs.stdout) };
  }

  /** 单文件 diff(相对 HEAD); 未跟踪/空 diff 回退为内容预览。 */
  async function handleDiff(body) {
    const root = typeof body.repoRoot === 'string' ? body.repoRoot : '';
    const rel = typeof body.path === 'string' ? body.path : '';
    const badge = typeof body.status === 'string' ? body.status : 'M';
    const from = typeof body.from === 'string' ? body.from : undefined;
    if (root === '') return { ok: false, error: 'no-repo' };
    if (!path.isAbsolute(root)) return { ok: false, error: 'invalid-root' };
    const absRoot = path.resolve(root);
    const abs = resolveWithin(absRoot, rel);
    if (abs === null) return { ok: false, error: 'outside-repo' };
    const preview = async () => {
      const p = await readFilePreview(abs);
      if (!p.ok) return p;
      return {
        ok: true,
        kind: 'untracked',
        text: p.text,
        binary: p.binary,
        truncated: p.truncated,
        size: p.size,
      };
    };
    if (badge === 'U') return preview();
    const args = diffArgs({ path: rel, from }, badge);
    const r = await runGit(args, { cwd: absRoot });
    if (r.exitCode === 0 && r.stdout.length > 0) {
      return { ok: true, kind: 'diff', text: r.stdout };
    }
    // 空 diff(未跟踪 / 刚还原 / HEAD 不存在)一律回退为内容预览。
    return preview();
  }

  async function handleFile(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const rel = typeof body.path === 'string' ? body.path : '';
    const abs = resolveWithin(base, rel);
    if (abs === null) return { ok: false, error: 'outside-root' };
    const p = await readFilePreview(abs);
    return p;
  }

  // ---- 写类接口(save/create/rename/remove)共用校验 ----

  /**
   * 编辑类请求的目标定位: root 合法 + rel 逐段通过名称校验(拒绝 '..'/' .git'/空段等,
   * 防穿越由 resolveWithin 兜底), 返回 {base, abs}; 非法各返错误码。
   */
  function editTargetOf(body) {
    const base = baseOf(body);
    if (base === null) return { error: 'invalid-root' };
    const segs = splitEditRel(typeof body.path === 'string' ? body.path : '');
    if (segs === null) return { error: 'invalid-path' };
    const abs = resolveWithin(base, segs.join('/'));
    if (abs === null || abs === base) return { error: 'invalid-path' }; // 根本身不可写/删
    return { base, abs };
  }

  /** lstat 便捷封装(不跟符号链接); 失败返回 null。 */
  async function lstatOrNull(abs) {
    try {
      return await fsp.lstat(abs);
    } catch {
      return null;
    }
  }

  /** 保存文件。mtimeMs 为读取时版本; 磁盘已变且未 force → conflict 并带磁盘现状。 */
  async function handleSave(body) {
    const t = editTargetOf(body);
    if (t.error) return { ok: false, error: t.error };
    if (typeof body.content !== 'string') return { ok: false, error: 'invalid-content' };
    if (Buffer.byteLength(body.content, 'utf8') > FILE_CAP) {
      return { ok: false, error: 'too-large', limit: FILE_CAP };
    }
    const st = await lstatOrNull(t.abs);
    if (st && !st.isFile()) return { ok: false, error: 'not-file' };
    // 乐观并发: 仅当调用方携带 mtimeMs 才校验; ±1ms 容差(FAT 类文件系统秒级精度)
    if (
      st &&
      typeof body.mtimeMs === 'number' &&
      body.force !== true &&
      Math.abs(st.mtimeMs - body.mtimeMs) > 1
    ) {
      return { ok: false, error: 'conflict', mtimeMs: st.mtimeMs, size: st.size };
    }
    try {
      await fsp.writeFile(t.abs, body.content, 'utf8');
    } catch (err) {
      return {
        ok: false,
        error: 'write-failed',
        detail: String((err && err.code) || err || 'write failed').slice(0, 120),
      };
    }
    const fresh = await fsp.stat(t.abs);
    return { ok: true, size: fresh.size, mtimeMs: fresh.mtimeMs };
  }

  /** 新建文件/目录。父目录缺失自动补建(mkdir -p); 目标已存在 → exists。 */
  async function handleCreate(body) {
    const t = editTargetOf(body);
    if (t.error) return { ok: false, error: t.error };
    const kind = body.kind === 'dir' ? 'dir' : 'file';
    if ((await lstatOrNull(t.abs)) !== null) return { ok: false, error: 'exists' };
    try {
      if (kind === 'dir') {
        await fsp.mkdir(t.abs, { recursive: true });
      } else {
        await fsp.mkdir(path.dirname(t.abs), { recursive: true });
        await fsp.writeFile(t.abs, '', { flag: 'wx', encoding: 'utf8' }); // 存在即抛 EEXIST
      }
    } catch (err) {
      if (err && err.code === 'EEXIST') return { ok: false, error: 'exists' };
      return {
        ok: false,
        error: 'create-failed',
        detail: String((err && err.code) || err || 'create failed').slice(0, 120),
      };
    }
    const st = await fsp.stat(t.abs).catch(() => null);
    if (st === null) return { ok: false, error: 'create-failed' };
    if (kind === 'dir' && !st.isDirectory()) return { ok: false, error: 'exists' };
    return { ok: true, kind, size: kind === 'file' ? 0 : undefined, mtimeMs: st.mtimeMs };
  }

  /** 同目录重命名。newName 只允许单个合法段; 目标已存在 → exists。 */
  async function handleRename(body) {
    const t = editTargetOf(body);
    if (t.error) return { ok: false, error: t.error };
    if (!validSegmentName(typeof body.newName === 'string' ? body.newName : '')) {
      return { ok: false, error: 'invalid-name' };
    }
    const src = await lstatOrNull(t.abs);
    if (src === null) return { ok: false, error: 'not-found' };
    const dst = path.join(path.dirname(t.abs), body.newName);
    if ((await lstatOrNull(dst)) !== null) return { ok: false, error: 'exists' };
    try {
      await fsp.rename(t.abs, dst);
    } catch (err) {
      return {
        ok: false,
        error: 'rename-failed',
        detail: String((err && err.code) || err || 'rename failed').slice(0, 120),
      };
    }
    return { ok: true };
  }

  /**
   * 删除。文件/符号链接直接 unlink; 目录必须显式 recursive=true(rm -rf 语义),
   * 否则尝试 rmdir 仅接受空目录(non-empty 报错)。根目录不可删(editTargetOf 已挡)。
   */
  async function handleRemove(body) {
    const t = editTargetOf(body);
    if (t.error) return { ok: false, error: t.error };
    const st = await lstatOrNull(t.abs);
    if (st === null) return { ok: false, error: 'not-found' };
    try {
      if (st.isFile() || st.isSymbolicLink()) {
        await fsp.unlink(t.abs);
      } else if (st.isDirectory()) {
        if (body.recursive === true) {
          await fsp.rm(t.abs, { recursive: true, force: false });
        } else {
          await fsp.rmdir(t.abs); // ENOTEMPTY → not-empty
        }
      } else {
        return { ok: false, error: 'unsupported-type' };
      }
    } catch (err) {
      if (err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')) {
        return { ok: false, error: 'not-empty' };
      }
      return {
        ok: false,
        error: 'remove-failed',
        detail: String((err && err.code) || err || 'remove failed').slice(0, 120),
      };
    }
    return { ok: true };
  }

  /**
   * 文件搜索(按名/相对路径, 大小写不敏感子串): 三区覆盖 + 截断上限。
   * git 仓库: `ls-files -c -o --exclude-standard`(可见+隐藏)与
   * `ls-files -o -i --exclude-standard`(忽略)各扫一遍; 目录命中项由文件路径
   * 派生(dirsFromPaths)。非 git 目录回退 fs 递归扫描(不跟符号链接, 无忽略区)。
   */
  async function handleSearch(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const query = typeof body.query === 'string' ? body.query : '';
    if (query.trim() === '') return { ok: true, matches: [], truncated: false };
    const repoRoot = await repoRootFor(base);
    /** 收集器: 只收文件(目录统一由 dirsFromPaths 派生), rel 为 base 相对 posix。 */
    const plainFiles = [];
    const ignoredFiles = [];
    let truncated = false;
    let scanCount = 0;
    const bump = () => {
      scanCount++;
      if (scanCount > SEARCH_SCAN_CAP) {
        truncated = true;
        return false;
      }
      return true;
    };

    if (repoRoot !== null) {
      // repo 相对路径 → base 相对路径; 越出 base(root 之外)的条目丢弃。
      const toBaseRel = (repoRel) => {
        const abs = path.join(repoRoot, repoRel);
        const rel = path.relative(base, abs);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return rel.split(path.sep).join('/');
      };
      const lsFiles = async (args, sink) => {
        const r = await runGit(args, { cwd: repoRoot });
        if (r.exitCode !== 0) return false;
        for (const token of r.stdout.split('\0')) {
          if (token === '') continue;
          if (!bump()) break;
          const rel = toBaseRel(token);
          if (rel !== null) sink.push(rel);
        }
        return true;
      };
      const okPlain = await lsFiles(
        ['ls-files', '-c', '-o', '--exclude-standard', '-z'],
        plainFiles,
      );
      if (!okPlain) return { ok: false, error: 'git-ls-failed' };
      // 忽略清单失败不致命(忽略区为空), 与树面板的容错口径一致。
      await lsFiles(['ls-files', '-o', '-i', '--exclude-standard', '-z'], ignoredFiles).catch(
        () => {},
      );
    } else {
      const stack = [''];
      while (stack.length > 0 && !truncated) {
        const relDir = stack.pop();
        let dirents;
        try {
          dirents = await fsp.readdir(path.join(base, relDir), { withFileTypes: true });
        } catch {
          continue; // 无权限/已消失的分支直接跳过
        }
        for (const d of dirents) {
          if (d.name === '.git') continue;
          if (!bump()) break;
          if (d.isDirectory()) stack.push(relDir === '' ? d.name : relDir + '/' + d.name);
          else plainFiles.push(relDir === '' ? d.name : relDir + '/' + d.name);
        }
      }
    }

    const entries = [];
    const addGroup = (rels, ignored) => {
      const seen = new Set();
      for (const rel of rels) {
        if (seen.has(rel)) continue; // -c/-o 理论不相交, 防御去重
        seen.add(rel);
        entries.push({ rel, type: 'file', zone: searchZone(rel, ignored) });
      }
      for (const rel of dirsFromPaths(rels)) {
        if (!seen.has(rel)) entries.push({ rel, type: 'dir', zone: searchZone(rel, ignored) });
      }
    };
    addGroup(plainFiles, false);
    addGroup(ignoredFiles, true);

    const ranked = matchEntries(entries, query);
    const matches = ranked.slice(0, SEARCH_RETURN_CAP).map((e) => ({
      rel: e.rel,
      type: e.type,
      zone: e.zone,
      nameHit: e.nameHit,
    }));
    if (ranked.length > matches.length) truncated = true;
    return { ok: true, matches, truncated };
  }

  // ---- shell 行(shell bar): 单槽后台命令执行 ----

  /**
   * 可执行探测: 绝对路径直接 access X_OK; 裸名扫 PATH(Windows 附 PATHEXT)。
   * 仅用于解释器解析($SHELL / pwsh), 不参与任何路径穿越校验。
   * 有意留在 host 半(依赖 fs/process.env, 注入反而绕); lib/shell.js 只收
   * 纯字符串/窗口数学, resolveShellArgv 以 canExec 参数接收本探测。
   */
  function canExec(nameOrPath) {
    try {
      if (path.isAbsolute(nameOrPath)) {
        fs.accessSync(nameOrPath, fs.constants.X_OK);
        return true;
      }
      const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
      const exts =
        process.platform === 'win32'
          ? (process.env.PATHEXT ?? '.EXE').split(';').filter(Boolean)
          : [''];
      for (const dir of dirs) {
        for (const ext of exts) {
          try {
            fs.accessSync(path.join(dir, nameOrPath + ext), fs.constants.X_OK);
            return true;
          } catch {
            // 继续找下一个候选
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  let shellArgvCache = null;
  /** 用户默认 shell 的 argv 前缀, 按进程缓存一次。 */
  function shellArgv() {
    if (shellArgvCache === null) {
      shellArgvCache = resolveShellArgv(process.platform, process.env.SHELL, canExec);
    }
    return shellArgvCache;
  }

  let jobControllerAttached = false;
  /** 防御性自挂 job controller: 某些组合没在根上加载 tool-jobs 时无主 start 会抛。 */
  function ensureJobController(jobs) {
    if (jobControllerAttached || typeof jobs.attachController !== 'function') return;
    try {
      jobs.attachController('file-git-explorer');
    } catch {
      // 已挂过 / 不可挂: 忽略, start 时再按真实错误上报
    }
    jobControllerAttached = true;
  }

  /**
   * 单槽记账: 每个工作区(cwd)各自至多一条 running/stopping 任务(宿主侧记账,
   * 跨 GUI 刷新/多开成立; 不同工作区互不可见、可并行)。任务终结后记录保留
   * (shellState/shellOutput 仍可查), 直到该工作区下一次 start 覆盖;
   * 终态槽总量超上限时按 FIFO 淘汰最旧的终态记录(运行中永不淘汰)。
   */
  const shellSlots = new Map(); // root(归一绝对路径) → slot
  const SHELL_SLOT_CAP = 50;

  /** 按请求 root 取槽; root 非法返回 error, 无记录返回 slot:null。 */
  function slotFor(body) {
    const base = baseOf(body);
    if (base === null) return { error: 'invalid-root' };
    return { base, slot: shellSlots.get(base) ?? null };
  }

  /** 终态槽超上限时按插入序淘汰最旧的终态记录(运行中的槽不动)。 */
  function evictTerminalSlots() {
    for (const [root, slot] of shellSlots) {
      if (shellSlots.size < SHELL_SLOT_CAP) break;
      if (slot.status !== 'running' && slot.status !== 'stopping') shellSlots.delete(root);
    }
  }

  function shellPublic(slot) {
    if (!slot) return null;
    return {
      id: slot.jobId,
      label: slot.label,
      status: slot.status,
      exitCode: slot.exitCode,
      signal: slot.signal,
      error: slot.error,
      startedAt: slot.startedAt,
    };
  }

  /** 从 subprocess 收集器拉一段增量进尾部缓冲(readFrom 是 offset 制非消费式)。 */
  function drainStream(reader, bytePos) {
    if (!reader) return { text: '', next: bytePos };
    try {
      const r = reader.readFrom(bytePos);
      return {
        text: r && typeof r.text === 'string' ? r.text : '',
        next: typeof r.nextOffset === 'number' ? r.nextOffset : bytePos,
      };
    } catch {
      return { text: '', next: bytePos };
    }
  }

  /** 单流尾部状态: pump = 收集器字节游标, buf/base = 尾部字符缓冲与其绝对首字符位。 */
  function newStreamState() {
    return { pump: 0, buf: '', base: 0 };
  }

  function pumpSide(slot, side, reader) {
    const d = drainStream(reader, slot[side].pump);
    if (d.text !== '') {
      const r = appendTail(slot[side].buf, d.text, SHELL_STREAM_CAP_CHARS);
      slot[side].buf = r.buffer;
      slot[side].base += r.dropped;
    }
    slot[side].pump = d.next;
  }

  function pumpShell(slot) {
    pumpSide(slot, 'out', slot.handle?.collected?.stdout);
    pumpSide(slot, 'err', slot.handle?.collected?.stderr);
  }

  async function handleShellStart(body) {
    const cmd = validShellCommand(body.command);
    if (cmd === null) return { ok: false, error: 'invalid-command' };
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const subprocess = ctx.get('subprocess');
    if (subprocess === undefined) return { ok: false, error: 'subprocess-unavailable' };
    const jobs = ctx.get('jobs');
    if (jobs === undefined || typeof jobs.start !== 'function') {
      return { ok: false, error: 'jobs-unavailable' };
    }
    const current = shellSlots.get(base) ?? null;
    if (current && (current.status === 'running' || current.status === 'stopping')) {
      return { ok: false, error: 'busy', job: shellPublic(current) };
    }
    ensureJobController(jobs);
    let handle;
    try {
      handle = subprocess.spawn({
        argv: [...shellArgv().argv, cmd],
        cwd: base,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 3000, // 停止时 TERM → 3s → KILL; 兼作管道排空宽限
      });
    } catch (err) {
      return {
        ok: false,
        error: 'spawn-failed',
        detail: String((err && err.message) || err || 'spawn failed').slice(0, 200),
      };
    }
    evictTerminalSlots();
    const slot = {
      jobId: '',
      label: cmd,
      handle,
      out: newStreamState(),
      err: newStreamState(),
      status: 'running',
      exitCode: null,
      signal: null,
      error: null,
      startedAt: Date.now(),
    };
    shellSlots.set(base, slot);
    try {
      const jobId = jobs.start({
        kind: 'shell',
        label: cmd,
        run: () => ({
          cancel: () => {
            if (slot.status === 'running') slot.status = 'stopping';
            try {
              handle.terminate();
            } catch {
              // 已退出: 忽略
            }
          },
          done: handle.done.then(
            ({ exitCode, signal }) => {
              slot.status = signal ? 'killed' : 'completed';
              slot.exitCode = exitCode;
              slot.signal = signal;
              pumpShell(slot); // 终态前排空残余输出
              return {
                status: signal ? 'killed' : 'completed',
                detail: signal ? 'signal: ' + signal : 'exit code: ' + exitCode,
              };
            },
            (err) => {
              // spawn 级失败(如解释器消失): done 契约不许 reject, 归一为 failed
              slot.status = 'failed';
              slot.error = String((err && err.message) || err || 'spawn failed').slice(0, 200);
              return { status: 'failed', detail: slot.error };
            },
          ),
          readOutput: () => {
            pumpShell(slot);
            const merged =
              slot.out.buf + (slot.err.buf !== '' ? '\n[stderr]\n' + slot.err.buf : '');
            return merged.slice(-SHELL_STREAM_CAP_CHARS);
          },
        }),
      });
      slot.jobId = String(jobId ?? '');
    } catch (err) {
      // start 抛错(如无 controller): 清理已起进程, 记录失败供状态行展示
      try {
        handle.terminate();
      } catch {
        // 忽略
      }
      slot.status = 'failed';
      slot.error = String((err && err.message) || err || 'background jobs unavailable').slice(
        0,
        200,
      );
      return { ok: false, error: 'jobs-unavailable' };
    }
    return { ok: true, job: shellPublic(slot) };
  }

  function handleShellState(body) {
    const lookup = slotFor(body);
    if (lookup.error) return { ok: false, error: lookup.error };
    return { ok: true, job: shellPublic(lookup.slot) };
  }

  function handleShellOutput(body) {
    const lookup = slotFor(body);
    if (lookup.error) return { ok: false, error: lookup.error };
    const slot = lookup.slot;
    if (!slot) return { ok: true, job: null };
    pumpShell(slot);
    // from/outFrom 的钳制(非有限数 → 0)由 sliceSince 内部统一处理
    return {
      ok: true,
      job: shellPublic(slot),
      done: slot.status !== 'running' && slot.status !== 'stopping',
      out: sliceSince(slot.out.buf, slot.out.base, body.outFrom),
      err: sliceSince(slot.err.buf, slot.err.base, body.errFrom),
    };
  }

  function handleShellStop(body) {
    const lookup = slotFor(body);
    if (lookup.error) return { ok: false, error: lookup.error };
    const slot = lookup.slot;
    if (!slot || (slot.status !== 'running' && slot.status !== 'stopping')) {
      return { ok: true, stopped: false, job: shellPublic(slot) };
    }
    slot.status = 'stopping';
    try {
      slot.handle.terminate(); // 整树 TERM → graceMs → KILL
    } catch {
      // 已退出: 状态由 done 回调收尾
    }
    return { ok: true, stopped: true, job: shellPublic(slot) };
  }

  // ---- 路由与信任栅栏(与 ds-balance 同款) ----

  const HANDLERS = {
    info: handleInfo,
    tree: handleTree,
    status: handleStatus,
    diff: handleDiff,
    file: handleFile,
    search: handleSearch,
    log: handleLog,
    show: handleShow,
    save: handleSave,
    create: handleCreate,
    rename: handleRename,
    remove: handleRemove,
    shellStart: handleShellStart,
    shellState: handleShellState,
    shellOutput: handleShellOutput,
    shellStop: handleShellStop,
  };

  function isTrustedRequest(req) {
    const host = String(req.headers.host ?? '');
    const name = host.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
  }

  function writeJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  function readJsonBody(req, cap) {
    const capBytes = typeof cap === 'number' && cap > 0 ? cap : BODY_CAP;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        total += chunk.length;
        if (total > capBytes) {
          failed = true;
          reject(new Error('body-too-large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (failed) return;
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text === '' ? {} : JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (req.headers['x-dsh-plugin'] !== '1') {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith(ROUTE_PREFIX + '/')
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined;
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      const handler = HANDLERS[method];
      if (handler === undefined) {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req, method === 'save' ? SAVE_BODY_CAP : BODY_CAP);
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-json' });
        return;
      }
      try {
        writeJson(res, 200, await handler(body));
      } catch (err) {
        console.error('fge: api "' + method + '" failed', err);
        writeJson(res, 500, { ok: false, error: 'failed' });
      }
    },
  });
}
