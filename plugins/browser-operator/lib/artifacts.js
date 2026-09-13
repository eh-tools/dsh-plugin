/**
 * 产物目录解析 —— Playwright 的截图 / 转储落在哪儿。
 *
 * 规则(预设里也向模型申明同一套规则):**优先落进项目已经 ignore 的目录**,
 * 例如 `logs/`、`output/`、`scripts/`、`test-results/`;找不到就退到仓库外的
 * `$DSH_HOME/browser-operator/<sessionId>`,绝不把仓库搞脏。
 *
 * 判定「ignore」以 `git check-ignore` 为准(git 就是权威实现,自己写 glob 必然有出入);
 * git 不可用(没装、或不在仓库里)时才退化到本地 `.gitignore` 解析。
 *
 * 这一层是纯函数 + 只读探测,不依赖 Playwright,可离线单测。
 * @module dsh-browser-operator/artifacts
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 候选目录名,按优先级(用户给的例子排前面)。
 * 只有**真的被 ignore** 才会被选中,所以把 `scripts` 这种通常被跟踪的名字
 * 放进来是安全的 —— 不 ignore 就轮不到它。
 */
export const DEFAULT_ARTIFACT_CANDIDATES = [
  'logs',
  'output',
  'tmp',
  '.tmp',
  'scripts',
  'test-results',
  'playwright-report',
  'artifacts',
  '.artifacts',
  'screenshots',
  'debug',
  '.debug',
];

/** 选定目录下再套一层,产物集中、好清、不会和项目自己的日志混在一起。 */
export const ARTIFACT_SUBDIR = 'browser-operator';

/** DSH 家目录:配置里 `$DSH_HOME` 优先,否则 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/** 文件/目录存在(含 `.git` 是文件的情况:worktree)。 */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * `git check-ignore -q -- <rel>` —— 只看退出码,不接管道。
 *
 * 刻意不用 `execFile`/`exec`:它们默认 `stdio: 'pipe'`,而在受限环境里
 * 子进程开不了管道会 EPERM。这里 `stdio: 'ignore'`,只读退出码。
 *
 * @returns `true` 被 ignore;`false` 明确未被 ignore;`undefined` git 无法回答。
 */
function gitIgnored(cwd, rel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn('git', ['check-ignore', '-q', '--', rel], {
        cwd,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      done(undefined);
      return;
    }
    child.on('error', () => done(undefined));
    child.on('close', (code) => done(code === 0 ? true : code === 1 ? false : undefined));
  });
}

/** 从 cwd 向上找第一个带 `.git` 的目录(仓库根);没有则 null。 */
export async function findGitRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 把一个 .gitignore 模式串编译成正则(支持 `*` / `**` / `?` / 尾 `/` / 首 `/`)。 */
function compilePattern(raw) {
  let pattern = raw;
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern === '') return null;
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*|\?/g, (token) => (token === '**' ? '.*' : token === '*' ? '[^/]*' : '[^/]'));
  return new RegExp('^' + body + '(/.*)?$');
}

/** 解析 .gitignore 文本 → `{ re, negate }[]`,保持原顺序(后者覆盖前者)。 */
function parseIgnoreText(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const re = compilePattern(negate ? line.slice(1) : line);
    if (re !== null) rules.push({ re, negate });
  }
  return rules;
}

/**
 * git 不可用时的退化判定:合并仓库根、沿途各级目录的 `.gitignore`,
 * 以及 `.git/info/exclude`。只用来判断**顶层目录名**是否需要忽略。
 * @returns 被忽略则 `true`。
 */
async function ignoredByFiles(gitRoot, cwd, name) {
  const dirs = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (gitRoot === null || dir === gitRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const texts = [];
  for (const d of dirs.reverse()) {
    try {
      texts.push(await readFile(path.join(d, '.gitignore'), 'utf8'));
    } catch {
      // 该级没有 .gitignore,跳过。
    }
  }
  if (gitRoot !== null) {
    try {
      texts.push(await readFile(path.join(gitRoot, '.git', 'info', 'exclude'), 'utf8'));
    } catch {
      // 没有 exclude 文件,跳过。
    }
  }
  let ignored = false;
  for (const text of texts) {
    for (const rule of parseIgnoreText(text)) {
      if (rule.re.test(name)) ignored = !rule.negate;
    }
  }
  return ignored;
}

/**
 * 解析本次调用该用的产物目录(不创建目录,创建交给 {@link ensureArtifactDir})。
 *
 * 优先级:
 * 1. `override`(插件配置 `artifactDir`)——相对路径按会话工作区解析;
 * 2. 候选目录里**已存在且被 ignore** 的第一个;
 * 3. 候选目录里**被 ignore 但还没建**的第一个(用的时候再建);
 * 4. 仓库内但上面都没命中 → `$DSH_HOME/browser-operator/<sessionId>`(**不脏仓库**);
 * 5. 不在仓库里 → 工作区下的 `logs/browser-operator`(没有仓库就无所谓脏不脏)。
 *
 * @param {object} options
 * @param {string} [options.cwd] 会话工作区(不传则进程 cwd)。
 * @param {string} [options.sessionId] 用于外部兜底目录的稳定后缀。
 * @param {string} [options.override] 配置里的显式目录。
 * @param {string[]} [options.candidates] 覆盖默认候选。
 * @returns {Promise<{dir: string, source: string, detail: string}>}
 */
export async function resolveArtifactDir(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const candidates =
    Array.isArray(options.candidates) && options.candidates.length > 0
      ? options.candidates
      : DEFAULT_ARTIFACT_CANDIDATES;

  if (typeof options.override === 'string' && options.override.trim() !== '') {
    const raw = options.override.trim();
    const dir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    return { dir, source: 'config', detail: 'artifactDir 配置指定' };
  }

  const gitRoot = await findGitRoot(cwd);
  const nested = [];

  for (const name of candidates) {
    // 尾随 `/` 不能省:`.gitignore` 里 `logs/` 是**目录专属**模式,而
    // check-ignore 询问一个还不存在的 `logs` 时会把它当成文件,于是不匹配。
    const ignored = await gitIgnored(cwd, `${name}/`);
    if (ignored === false) continue;
    const resolved = ignored === true ? true : await ignoredByFiles(gitRoot, cwd, name);
    if (!resolved) continue;
    const base = path.join(cwd, name);
    nested.push({
      dir: path.join(base, ARTIFACT_SUBDIR),
      source: 'gitignore',
      detail:
        `${name}/ 被项目 ignore(` +
        (ignored === true ? 'git check-ignore' : '.gitignore 解析') +
        `),产物落 ${name}/${ARTIFACT_SUBDIR}/`,
    });
  }

  // 已存在的优先:产物不该为了写一张截图而先在别人仓库里建目录。
  for (const entry of nested) {
    if (await exists(path.dirname(entry.dir))) return entry;
  }
  if (nested.length > 0) return nested[0];

  if (gitRoot !== null) {
    const suffix =
      typeof options.sessionId === 'string' && options.sessionId.trim() !== ''
        ? options.sessionId.trim()
        : 'default';
    return {
      dir: path.join(dshHome(), 'browser-operator', suffix),
      source: 'dsh-home',
      detail: '仓库里没有已 ignore 的候选目录,产物写仓库外,避免污染工作区',
    };
  }

  return {
    dir: path.join(cwd, 'logs', ARTIFACT_SUBDIR),
    source: 'fallback',
    detail: '工作区不是 git 仓库,产物落 logs/ 下',
  };
}

/** 建目录(mkdir -p 语义),返回同一个路径,方便链式使用。 */
export async function ensureArtifactDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 列出产物目录里的文件,按修改时间倒序 —— 给 `browser_artifacts` 用。
 * @returns `{ name, path, bytes, mtimeMs }[]`
 */
export async function listArtifacts(dir, limit = 50) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
      files.push({ name, path: full, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 读不到(正在写 / 已删)就当不存在。
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}
