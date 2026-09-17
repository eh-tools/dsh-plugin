/**
 * dsh-file-git-explorer — host half(静态双半插件)
 *
 * 职责: 为右侧栏「git 页签」与终端抽屉提供 git 数据与 xterm 静态资产。
 *
 * ⚠ 终端**进程**不在这里: 抽屉里的终端由官方 `@deepseek-ai/dsh-api-terminal-controller` 提供
 * (client 半直接用 `ctx.webTerminals`, host 半不需要任何路由), 见 docs/adr/0006。
 *
 * 静态插件的 client→host 通信不走动态插件的 harness 私有 RPC, 而是注册
 * HTTP JSON 路由(与 dsh-ds-balance 同款信任栅栏):
 *
 *   POST /fge/api/info    { root? }                        → { cwd, repoRoot }       纯 stat, 零 git 子进程
 *   POST /fge/api/status  { root?, repoRoot }              → { current, head, upstream, ahead, behind, branches, changes }
 *   POST /fge/api/worktrees { root? }                      → { repoRoot, entries }    `git worktree list --porcelain`
 *   POST /fge/api/sync    { root? }                         → { ok }                  fetch --prune; 成功则作废分支缓存
 *   POST /fge/api/diff    { repoRoot, path, status, from? } → { kind:'diff'|'untracked', hunks, text }
 *   POST /fge/api/log     { repoRoot, ref?, skip?, limit? } → { ref, head, commits }   翻页零 rev-parse
 *   POST /fge/api/show    { repoRoot, hash, path? }         → { kind:'commit'|'merge'|'diff', message, files, hunks, text }
 *   GET  /fge/vendor/…    xterm.js | xterm.css | addon-fit.js   白名单静态资产(见下方栅栏说明)
 *
 * 信任栅栏: 仅回环地址 + `x-dsh-plugin: 1` 头 + 仅 POST。**vendor 路由是唯一例外** ——
 * `<script src>` 无法携带自定义头, 故只校验回环地址, 并以**固定白名单**兜底(三个文件名
 * 硬编码, 不接受任意路径, 从根上排除穿越); 它是只读的静态第三方资产, 不含任何仓库数据。
 *
 * 性能事实(改实现前必读):
 *   - status 一条 `git status --porcelain=v2 -z --branch` 拿全部分支与变更, 不再 4 连发。
 *   - 分支列表 TTL 60s、历史 TTL 30s; 仓库根**刻意不缓存**(见下方 repoRootFor 注释)。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  parseStatusV2,
  sortChanges,
  safeRef,
  safeHash,
  logArgs,
  parseLogOut,
  parseNumStatZ,
  parentsFromRevList,
  diffArgs,
  parseDiffHunks,
  parseWorktreeList,
} from './git.js';

// 自身依赖的锚点(插件自带依赖, 如 @xterm/xterm)。
const requireSelf = createRequire(import.meta.url);

export const name = 'dsh-file-git-explorer';

/** webServer 是唯一硬依赖; subprocess 走可选访问。 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/fge/api';
const VENDOR_PREFIX = '/fge/vendor';
const BODY_CAP = 256 * 1024; // 请求体上限(与 handoff 一致)
const TEXT_CAP = 2 * 1024 * 1024; // diff / 提交详情文本上限
const BRANCH_TTL_MS = 60 * 1000;
const HISTORY_TTL_MS = 30 * 1000;
const SYNC_GRACE_MS = 8 * 1000; // 手动 ⟳ 的 fetch 限时, 失败放行
const GIT_GRACE_MS = 15 * 1000;

/** vendor 白名单: 固定三个文件 → 解析出来的绝对路径。 */
const VENDOR_FILES = new Map([
  ['xterm.js', ['@xterm/xterm', 'lib/xterm.js', 'text/javascript; charset=utf-8']],
  ['xterm.css', ['@xterm/xterm', 'css/xterm.css', 'text/css; charset=utf-8']],
  ['addon-fit.js', ['@xterm/addon-fit', 'lib/addon-fit.js', 'text/javascript; charset=utf-8']],
]);

export function apply(ctx) {
  const CWD = process.cwd();

  // ---- 依赖解析锚点 ----
  //
  // ⚠ 实测钉死: 插件以 **junction** 挂进 profile, 而 Node 默认解析 realpath,
  // 所以 `import.meta.url` 指向真实仓库路径, 从那里不一定解析得到 profile 里的东西。
  // 故顺序为: 先锚 profile 配置树, 再退回插件自身(插件自带依赖, 如 @xterm/xterm)。
  let requireProfile = null;
  try {
    if (typeof ctx.baseUrl === 'string' && ctx.baseUrl !== '') {
      requireProfile = createRequire(ctx.baseUrl);
    }
  } catch {
    requireProfile = null;
  }

  /** 解析依赖内某个文件的绝对路径(先 profile, 再自身)。 */
  function resolveDepPath(spec) {
    const anchors = requireProfile === null ? [requireSelf] : [requireProfile, requireSelf];
    for (const anchor of anchors) {
      try {
        return anchor.resolve(spec);
      } catch {
        // 试下一个锚点
      }
    }
    return null;
  }

  // ---- 通用工具 ----

  function writeJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  function isTrustedRequest(req) {
    const host = String(req.headers.host ?? '');
    const hostname = host.split(':')[0];
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  }

  function readJsonBody(req, cap = BODY_CAP) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        total += chunk.length;
        if (total > cap) {
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

  /** 请求根目录: 每个请求可携带 `root`(绝对路径); 非法返回 null。 */
  function baseOf(body) {
    const r = typeof body.root === 'string' ? body.root : '';
    if (r === '') return CWD;
    if (!path.isAbsolute(r)) return null;
    return path.normalize(r);
  }

  /** 校验 body.repoRoot: 缺失 → no-repo, 非绝对路径 → invalid-root。 */
  function absRepoRootOf(body) {
    const root = typeof body.repoRoot === 'string' ? body.repoRoot : '';
    if (root === '') return { error: 'no-repo' };
    if (!path.isAbsolute(root)) return { error: 'invalid-root' };
    return { dir: path.resolve(root) };
  }

  function capText(text) {
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  }

  // ---- git ----

  /** 从 start 向上找含 .git 的目录(仓库根); 找不到返回 null。 */
  async function findRepoRoot(start) {
    let dir = start;
    for (;;) {
      try {
        const st = await fsp.stat(path.join(dir, '.git'));
        if (st.isDirectory() || st.isFile()) return dir; // 文件 = worktree/submodule
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
   * 刻意**不缓存**: 仓库根会随 .git 的新建/删除/移动而变化, 任何固定键缓存都可能
   * 在首次查询(工作区尚未成为仓库)后永久失效 —— 历史 bug 正是如此(s3 首次打开时
   * 还没有 .git, 向上命中父仓库并记进缓存, 之后 s3 建了自己的 .git, 缓存仍返回父仓库,
   * 右侧 git 页签于是渲染成父仓库的变更)。向上遍历只做 O(深度) 次 stat,
   * 重算成本远小于一次 git 子进程, 却能彻底消除这类失效。
   */
  async function repoRootFor(base) {
    return findRepoRoot(base);
  }

  /** 执行 git。非零退出不抛错, 由调用方按 exitCode 判断。 */
  async function runGit(args, opts = {}) {
    const subprocess = ctx.get('subprocess');
    if (subprocess === undefined) throw new Error('subprocess service unavailable');
    const handle = subprocess.spawn({
      argv: ['git', ...args],
      cwd: opts.cwd ?? CWD,
      env: opts.env,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: opts.maxBytes ?? 16 * 1024 * 1024 },
        stderr: { maxBytes: 2 * 1024 * 1024 },
      },
      graceMs: opts.graceMs ?? GIT_GRACE_MS,
    });
    const outcome = await handle.done;
    const read = (reader) => (reader !== undefined ? reader.readFrom(0).text : '');
    return {
      exitCode: outcome.exitCode,
      stdout: read(handle.collected.stdout),
      stderr: read(handle.collected.stderr),
    };
  }

  /**
   * 手动 ⟳ 的 fetch。非交互(GIT_TERMINAL_PROMPT=0)避免在无 TTY 下挂住;
   * 失败不致命, 只把 ok:false 回报给客户端。
   */
  async function runSync(cwd) {
    const r = await runGit(['fetch', '--all', '--prune'], {
      cwd,
      env: { GIT_TERMINAL_PROMPT: '0' },
      graceMs: SYNC_GRACE_MS,
    });
    return r.exitCode === 0;
  }

  // ---- 缓存 ----

  /** 分支列表 TTL 缓存: 只有 sync 成功才主动作废。 */
  const branchCache = new Map();

  async function branchesOf(repoRoot) {
    const now = Date.now();
    const hit = branchCache.get(repoRoot);
    if (hit !== undefined && now - hit.at < BRANCH_TTL_MS) return hit.branches;
    const r = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], {
      cwd: repoRoot,
    });
    const branches = [];
    if (r.exitCode === 0) {
      for (const line of r.stdout.split('\n')) {
        const ref = line.trim();
        if (ref === '') continue;
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), remote: false });
        } else if (ref.startsWith('refs/remotes/')) {
          const name = ref.slice('refs/remotes/'.length);
          if (name.endsWith('/HEAD')) continue; // origin/HEAD 是符号引用, 不是分支
          branches.push({ name, remote: true });
        }
      }
    }
    branches.sort((a, b) => {
      if (a.remote !== b.remote) return a.remote ? 1 : -1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    branchCache.set(repoRoot, { branches, at: now });
    return branches;
  }

  /** 历史 TTL 缓存: 键 = repoRoot + ref, 只缓存第一页(skip=0)。 */
  const historyCache = new Map();

  async function headOf(cwd) {
    const r = await runGit(['rev-parse', 'HEAD'], { cwd });
    return r.exitCode === 0 ? r.stdout.trim() || null : null;
  }

  // ---- API handlers ----

  /** info: 只做 stat, 零 git 子进程(分支/HEAD 由 status 一并带回)。 */
  async function handleInfo(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const repoRoot = await repoRootFor(base);
    return { ok: true, cwd: base, repoRoot };
  }

  /**
   * worktrees: 这份仓库的**所有工作区**(主仓 + 各 worktree), 供右侧 git 页签的「worktree 切换器」用。
   *
   * ⚠ 为什么由 host 出这份数据: 切到一个 worktree 之后, 后续 status / log / diff 都拿它的路径当 `root`
   *   —— 而 `root` 是客户端给的, 所以"哪些路径是**这份仓库的** worktree"必须由 host 用
   *   `git worktree list` 判定, 不能任客户端报一个绝对路径就当仓库用。
   * ⚠ `prunable`(目录已被删)的条目**照原样返回**: 列表里要不要显示它由客户端决定, host 不替它取舍;
   *   这里也**不**为每个条目去 stat(那会把一条 git 调用摊成 N 次 fs 调用)。
   */
  async function handleWorktrees(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const dir = await repoRootFor(base);
    if (dir === null) return { ok: false, error: 'no-repo' };
    const r = await runGit(['worktree', 'list', '--porcelain'], { cwd: dir });
    if (r.exitCode !== 0) return { ok: false, error: 'git-failed', stderr: r.stderr.slice(0, 400) };
    const entries = parseWorktreeList(r.stdout).map((e, i) => ({
      path: e.path,
      name: path.basename(e.path) || e.path,
      head: e.head,
      branch: e.branch,
      detached: e.detached,
      bare: e.bare,
      locked: e.locked === true,
      prunable: e.prunable === true,
      main: i === 0, // git 保证主工作区排第一
    }));
    return { ok: true, repoRoot: dir, entries };
  }

  /** status: 一条命令拿全 (分支 + 上游 + ahead/behind + 变更)。 */
  async function handleStatus(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const repo = absRepoRootOf(body);
    let dir;
    if (repo.dir !== undefined) dir = repo.dir;
    else {
      const found = await repoRootFor(base);
      if (found === null) return { ok: false, error: 'no-repo' };
      dir = found;
    }
    const r = await runGit(
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
      { cwd: dir },
    );
    if (r.exitCode !== 0) return { ok: false, error: 'git-failed', stderr: r.stderr.slice(0, 400) };
    const parsed = parseStatusV2(r.stdout);
    return {
      ok: true,
      repoRoot: dir,
      current: parsed.branch.head,
      head: parsed.branch.oid,
      upstream: parsed.branch.upstream,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      initial: parsed.branch.initial,
      detached: parsed.branch.detached,
      branches: await branchesOf(dir),
      changes: sortChanges(parsed.changes),
    };
  }

  /** sync: fetch --prune, 成功则作废该仓库的分支缓存与历史缓存。 */
  async function handleSync(body) {
    const base = baseOf(body);
    if (base === null) return { ok: false, error: 'invalid-root' };
    const repo = absRepoRootOf(body);
    let dir;
    if (repo.dir !== undefined) dir = repo.dir;
    else {
      const found = await repoRootFor(base);
      if (found === null) return { ok: false, error: 'no-repo' };
      dir = found;
    }
    const ok = await runSync(dir);
    if (ok) {
      branchCache.delete(dir);
      for (const key of [...historyCache.keys()]) {
        if (key.startsWith(dir + '\u0000')) historyCache.delete(key);
      }
    }
    return { ok, ...(ok ? {} : { error: 'fetch-failed' }) };
  }

  /** diff: 未跟踪不读盘(host 只回报 kind), 其余走 `diff HEAD -M -- <新> <旧>`。 */
  async function handleDiff(body) {
    const repo = absRepoRootOf(body);
    if (repo.dir === undefined) return { ok: false, error: repo.error };
    const filePath = typeof body.path === 'string' ? body.path : '';
    if (filePath === '') return { ok: false, error: 'invalid-path' };
    const status = typeof body.status === 'string' ? body.status : '';
    if (status === '?' || body.untracked === true) {
      // 未跟踪文件没有 diff 可言; 刻意不在 host 侧读盘(客户端自己决定怎么展示)。
      return { ok: true, kind: 'untracked', hunks: [], text: '' };
    }
    const entry = { path: filePath, origPath: null };
    const from = typeof body.from === 'string' ? body.from : '';
    if (from !== '') entry.origPath = from;
    const r = await runGit(diffArgs(entry), { cwd: repo.dir });
    if (r.exitCode !== 0) return { ok: false, error: 'git-failed' };
    const text = capText(r.stdout);
    return { ok: true, kind: 'diff', hunks: parseDiffHunks(text), text };
  }

  /** log: 分页提交列表; 仅第一页附带 HEAD, 翻页零 rev-parse。 */
  async function handleLog(body) {
    const repo = absRepoRootOf(body);
    if (repo.dir === undefined) return { ok: false, error: repo.error };
    const ref = safeRef(body.ref) ? String(body.ref).trim() : null;
    const skip = Math.max(0, Math.floor(Number(body.skip) || 0));
    const limit = Number(body.limit) || 50;
    const cacheKey = repo.dir + '\u0000' + (ref ?? '') + '\u0000' + String(skip);
    const isFirstPage = skip === 0;

    if (isFirstPage) {
      const hit = historyCache.get(cacheKey);
      if (hit !== undefined && Date.now() - hit.at < HISTORY_TTL_MS) return hit.value;
    }

    const r = await runGit(logArgs(ref, skip, limit), { cwd: repo.dir });
    if (r.exitCode !== 0) return { ok: false, error: 'git-failed' };
    const commits = parseLogOut(r.stdout);
    const head = isFirstPage ? await headOf(repo.dir) : undefined;
    const value = {
      ok: true,
      repoRoot: repo.dir,
      ref,
      commits,
      ...(isFirstPage ? { head } : {}),
    };
    // 只缓存非空第一页: 空结果常出现在刚 fetch 完/无提交的瞬态, 缓存它反而更糟。
    if (isFirstPage && commits.length > 0) {
      historyCache.set(cacheKey, { value, at: Date.now() });
    }
    return value;
  }

  /** show: 提交详情; 带 path 时给单文件 diff, 否则给说明 + 文件级 numstat。 */
  async function handleShow(body) {
    const repo = absRepoRootOf(body);
    if (repo.dir === undefined) return { ok: false, error: repo.error };
    const hash = typeof body.hash === 'string' ? body.hash : '';
    if (!safeHash(hash)) return { ok: false, error: 'invalid-hash' };
    const filePath = typeof body.path === 'string' ? body.path : '';

    if (filePath !== '') {
      const r = await runGit(
        ['-c', 'core.quotepath=false', 'show', '--format=', hash, '--', filePath],
        { cwd: repo.dir },
      );
      if (r.exitCode !== 0) return { ok: false, error: 'git-failed' };
      const text = capText(r.stdout);
      return { ok: true, kind: 'diff', hunks: parseDiffHunks(text), text };
    }

    // `rev-list` 与 `show -s` 并行: 两者互不依赖。
    const [parents, detail] = await Promise.all([
      runGit(['rev-list', '--parents', '-n', '1', hash], { cwd: repo.dir }),
      runGit(['-c', 'core.quotepath=false', 'show', '-s', '--format=%B', hash], {
        cwd: repo.dir,
      }),
    ]);
    if (detail.exitCode !== 0) return { ok: false, error: 'git-failed' };
    const parentCount = parents.exitCode === 0 ? parentsFromRevList(parents.stdout) : null;
    const message = detail.stdout.trim();

    // merge 提交的 combined diff 没有阅读价值: 只给说明, 不给文件列表。
    if (parentCount !== null && parentCount > 1) {
      return { ok: true, kind: 'merge', message, files: [], text: '' };
    }

    const stat = await runGit(
      ['-c', 'core.quotepath=false', 'diff-tree', '--numstat', '-z', '--root', '-r', hash],
      { cwd: repo.dir },
    );
    const files = stat.exitCode === 0 ? parseNumStatZ(stat.stdout) : [];
    return { ok: true, kind: 'commit', message, files, text: '' };
  }

  const HANDLERS = {
    info: handleInfo,
    status: handleStatus,
    worktrees: handleWorktrees,
    sync: handleSync,
    diff: handleDiff,
    log: handleLog,
    show: handleShow,
  };

  // ---- 静态 vendor 资产 ----

  /** 解析 vendor 依赖的绝对路径(失败返回 null: 未装依赖时不该炸掉 init)。 */
  function resolveVendor(spec) {
    const [pkg, rel] = spec;
    const pkgJson = resolveDepPath(pkg + '/package.json');
    if (pkgJson !== null) return path.join(path.dirname(pkgJson), ...rel.split('/'));
    const main = resolveDepPath(pkg);
    if (main !== null) return path.join(path.dirname(main), ...rel.split('/'));
    return null;
  }

  async function serveVendor(req, res) {
    if (!isTrustedRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
    const name = pathname.startsWith(VENDOR_PREFIX + '/')
      ? pathname.slice(VENDOR_PREFIX.length + 1)
      : '';
    // 固定白名单: 名字必须逐字符命中, 因此不存在路径穿越面。
    const spec = VENDOR_FILES.get(name);
    if (spec === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    const abs = resolveVendor(spec);
    if (abs === null) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('fge: vendor asset unavailable (' + spec[0] + ')');
      return;
    }
    try {
      const buf = await fsp.readFile(abs);
      res.writeHead(200, {
        'content-type': spec[2],
        'cache-control': 'public, max-age=86400',
        'content-length': String(buf.length),
      });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }

  ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: apiHandler });
  ctx.webServer.register({ kind: 'prefix', path: VENDOR_PREFIX, handler: serveVendor });

  async function apiHandler(req, res) {
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
  }
}
