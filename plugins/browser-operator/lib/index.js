/**
 * 浏览器操作预设(browser-operator)的宿主侧插件。
 *
 * 注册 9 个 `browser_*` 工具,背后是**一个常驻、有头、可跨轮次**的浏览器会话:
 * 独立 profile 目录长期复用登录态,与用户日常浏览器并存互不干扰。
 *
 * ## 为什么是 Playwright `launchPersistentContext`
 *
 * 本机驱动方案经过实测(见 `tests/smoke.mjs`):
 *
 * - `chromium.launchPersistentContext(<独立 profile>, { channel: 'chrome' })`
 *   直接拉起**系统安装的 Google Chrome**,有头可见。Playwright 自己带
 *   `--user-data-dir` 拉起一个新进程,因此**不需要** `--remote-debugging-port`,
 *   也就绕开了「Chrome 拒绝在默认 profile 上开调试端口」和「同安装单例转发」
 *   两条坑;实测日常 Chrome 在跑时,agent 会话开关前后 chrome.exe 进程数不变。
 * - 因此**不需要** Chrome for Testing,也**不需要** `taskkill` 清场兜底 ——
 *   本插件绝不调用 `taskkill`,不碰任何不是自己拉起的浏览器进程。
 *
 * `browser` 配置可选 `chrome`(默认) / `edge` / `chromium`(Playwright 自带的
 * 那个);首选拉起失败时自动退到自带的 chromium,并把两次错误都报出来。
 *
 * ## 产物目录
 *
 * 截图等产物**优先落进项目已经 ignore 的目录**(`logs/`、`output/`、`scripts/`
 * 等,见 `lib/artifacts.js`);仓库里找不到就退到 `$DSH_HOME/browser-operator/`,
 * 绝不把仓库搞脏。预设的人设里向模型申明了同一套规则。
 *
 * ## 生命周期
 *
 * 预设是 standing mount(**每进程一份**,不是每会话一份),所以这里的闭包状态
 * 就是「本进程唯一那个浏览器会话」;context 惰性创建(首次工具调用时才拉起),
 * `ctx.on('dispose')` 负责收尾。会话工作区 cwd 每次调用从 `exec.agent` 现取,
 * 因此产物目录是按调用方的项目解析的。
 *
 * @module dsh-browser-operator
 */

import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  DEFAULT_ARTIFACT_CANDIDATES,
  dshHome,
  ensureArtifactDir,
  listArtifacts,
  resolveArtifactDir,
} from './artifacts.js';

/** 插件名:loader 行标识与日志标签。 */
export const name = 'browser-operator';

/** 工具注册表必须先就位;本插件不发布任何服务,不需要 isolate realm。 */
export const inject = ['tools'];

/** 每个工具声明的协作式调用预算(毫秒),交给 `dsh-tool-call-timeout-policy`。 */
const TOOL_TIMEOUT_MS = 120000;

/**
 * `playwright-core` 的候选解析起点。
 *
 * 正常情况下它就是本插件的依赖(`plugins/browser-operator/node_modules`);
 * 本机已经全局装了 `@playwright/test`,所以顺带留两条兜底路径,免得忘记
 * `pnpm install` 就完全用不了。
 */
function playwrightRequireBases() {
  const bases = [import.meta.url];
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData !== '') {
    bases.push(path.join(appData, 'npm', 'node_modules', '@playwright', 'test', 'index.js'));
    bases.push(path.join(appData, 'npm', 'node_modules', 'playwright-core', 'index.js'));
  }
  bases.push(
    path.join(dshHome(), 'profiles', 'web', 'node_modules', 'playwright-core', 'index.js'),
  );
  return bases;
}

/** 依次尝试各起点 require `playwright-core`;都失败才抛。 */
function loadPlaywright() {
  const tried = [];
  for (const base of playwrightRequireBases()) {
    try {
      return createRequire(base)('playwright-core');
    } catch (error) {
      tried.push(`${base} → ${error?.message ?? String(error)}`);
    }
  }
  throw new Error(
    'browser-operator: 找不到 playwright-core。请在插件目录跑一次 `pnpm install`' +
      `(plugins/browser-operator),或全局装 @playwright/test。已尝试:\n  ${tried.join('\n  ')}`,
  );
}

/**
 * `channel` 与 `executablePath` 是两条**互斥**的定位方式,配置成一个值即可。
 * @returns `{ channel?: string, executablePath?: string }`
 */
function browserTarget(browser, executablePath) {
  if (typeof executablePath === 'string' && executablePath.trim() !== '') {
    return { executablePath: executablePath.trim() };
  }
  if (browser === 'edge') return { channel: 'msedge' };
  if (browser === 'chromium') return {};
  return { channel: 'chrome' };
}

/** 插件配置,加载时就地校验(配错要吵,不能静默)。 */
function readConfig(config) {
  const browser = pickEnum(config.browser, ['chrome', 'edge', 'chromium'], 'chrome', 'browser');
  return {
    browser,
    headless: config.headless === true,
    profileDir:
      typeof config.profileDir === 'string' && config.profileDir.trim() !== ''
        ? config.profileDir.trim()
        : path.join(dshHome(), 'browser-operator', 'profile'),
    executablePath: typeof config.executablePath === 'string' ? config.executablePath.trim() : '',
    artifactDir:
      typeof config.artifactDir === 'string' && config.artifactDir.trim() !== ''
        ? config.artifactDir.trim()
        : '',
    artifactCandidates:
      Array.isArray(config.artifactCandidates) && config.artifactCandidates.length > 0
        ? config.artifactCandidates.map((item) => assertString(item, 'artifactCandidates[]'))
        : DEFAULT_ARTIFACT_CANDIDATES,
    navigationTimeoutMs: positiveInt(config.navigationTimeoutMs, 60000, 'navigationTimeoutMs'),
    actionTimeoutMs: positiveInt(config.actionTimeoutMs, 15000, 'actionTimeoutMs'),
    launchTimeoutMs: positiveInt(config.launchTimeoutMs, 60000, 'launchTimeoutMs'),
    logCap: positiveInt(config.logCap, 500, 'logCap'),
    maxTextChars: positiveInt(config.maxTextChars, 20000, 'maxTextChars'),
    locale: typeof config.locale === 'string' && config.locale !== '' ? config.locale : 'zh-CN',
  };
}

/** 单个插件的 apply:一个进程一份浏览器会话,状态全在闭包里。 */
export function apply(ctx, config = {}) {
  const settings = readConfig(config);

  /** @type {object | null} Playwright BrowserContext */
  let context = null;
  /** @type {Promise<object> | null} 正在进行的拉起 */
  let launching = null;
  /** 本次实际驱动的浏览器,用于在结果/错误里说清「到底拉起了什么」。 */
  let launchedAs = '';
  const consoleLog = [];
  const networkLog = [];
  let seq = 0;
  /** 产物目录按 cwd 缓存,同一个项目不重复探测 git。 */
  const artifactCache = new Map();
  /** 挂过监听的页面 / 记过起始时间的请求,避免重复挂。 */
  const watched = new WeakSet();
  const startedAt = new WeakMap();

  // ── 日志环形缓冲 ────────────────────────────────────────────────────────
  const push = (buffer, entry) => {
    buffer.push(entry);
    if (buffer.length > settings.logCap) buffer.splice(0, buffer.length - settings.logCap);
  };

  const pageLabel = (page) => {
    try {
      return page.url();
    } catch {
      return '(closed)';
    }
  };

  /** 给一个页面挂上 console / 网络监听(每个页面只挂一次)。 */
  function watchPage(page) {
    if (watched.has(page)) return;
    watched.add(page);

    page.on('console', (message) => {
      push(consoleLog, {
        seq: ++seq,
        at: new Date().toISOString(),
        page: pageLabel(page),
        type: message.type(),
        text: truncate(message.text(), 4000),
        location: message.location()?.url ?? '',
      });
    });
    page.on('pageerror', (error) => {
      push(consoleLog, {
        seq: ++seq,
        at: new Date().toISOString(),
        page: pageLabel(page),
        type: 'pageerror',
        text: truncate(error?.message ?? String(error), 4000),
        location: '',
      });
    });
    page.on('request', (request) => {
      startedAt.set(request, Date.now());
    });
    page.on('requestfailed', (request) => {
      push(networkLog, {
        seq: ++seq,
        at: new Date().toISOString(),
        method: request.method(),
        url: truncate(request.url(), 2000),
        status: 0,
        resourceType: request.resourceType(),
        durationMs: Date.now() - (startedAt.get(request) ?? Date.now()),
        error: request.failure()?.errorText ?? 'failed',
      });
    });
    page.on('response', (response) => {
      // 成功的请求不入缓冲,否则环形数组会被静态资源挤爆。
      const status = response.status();
      if (status < 400) return;
      const request = response.request();
      push(networkLog, {
        seq: ++seq,
        at: new Date().toISOString(),
        method: request.method(),
        url: truncate(response.url(), 2000),
        status,
        resourceType: request.resourceType(),
        durationMs: Date.now() - (startedAt.get(request) ?? Date.now()),
        error: '',
      });
    });
  }

  function watchContext(browserContext) {
    for (const page of browserContext.pages()) watchPage(page);
    browserContext.on('page', watchPage);
    browserContext.on('close', () => {
      // 用户手动关掉窗口 / 浏览器崩了 —— 下次调用会重新拉起。
      if (context === browserContext) {
        context = null;
        launchedAs = '';
      }
    });
  }

  /** 真的拉起浏览器;首选失败时退到 Playwright 自带的 chromium。 */
  async function launchBrowser(downloadsPath) {
    const { chromium } = loadPlaywright();
    await mkdir(settings.profileDir, { recursive: true });

    const primary = browserTarget(settings.browser, settings.executablePath);
    const describe = (target) => target.executablePath ?? target.channel ?? 'chromium(自带)';

    const attempt = async (target) => ({
      browserContext: await chromium.launchPersistentContext(settings.profileDir, {
        ...target,
        headless: settings.headless,
        viewport: null,
        locale: settings.locale,
        acceptDownloads: true,
        downloadsPath,
        timeout: settings.launchTimeoutMs,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate,TranslateUI',
        ],
      }),
      label: describe(target),
    });

    const failures = [];
    try {
      const result = await attempt(primary);
      launchedAs = result.label;
      return result.browserContext;
    } catch (error) {
      failures.push(`${describe(primary)}: ${error?.message ?? String(error)}`);
    }

    // 只有「没配 executablePath、首选也不是自带 chromium」才值得退一步。
    if (settings.executablePath === '' && settings.browser !== 'chromium') {
      try {
        const result = await attempt({});
        launchedAs = `${result.label}(配置的 ${settings.browser} 拉不起来,已退到自带 chromium)`;
        return result.browserContext;
      } catch (error) {
        failures.push(`chromium(自带): ${error?.message ?? String(error)}`);
      }
    }

    throw new Error(
      'browser-operator: 浏览器拉不起来。首次使用前请确认已安装对应浏览器。失败详情:\n  ' +
        failures.join('\n  '),
    );
  }

  /** 惰性建会话;并发调用共享同一次拉起。 */
  async function ensureContext(downloadsPath) {
    if (context !== null) return context;
    if (launching !== null) return launching;
    launching = launchBrowser(downloadsPath)
      .then((browserContext) => {
        context = browserContext;
        watchContext(browserContext);
        browserContext.setDefaultTimeout(settings.actionTimeoutMs);
        browserContext.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
        return browserContext;
      })
      .finally(() => {
        launching = null;
      });
    return launching;
  }

  /** 本次调用该用的产物目录(相对调用方的会话工作区解析)。 */
  async function artifactDirFor(exec) {
    const cwd = sessionCwd(exec);
    const override = settings.artifactDir;
    const key = `${cwd}\u0000${override}`;
    const cached = artifactCache.get(key);
    if (cached !== undefined) return cached;
    const resolved = await resolveArtifactDir({
      cwd,
      sessionId: exec?.agent?.session?.id ?? '',
      override,
      candidates: settings.artifactCandidates,
    });
    artifactCache.set(key, resolved);
    return resolved;
  }

  /** 拿到当前页面;没有就开一个(顺带把产物目录准备好)。 */
  async function ensurePage(exec) {
    const resolved = await artifactDirFor(exec);
    await ensureArtifactDir(resolved.dir);
    const browserContext = await ensureContext(resolved.dir);
    const pages = browserContext.pages();
    if (pages.length > 0) {
      const page = pages[pages.length - 1];
      watchPage(page);
      return page;
    }
    return await browserContext.newPage();
  }

  /** 只读类工具要求会话已经存在,否则给一句人话而不是 Playwright 的栈。 */
  function existingPage() {
    if (context === null) {
      throw new Error(
        'browser-operator: 这个会话还没拉起浏览器 —— 先调一次 browser_navigate 打开页面。',
      );
    }
    const pages = context.pages();
    if (pages.length === 0) {
      throw new Error(
        'browser-operator: 浏览器窗口里已经没有页面了 —— 先 browser_navigate 打开一个。',
      );
    }
    const page = pages[pages.length - 1];
    watchPage(page);
    return page;
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────

  let closing = null;
  function closeBrowser() {
    if (closing !== null) return closing;
    const browserContext = context;
    context = null;
    launching = null;
    launchedAs = '';
    if (browserContext === null) return Promise.resolve();
    closing = browserContext
      .close()
      .catch(() => {
        // 关不掉就算了:Playwright 拉起的浏览器在连接断开后会自己退出。
      })
      .finally(() => {
        closing = null;
      });
    return closing;
  }

  ctx.on('dispose', () => {
    consoleLog.length = 0;
    networkLog.length = 0;
    void closeBrowser();
  });

  // ── 工具 ────────────────────────────────────────────────────────────────

  // 浏览器工具共享同一个页面,天然不可并发;不声明 isConcurrencySafe 即独占。

  ctx.tools.register({
    name: 'browser_navigate',
    description:
      '在常驻浏览器里打开一个 URL(没写 scheme 时自动补 http://),返回最终 URL、标题与 HTTP 状态。' +
      '首次调用会拉起一个有头可见的浏览器窗口,此后整个会话复用同一个窗口与登录态。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL;可以省略 http:// 前缀。' },
        waitUntil: {
          type: 'string',
          enum: ['commit', 'domcontentloaded', 'load', 'networkidle'],
          description: '等到哪个加载阶段,默认 domcontentloaded(比 load 快,SPA 通常够用)。',
        },
        timeoutMs: { type: 'integer', description: '本次导航超时(毫秒),默认取插件配置。' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', description: 'HTTP 状态码;无响应(如 data: URL)时为空串。' },
          browser: { type: 'string', description: '实际驱动的浏览器。' },
        },
        required: ['url', 'title', 'status', 'browser'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `${value.status || '-'} ${value.title}\n${value.url}` },
      ],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Open URL',
      kind: 'fetch',
      rawInput: typeof args.url === 'string' ? args.url : undefined,
    }),
    async execute(args, exec) {
      const page = await ensurePage(exec);
      const response = await page.goto(normalizeUrl(assertString(args.url, 'url')), {
        waitUntil: args.waitUntil ?? 'domcontentloaded',
        timeout: args.timeoutMs ?? settings.navigationTimeoutMs,
      });
      return {
        url: page.url(),
        title: await page.title(),
        status: response === null ? '' : String(response.status()),
        browser: launchedAs,
      };
    },
  });

  ctx.tools.register({
    name: 'browser_snapshot',
    description:
      '读取当前页面的可见文本(默认整个 body 的 innerText)、标题与 URL,用来了解页面现在长什么样。' +
      '渲染后的文本比抓 HTML 更适合喂给模型;要看 DOM 源码用 browser_eval。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器,只取该元素的文本;省略则取整个 body。',
        },
        maxChars: { type: 'integer', description: '文本截断上限(字符),默认取插件配置。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['url', 'title', 'text', 'truncated'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `# ${value.title}\n${value.url}\n\n${value.text}` +
            (value.truncated ? '\n\n…(已截断)' : ''),
        },
      ],
    },
    presentCall: () => ({ card: 'generic', title: 'Read page text', kind: 'read' }),
    async execute(args) {
      const page = existingPage();
      const limit = args.maxChars ?? settings.maxTextChars;
      const target = args.selector === undefined ? 'body' : assertString(args.selector, 'selector');
      let text;
      try {
        text = await page.locator(target).first().innerText({ timeout: settings.actionTimeoutMs });
      } catch (error) {
        throw new Error(
          `browser-operator: 取不到 ${target} 的文本(${error?.message ?? String(error)})。`,
        );
      }
      const clipped = truncate(text, limit);
      return {
        url: page.url(),
        title: await page.title(),
        text: clipped,
        truncated: clipped.length < text.length,
      };
    },
  });

  ctx.tools.register({
    name: 'browser_click',
    description:
      '点击页面元素。选择器可以是 CSS(`#submit`、`.btn`),或 Playwright 的文本/角色选择器' +
      '(`text=登录`、`role=button[name="提交"]`)。点击后返回当前 URL 与标题。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 或 Playwright 选择器。' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标键,默认 left。',
        },
        clickCount: { type: 'integer', description: '点击次数,2 即双击,默认 1。' },
        timeoutMs: { type: 'integer', description: '等待元素可点击的超时(毫秒)。' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' } },
        required: ['url', 'title'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `clicked → ${value.url}` }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Click',
      kind: 'execute',
      rawInput: typeof args.selector === 'string' ? args.selector : undefined,
    }),
    async execute(args, exec) {
      const page = await ensurePage(exec);
      const selector = assertString(args.selector, 'selector');
      try {
        await page
          .locator(selector)
          .first()
          .click({
            button: args.button ?? 'left',
            clickCount: args.clickCount ?? 1,
            timeout: args.timeoutMs ?? settings.actionTimeoutMs,
          });
      } catch (error) {
        throw new Error(
          `browser-operator: 点击 ${selector} 失败(${error?.message ?? String(error)})。` +
            '元素不存在 / 不可见 / 被遮挡,或页面还没准备好;先用 browser_snapshot 确认页面状态。',
        );
      }
      return { url: page.url(), title: await page.title() };
    },
  });

  ctx.tools.register({
    name: 'browser_fill',
    description:
      '给输入框填值,或给 `<input type="file">` 设置要上传的文件。提交表单用 submit: true(等价于填完按回车)。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '目标输入框的 CSS 选择器。' },
        value: { type: 'string', description: '要填的文本;上传文件时不要传。' },
        file: { type: 'string', description: '要上传的文件的绝对路径(单文件)。' },
        submit: { type: 'boolean', description: '填完后按回车提交,默认 false。' },
        timeoutMs: { type: 'integer', description: '等待元素的超时(毫秒)。' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          action: { type: 'string', description: '实际做了什么:fill 或 upload。' },
        },
        required: ['url', 'title', 'action'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `${value.action} → ${value.url}` }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Fill',
      kind: 'edit',
      rawInput: typeof args.selector === 'string' ? args.selector : undefined,
    }),
    async execute(args, exec) {
      const page = await ensurePage(exec);
      const selector = assertString(args.selector, 'selector');
      const timeout = args.timeoutMs ?? settings.actionTimeoutMs;
      const locator = page.locator(selector).first();
      const hasFile = typeof args.file === 'string' && args.file.trim() !== '';

      if (!hasFile && typeof args.value !== 'string') {
        throw new Error('browser-operator: browser_fill 需要 value(填文本)或 file(上传文件)之一。');
      }

      try {
        if (hasFile) await locator.setInputFiles(args.file.trim(), { timeout });
        else await locator.fill(args.value, { timeout });
        if (args.submit === true) await locator.press('Enter', { timeout });
      } catch (error) {
        throw new Error(
          `browser-operator: 操作 ${selector} 失败(${error?.message ?? String(error)})。`,
        );
      }
      return { url: page.url(), title: await page.title(), action: hasFile ? 'upload' : 'fill' };
    },
  });

  ctx.tools.register({
    name: 'browser_eval',
    description:
      '在当前页面上下文里执行一段 JavaScript 表达式,返回其值的 JSON 文本 —— 用来读页面状态、' +
      'localStorage、接口数据,或就地改状态。通过 CDP 求值,不受页面 CSP 限制。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            '要执行的表达式或语句,例如 `document.title`、`JSON.stringify(localStorage)`、`window.__APP__.user.id`。',
        },
        maxChars: { type: 'integer', description: '结果序列化后的截断上限(字符),默认 20000。' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          result: { type: 'string', description: '表达式结果的 JSON 文本。' },
          truncated: { type: 'boolean' },
        },
        required: ['result', 'truncated'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Evaluate JS',
      kind: 'execute',
      rawInput: typeof args.expression === 'string' ? truncate(args.expression, 200) : undefined,
    }),
    async execute(args, exec) {
      const page = await ensurePage(exec);
      const expression = assertString(args.expression, 'expression');
      let value;
      try {
        value = await page.evaluate(expression);
      } catch (error) {
        throw new Error(
          `browser-operator: 表达式执行失败(${error?.message ?? String(error)})。` +
            '常见原因:语法错误、抛异常,或返回了不可序列化的值(如 DOM 节点,试试 .textContent)。',
        );
      }
      const text = stringifyResult(value);
      const limit = args.maxChars ?? settings.maxTextChars;
      const clipped = truncate(text, limit);
      return { result: clipped, truncated: clipped.length < text.length };
    },
  });

  ctx.tools.register({
    name: 'browser_screenshot',
    description:
      '给当前页面截图落盘并返回绝对路径 —— 把它交给识图工具(vision_describe / read_image)做视觉验收。' +
      '产物优先写进项目已 ignore 的目录(如 logs/browser-operator/),仓库里找不到就写 $DSH_HOME。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名,默认带时间戳;会自动补 .png 后缀。' },
        fullPage: { type: 'boolean', description: '截整页(含滚动区),默认只截视口。' },
        selector: { type: 'string', description: '只截该元素,省略则截整页/视口。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '截图的绝对路径。' },
          bytes: { type: 'integer' },
          directory: { type: 'string', description: '产物目录。' },
          directorySource: { type: 'string', description: '这个目录是怎么选出来的。' },
        },
        required: ['path', 'bytes', 'directory', 'directorySource'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `screenshot → ${value.path} (${value.bytes} bytes)` },
      ],
    },
    presentCall: () => ({ card: 'generic', title: 'Screenshot', kind: 'read' }),
    async execute(args, exec) {
      const resolved = await artifactDirFor(exec);
      await ensureArtifactDir(resolved.dir);
      const page = await ensurePage(exec);
      const file = path.join(resolved.dir, screenshotName(args.name));
      try {
        if (args.selector !== undefined) {
          await page
            .locator(assertString(args.selector, 'selector'))
            .first()
            .screenshot({ path: file, timeout: settings.actionTimeoutMs });
        } else {
          await page.screenshot({ path: file, fullPage: args.fullPage === true });
        }
      } catch (error) {
        throw new Error(`browser-operator: 截图失败(${error?.message ?? String(error)})。`);
      }
      return {
        path: file,
        bytes: (await statSize(file)) ?? 0,
        directory: resolved.dir,
        directorySource: `${resolved.source} — ${resolved.detail}`,
      };
    },
  });

  ctx.tools.register({
    name: 'browser_console',
    description:
      '翻常驻捕获的 console 日志(含 pageerror 未捕获异常),按时间正序 —— 定位前端报错就看这里。' +
      '日志是环形缓冲,超出上限的旧条目会被丢弃。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回多少条(取最新的),默认 100。' },
        sinceSeq: { type: 'integer', description: '只看序号大于该值的条目,用于增量翻页。' },
        onlyErrors: {
          type: 'boolean',
          description: '只要 error / warning / pageerror,默认 false。',
        },
        clear: { type: 'boolean', description: '返回后清空缓冲,默认 false。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'integer' },
                at: { type: 'string' },
                page: { type: 'string' },
                type: { type: 'string' },
                text: { type: 'string' },
                location: { type: 'string' },
              },
              required: ['seq', 'at', 'page', 'type', 'text', 'location'],
              additionalProperties: false,
            },
          },
          total: { type: 'integer', description: '缓冲里当前总条数。' },
        },
        required: ['entries', 'total'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: renderLog(value.entries, (e) => `[${e.type}] ${e.text}`) },
      ],
    },
    presentCall: () => ({ card: 'generic', title: 'Console log', kind: 'read' }),
    async execute(args) {
      const entries = selectLog(consoleLog, args, (entry) =>
        args.onlyErrors === true ? ['error', 'warning', 'pageerror'].includes(entry.type) : true,
      );
      const total = consoleLog.length;
      if (args.clear === true) consoleLog.length = 0;
      return { entries, total };
    },
  });

  ctx.tools.register({
    name: 'browser_network',
    description:
      '翻常驻捕获的失败请求(4xx/5xx 响应 + 连接失败/被中止),按时间正序 —— 定位接口问题就看这里。' +
      '成功的请求不入缓冲,免得被静态资源挤爆。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回多少条(取最新的),默认 100。' },
        sinceSeq: { type: 'integer', description: '只看序号大于该值的条目,用于增量翻页。' },
        filter: { type: 'string', description: 'URL 子串过滤,不区分大小写。' },
        clear: { type: 'boolean', description: '返回后清空缓冲,默认 false。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'integer' },
                at: { type: 'string' },
                method: { type: 'string' },
                url: { type: 'string' },
                status: { type: 'integer' },
                resourceType: { type: 'string' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
              required: [
                'seq',
                'at',
                'method',
                'url',
                'status',
                'resourceType',
                'durationMs',
                'error',
              ],
              additionalProperties: false,
            },
          },
          total: { type: 'integer' },
        },
        required: ['entries', 'total'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderLog(value.entries, (e) => `${e.status || e.error} ${e.method} ${e.url}`),
        },
      ],
    },
    presentCall: () => ({ card: 'generic', title: 'Network log', kind: 'read' }),
    async execute(args) {
      const needle = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
      const entries = selectLog(networkLog, args, (entry) =>
        needle === '' ? true : entry.url.toLowerCase().includes(needle),
      );
      const total = networkLog.length;
      if (args.clear === true) networkLog.length = 0;
      return { entries, total };
    },
  });

  ctx.tools.register({
    name: 'browser_artifacts',
    description:
      '查当前项目的浏览器产物目录(截图等落在哪儿、为什么落那儿),并可列出已有产物。' +
      '规则:优先项目已 ignore 的目录(logs/、output/、scripts/ 等),否则退到 $DSH_HOME,绝不脏仓库。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['dir', 'list'],
          description: 'dir 只报目录;list 再列出文件,默认 dir。',
        },
        limit: { type: 'integer', description: 'list 时最多列几个,默认 50。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          source: { type: 'string' },
          detail: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'integer' },
              },
              required: ['name', 'path', 'bytes'],
              additionalProperties: false,
            },
          },
        },
        required: ['directory', 'source', 'detail', 'files'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.directory}\n(${value.source} — ${value.detail})\n` +
            (value.files.length === 0
              ? '(还没有产物)'
              : value.files.map((f) => `${f.name}  ${f.bytes}B  ${f.path}`).join('\n')),
        },
      ],
    },
    presentCall: () => ({ card: 'generic', title: 'Artifacts', kind: 'read' }),
    async execute(args, exec) {
      const resolved = await artifactDirFor(exec);
      const files =
        args.action === 'list' ? await listArtifacts(resolved.dir, args.limit ?? 50) : [];
      return {
        directory: resolved.dir,
        source: resolved.source,
        detail: resolved.detail,
        files: files.map((f) => ({ name: f.name, path: f.path, bytes: f.bytes })),
      };
    },
  });
}

// ── 纯函数辅助 ──────────────────────────────────────────────────────────────

/** 会话工作区 cwd;取不到就退回进程 cwd。 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd;
  return process.cwd();
}

/** 没有 scheme 时补 `http://`;`data:` / `about:` / `file:` 等原样保留。 */
function normalizeUrl(raw) {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `http://${value}`;
}

/** 截断到 limit 个字符。 */
function truncate(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length <= limit ? value : value.slice(0, limit);
}

/** 把页面返回值转成模型友好的 JSON 文本。 */
function stringifyResult(value) {
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 截图文件名:补 .png、挡掉路径分隔符,不给机会写到产物目录外面。 */
function screenshotName(requested) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const raw =
    typeof requested === 'string' && requested.trim() !== ''
      ? requested.trim().replace(/[\\/]/g, '_')
      : `browser-${stamp}`;
  return raw.toLowerCase().endsWith('.png') ? raw : `${raw}.png`;
}

/** 从日志缓冲里按 limit / sinceSeq / 谓词挑出最新的若干条(结果仍按时间正序)。 */
function selectLog(buffer, args, predicate) {
  const since = typeof args.sinceSeq === 'number' ? args.sinceSeq : -Infinity;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 100;
  return buffer.filter((entry) => entry.seq > since && predicate(entry)).slice(-limit);
}

/** 日志的模型可见文本。 */
function renderLog(entries, format) {
  if (entries.length === 0) return '(没有匹配的日志条目)';
  return entries.map((entry) => `${entry.seq}  ${entry.at}  ${format(entry)}`).join('\n');
}

/** 文件大小,读不到返回 undefined。 */
async function statSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

// ── 配置与参数校验 ──────────────────────────────────────────────────────────

/** 非空字符串。 */
function assertString(value, key) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`browser-operator: ${key} 必须是非空字符串(got ${JSON.stringify(value)})`);
  }
  return value.trim();
}

/** 枚举配置,取值不在集合里就报错。 */
function pickEnum(value, allowed, fallback, key) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) {
    throw new Error(
      `browser-operator: config.${key} 只能是 ${allowed.join(' / ')}(got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** 正整数配置。 */
function positiveInt(value, fallback, key) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`browser-operator: config.${key} 必须是正整数(got ${JSON.stringify(value)})`);
  }
  return value;
}
