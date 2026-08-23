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
 *
 * git 一律经 subprocess 服务执行(argv 数组, 无 shell), 路径全部做防穿越校验:
 * 文件树/file 只能落在 root 之下, diff/status 的仓库根必须是绝对路径。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

import fsp from 'node:fs/promises';
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
} from './git.js';

export const name = 'dsh-file-git-explorer';

/** webServer 是唯一硬依赖; subprocess 走可选访问。 */
export const inject = ['webServer'];

const FILE_CAP = 1024 * 1024; // 单文件内容预览上限 1 MiB
const BODY_CAP = 256 * 1024; // 请求体上限
const ROUTE_PREFIX = '/fge/api';
const SEARCH_SCAN_CAP = 20000; // 搜索扫描条目上限(超出即截断, 忽略区可能巨大)
const SEARCH_RETURN_CAP = 300; // 搜索返回条目上限(排序后截断)

export function apply(ctx) {
  const CWD = process.cwd();
  const repoRootCache = new Map();

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

  /** 某根目录的仓库根(按根缓存)。 */
  async function repoRootFor(base) {
    if (repoRootCache.has(base)) return repoRootCache.get(base);
    const found = await findRepoRoot(base);
    repoRootCache.set(base, found);
    return found;
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
    if (truncated) return { ok: true, text: '', binary: false, truncated: true, size };
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
    }
    const groups = partitionChildren(entries, mode, reveal);
    const wire = groups.list.map((e) => ({
      name: e.name,
      rel: joinRel(rel, e.name),
      type: e.type,
      dot: e.dot,
      ignored: e.ignored,
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

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        total += chunk.length;
        if (total > BODY_CAP) {
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
        body = await readJsonBody(req);
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
