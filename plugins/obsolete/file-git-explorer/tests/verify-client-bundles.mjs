/**
 * 静态插件的 client bundle 装配冒烟(无浏览器, 离线可跑)
 *
 * 运行: node plugins/obsolete/file-git-explorer/tests/verify-client-bundles.mjs
 *
 * ⚠ 本脚本是 **file-git-explorer 专属**的装配护栏, 随插件一起退役、一起搬进
 * `plugins/obsolete/`; 下面所有路径都相对**本插件目录**, 不再相对仓库根。
 *
 * host 侧的端到端由各插件自己的 tests/verify.mjs 覆盖; 这个脚本补的是**浏览器半边**
 * 里最容易写错、又最难靠人眼发现的一层 —— 装配契约:
 *   · bundle 能否在 stub 的浏览器环境下加载(顶层 window.__ModuleLoader__.load);
 *   · factory 是否**只** require 平台种子模块(浏览器模块表是一份封闭名单,
 *     require 到名单外的模块会在真实浏览器里抛错, 而这里能提前抓到);
 *   · apply() 注册的槽位名 / key / id / kind / priority 是否与声明一致 ——
 *     含「影子替换官方文档芯片必须用负数 priority」这条 boot 期会抛错的硬约束。
 *
 * 它**不**渲染任何 UI: 真实渲染仍需要浏览器(见插件 README 的验收清单)。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 被测插件目录 —— 本脚本住在 `tests/` 下, 上一级就是包根。 */
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 平台种子模块(浏览器 require 只能命中这份封闭名单 + 图内已装配包)。 */
const SEED_MODULES = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
]);

let passed = 0;
const failures = [];

function ok(label) {
    passed += 1;
    console.log('ok - ' + label);
}

function check(label, fn) {
    try {
        fn();
        ok(label);
    } catch (err) {
        failures.push(label + ' :: ' + (err && err.message));
        console.error('not ok - ' + label + ' :: ' + (err && err.message));
    }
}

function makeReactStub() {
    return {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        // 记下注册过的 effect: 有的检查要**手动模拟 React 的 flush**(见「详情浮起的两条硬约束」),
        // 因为桩里的 React 不会自己跑 effect。
        useEffect: (fn, deps) => {
            reactStub.__effects.push({ fn, deps });
        },
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useRef: (value) => ({ current: value }),
        __effects: [],
    };
}

const reactStub = makeReactStub();

function makeDocumentStub(overrides = {}) {
    // `style` 得是个**能写**的对象: apply() 里会落 CSS 变量(document.documentElement.style.setProperty)。
    const style = () => ({
        setProperty: () => {},
        removeProperty: () => {},
        getPropertyValue: () => '',
    });
    const node = () => ({
        style: style(),
        setAttribute: () => {},
        removeAttribute: () => {},
        appendChild: () => {},
        remove: () => {},
        removeChild: () => {},
        contains: () => false,
    });
    return {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: node,
        head: { appendChild: () => {} },
        body: { appendChild: () => {}, removeChild: () => {} },
        // apply() 里也可能直接挂**全局**监听(例如 Esc 关掉浮层): 这是浏览器必备 API,
        // stub 必须给出来, 否则测得的是"stub 不全"而不是"装配不对"。
        addEventListener: () => {},
        removeEventListener: () => {},
        activeElement: null,
        documentElement: node(),
        ...overrides,
    };
}

/**
 * 一个**只带 hooks 语义、不画 UI** 的最小 React —— 给"组件级"的离线回归用。
 *
 * 真渲染(`react-dom`)与真 DOM 由浏览器里那段负责; 这里要验的是**挂载决策**:
 * 同一个工作区换个会话把组件挂第二遍时, 它到底还发不发 git 请求。那取决于 `useState` 的**初值**
 * 与那条 mount effect, 不取决于 DOM —— 所以够用的 hook 语义足矣, 多写了反而是自欺。
 *
 * 语义: hook 顺序稳定(每次渲染从 0 数)、状态 / ref 跨渲染保持、effect 按依赖数组决定跑不跑
 * (无依赖数组 = 每次渲染都跑, 挂载必跑)。`remount()` = 换一个组件实例(旧实例的状态不回来),
 * 正是「切会话」在 hook 层的样子。
 */
function makeHookReact() {
    const hooks = [];
    let cursor = 0;
    let queued = [];
    const react = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (init) => {
            const at = cursor++;
            if (!(at in hooks)) hooks[at] = typeof init === 'function' ? init() : init;
            const set = (value) => {
                hooks[at] = typeof value === 'function' ? value(hooks[at]) : value;
            };
            return [hooks[at], set];
        },
        useRef: (init) => {
            const at = cursor++;
            if (!(at in hooks)) hooks[at] = { current: init };
            return hooks[at];
        },
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn(),
        useEffect: (fn, deps) => {
            const at = cursor++;
            const prev = hooks[at];
            const same =
                prev !== undefined &&
                prev.deps !== undefined &&
                deps !== undefined &&
                deps.length === prev.deps.length &&
                deps.every((dep, i) => Object.is(dep, prev.deps[i]));
            hooks[at] = { deps: deps === undefined ? undefined : deps.slice() };
            if (!same) queued.push(fn);
        },
        useLayoutEffect: (...args) => react.useEffect(...args),
        /** 渲染一次: 重置 hook 游标, 并收下这次要跑的 effect(由调用方 flush)。 */
        render(component, props) {
            cursor = 0;
            queued = [];
            const tree = component(props);
            return { tree, effects: queued };
        },
        /** 换一个组件实例(卸载重挂) —— hook 清零。 */
        remount() {
            hooks.length = 0;
        },
    };
    return react;
}

/** 把一棵 `createElement` 树里的**文本子节点**收成一个串(断言"屏上有什么"用)。 */
function treeText(node) {
    if (node === null || node === undefined || node === true || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(treeText).join('');
    if (typeof node === 'object' && Array.isArray(node.children)) return treeText(node.children);
    return '';
}

/**
 * 在 stub 环境里加载一个 client bundle 并执行 apply()。
 * @param {string} relPath bundle 相对**插件目录**的路径
 * @param {object} [options] 需要更真的环境时给的覆盖项:
 *   `sidebarRight`(替掉空对象)、`documentOverrides`、`requireOverrides`、`timers`(收 setTimeout)、
 *   `listeners`(收 document.addEventListener)、`innerWidth`。
 * @returns {{id: string, exports: object, slots: Array, tabs: Array, requires: string[], react: object}}
 */
function loadBundle(relPath, options = {}) {
    const source = readFileSync(join(PLUGIN, relPath), 'utf8');
    const timers = options.timers === undefined ? [] : options.timers;
    const listeners = options.listeners === undefined ? [] : options.listeners;
    let registration = null;
    const win = {
        __ModuleLoader__: {
            load: (mod) => {
                registration = mod;
            },
        },
        localStorage: options.storage || { getItem: () => null, setItem: () => {} },
        location: { protocol: 'http:', host: '127.0.0.1' },
        innerWidth: options.innerWidth === undefined ? 1600 : options.innerWidth,
        setTimeout: (fn, ms) => {
            timers.push({ fn, ms });
            return timers.length;
        },
        // 拖动期间会往 window 上挂 pointermove / pointerup: 桩得给出来, 并能被检查手动触发。
        addEventListener: () => {},
        removeEventListener: () => {},
        ...(options.win || {}),
    };
    const documentStub = makeDocumentStub({
        addEventListener: (type, fn, capture) => {
            listeners.push({ type, fn, capture });
        },
        ...(options.documentOverrides || {}),
    });
    // 顶层唯一的副作用就是这次注册
    new Function('window', 'document', source)(win, documentStub);
    assert.ok(registration !== null, relPath + ' 顶层应调用 window.__ModuleLoader__.load');

    const requires = [];
    const react = (options.requireOverrides || {})['react'] || reactStub;
    react.__effects = [];
    const requireStub = (spec) => {
        requires.push(spec);
        if (spec === 'react') return react;
        if (
            options.requireOverrides !== undefined &&
            options.requireOverrides[spec] !== undefined
        ) {
            return options.requireOverrides[spec];
        }
        if (SEED_MODULES.has(spec)) return {};
        throw new Error('require 了种子表外的模块: ' + spec);
    };
    const exportsObj = registration.factory(requireStub);
    assert.equal(typeof exportsObj.apply, 'function', relPath + ' 应导出 apply');

    const slots = [];
    const tabs = [];
    const events = [];
    const ctx = {
        slots: {
            inject: (_name, factory) => factory(),
            register: (options_, component) => {
                slots.push({ options: options_, component });
                return () => {};
            },
        },
        sidebarRightTabs: {
            register: (definition) => {
                tabs.push(definition);
                return () => {};
            },
        },
        remote: {
            workspaceFiles: {
                list: async () => ({ ok: true, value: { entries: [] } }),
                readAll: async () => ({ ok: true, value: { text: 'x' } }),
            },
        },
        effect: (fn) => {
            const disposer = fn();
            return () => {
                if (typeof disposer === 'function') disposer();
            };
        },
        // cordis 的事件订阅: apply() 里会用(例如 theme/change), stub 记下来供检查断言。
        on: (name, listener) => {
            events.push({ name, listener });
            return () => {};
        },
        get: () => undefined,
        ...(options.ctx || {}),
    };
    exportsObj.apply(ctx);
    return {
        id: registration.id,
        exports: exportsObj,
        slots,
        tabs,
        requires,
        react,
        timers,
        listeners,
        events,
    };
}

const slotOf = (bundle, name) => bundle.slots.filter((s) => s.options.name === name);

/** 官方 text 正文类型的实现 id —— 影子芯片必须用这个 key。 */
const OFFICIAL_TEXT_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview';

// ---- fge: git 页签 + diff 页签 + 文档芯片影子 + 终端抽屉 ----
{
    const b = loadBundle('lib/client.js');

    check('fge: bundle id 与 inject', () => {
        assert.equal(b.id, 'dsh-file-git-explorer');
        assert.ok(b.exports.inject.includes('slots'), 'inject 应含 slots');
        assert.ok(b.exports.inject.includes('sidebarRightTabs'), 'inject 应含 sidebarRightTabs');
        assert.ok(
            b.exports.inject.includes('sidebarRight'),
            'inject 应含 sidebarRight(float/close)',
        );
        assert.ok(
            b.exports.inject.includes('webTerminals'),
            'inject 应含 webTerminals(抽屉里的终端由官方 ctx.webTerminals 提供, 见 ADR-0006)',
        );
    });

    check('fge: 只 require 了种子模块(含 primitives)', () => {
        assert.deepEqual([...new Set(b.requires)].sort(), [
            '@deepseek-ai/dsh-client-ui-primitives',
            'react',
        ]);
    });

    check('fge: 两个 extension 档 kind(git / diff), 且没有外壳页签残留', () => {
        const kinds = b.tabs.map((t) => t.kind).sort();
        assert.deepEqual(kinds, ['fge-diff', 'fge-git']);
        for (const t of b.tabs) {
            assert.equal(t.priority, 'extension', t.kind + ' 应为 extension 档');
            assert.equal(typeof t.title, 'function', t.kind + ' 的 title 应为 thunk');
        }
        assert.ok(
            !kinds.includes('fge-shell'),
            '终端只有抽屉一种形态, 不应再有 fge-shell 页签类型',
        );
    });

    check('fge: 两个 kind 的 body / title 都按 key 注册', () => {
        const bodyKeys = slotOf(b, 'sidebar.right.pane.tab').map((s) => s.options.key);
        const titleKeys = slotOf(b, 'sidebar.right.pane.tab.title').map((s) => s.options.key);
        for (const key of ['dsh-file-git-explorer/git', 'dsh-file-git-explorer/diff']) {
            assert.ok(bodyKeys.includes(key), '缺 pane.tab body: ' + key);
            assert.ok(titleKeys.includes(key), '缺 pane.tab title: ' + key);
        }
        for (const s of b.slots) {
            assert.equal(typeof s.component, 'function', s.options.name + ' 的组件应为函数');
        }
    });

    check('fge: 影子注册官方 text 芯片槽, 且 priority 必须为负', () => {
        const shadows = slotOf(b, 'sidebar.right.pane.tab.title').filter(
            (s) => s.options.key === OFFICIAL_TEXT_ID,
        );
        assert.equal(shadows.length, 1, '应恰好影子注册一次官方 text 类型的芯片槽');
        // 关键: keyed 槽**同 key 同 priority 会直接抛错**, 而渲染取 priority 最低者。
        // 官方注册没有 priority(即 0), 所以这里必须是负数 —— 写成 0 会在 boot 期抛错。
        assert.equal(
            typeof shadows[0].options.priority,
            'number',
            '影子注册必须显式给 priority(否则与官方同为 0 → 注册抛错)',
        );
        assert.ok(shadows[0].options.priority < 0, '影子注册的 priority 必须小于官方的 0');
    });

    check('fge: 终端抽屉 + 会话铺底都注册进 conversation.composer.dock', () => {
        const dock = slotOf(b, 'conversation.composer.dock');
        assert.deepEqual(dock.map((s) => s.options.id).sort(), [
            'fge-session-seed',
            'fge-terminal',
        ]);
    });

    check('fge: 自身无重复注册(tab id / kind+档位 / keyed key / list id)', () => {
        // 注册表对这几类重复都是**boot 期直接抛错**, 所以离线就能护栏。
        const tabIds = new Set();
        const kindBands = new Set();
        for (const type of b.tabs) {
            assert.ok(!tabIds.has(type.id), 'tab 类型 id 重复: ' + type.id);
            tabIds.add(type.id);
            const band = type.priority === undefined ? 'extension' : type.priority;
            const key = type.kind + '\u0000' + band;
            assert.ok(!kindBands.has(key), '同档位重复声明 kind: ' + type.kind);
            kindBands.add(key);
        }
        const keyed = new Set();
        const listed = new Set();
        for (const slot of b.slots) {
            if (typeof slot.options.key === 'string') {
                const key = slot.options.name + '\u0000' + slot.options.key;
                // 影子芯片与官方同 key 是有意的, 但它不能与**本插件自己**的另一条冲突。
                assert.ok(!keyed.has(key), 'keyed 槽同 key 重复: ' + key);
                keyed.add(key);
            }
            if (typeof slot.options.id === 'string') {
                const key = slot.options.name + '\u0000' + slot.options.id;
                assert.ok(!listed.has(key), 'list 槽同 id 重复: ' + key);
                listed.add(key);
            }
        }
    });
}

// ---- fge: 同一个工作区切会话**不许**再读一遍 git(§10 回归锁) ----
//
// 复现的 bug: 数据快照原先与"视图状态"一起挂在**会话 id** 上, 于是同一个工作区换个会话就被当成
// 全新工作区, `info → status → log` 又走一遍(真 boot 实测: 每次切换固定这三条, 200–730ms),
// 面板先白成「读取中… / 读取历史…」再回填 —— 使用者口径就是"切个会话又要等它读一遍"。
//
// 判据(纯函数)与**真实组件**各验一遍: 前者锁规则, 后者锁"组件真的按这条规则在跑"
// (把 `gitDataDecision` 退回"同工作区也永远重新取"的旧规则, 这一条立刻变红)。

{
    const b = loadBundle('lib/client.js');

    check('fge: 工作区键归一化(盘符 / 反斜杠 / 尾斜杠 / 大小写)', () => {
        const key = b.exports.__workspaceKey;
        assert.equal(typeof key, 'function', 'bundle 应导出 __workspaceKey');
        assert.equal(key('E:\\repo\\'), 'e:/repo', '盘符折大小写、反斜杠折 /、去掉尾斜杠');
        assert.equal(key('e:/repo'), key('E:\\repo\\'), '同一目录的不同写法是同一个工作区');
        assert.equal(key('//server/share/Repo/'), '//server/share/repo');
        assert.equal(key('/home/u/repo/'), '/home/u/repo', '非盘符路径不折大小写');
        assert.equal(key('/home/u/REPO'), '/home/u/REPO', 'POSIX 大小写敏感, 不许折');
        assert.equal(key(''), null, '空 = 没有工作区');
        assert.equal(key('   '), null);
        assert.equal(key(undefined), null);
        assert.equal(key(null), null);
    });

    check('fge: 复用判据 —— 同工作区新鲜则 skip, 旧了 revalidate, 别的仓库 load', () => {
        const decide = b.exports.__gitDataDecision;
        assert.equal(typeof decide, 'function', 'bundle 应导出 __gitDataDecision');
        const snap = { cwd: 'E:\\repo', at: 1000 };
        assert.equal(
            decide(snap, 'E:\\repo', 1000 + 29_000, 30_000),
            'skip',
            '同工作区 + 新鲜 → skip',
        );
        assert.equal(
            decide(snap, 'e:/repo', 1000 + 1, 30_000),
            'skip',
            '同一目录的另一种写法也算同工作区',
        );
        assert.equal(
            decide(snap, 'E:\\repo', 1000 + 31_000, 30_000),
            'revalidate',
            '同工作区但旧了 → 快照照铺, 后台重取',
        );
        assert.equal(decide(snap, 'E:\\other', 1000 + 1, 30_000), 'load', '换工作区 → 从头取');
        assert.equal(decide(undefined, 'E:\\repo', 1000, 30_000), 'load', '没有快照 → 从头取');
        assert.equal(
            decide(snap, null, 1000, 30_000),
            'load',
            '工作区还不知道 → 从头取, 不许拿别的仓库的数据顶上',
        );
        assert.equal(decide(snap, '', 1000, 30_000), 'load', '空 cwd 同上');
    });

    check('fge: 上下两栏之间只剩那条 1px 分界线(拖柄不再撑出空隙)', () => {
        // 直接看**注入出去的 CSS**(与终端那几条同款手法): 这几条是字符串拼出来的, 读源码文本会被拼法绕过去。
        const styles = [];
        loadBundle('lib/client.js', {
            documentOverrides: {
                getElementById: () => null,
                createElement: (tag) =>
                    tag === 'style'
                        ? { id: '', textContent: '', setAttribute: () => {}, appendChild: () => {} }
                        : { style: {}, setAttribute: () => {}, appendChild: () => {} },
                head: { appendChild: (el) => styles.push(String(el.textContent || '')) },
            },
        });
        const css = styles.join('\n');
        const rule = (selector) => {
            const at = css.indexOf(selector + '{');
            assert.ok(at >= 0, '应注入 ' + selector + ' 规则');
            return css.slice(at + selector.length + 1, css.indexOf('}', at));
        };
        // 用户报的"空隙": 上栏 `padding-bottom:6px` + 5px 实体拖柄 = 两栏之间约 11px 的空白带。
        assert.ok(
            !/(^|;)\s*padding[^;]*6px/.test(rule('.fge-pane')),
            '上栏不许再留底部内边距 —— 那 6px 与拖柄叠起来就是两栏之间那块空白带',
        );
        assert.match(rule('.fge-pane-bottom'), /padding:0 0 6px/, '留白只留给下栏最底缘');
        // 拖柄 = 那条分界线本身: 布局高度 1px, 热区由伪元素压上去(不再占出 4px 空隙)。
        assert.match(rule('.fge-grip'), /height:1px/, '拖柄布局高度必须是 1px(就是那条分界线)');
        assert.match(
            rule('.fge-grip'),
            /z-index:2/,
            '热区要压过 sticky 标题栏的 z-index:1, 否则线那一带会被标题栏抢走、按不动',
        );
        assert.match(
            rule('.fge-grip::after'),
            /top:-4px/,
            '热区交给 ::after 压上去, 不许再用实体盒子占高度',
        );
        assert.match(
            rule('.fge-grip::after'),
            /height:5px/,
            '热区仍是 5px, 与原来那条实体拖柄一样好拖',
        );
    });
}

await checkAsync('fge: 同工作区切会话 —— 第二个会话一次 git 请求都不发, 数据直接上屏', async () => {
    const CWD = 'E:\\repo';
    const responses = {
        info: { ok: true, cwd: CWD, repoRoot: CWD },
        status: {
            ok: true,
            repoRoot: CWD,
            current: 'main',
            head: 'head-1',
            upstream: null,
            ahead: 0,
            behind: 0,
            initial: false,
            detached: false,
            branches: [],
            changes: [{ path: 'a.txt', badge: 'M' }],
        },
        log: {
            ok: true,
            repoRoot: CWD,
            ref: null,
            head: 'head-1',
            commits: [
                { hash: 'c0ffee', short: 'c0ffe', author: 'ann', at: 1, subject: '工作区里的提交' },
            ],
        },
    };
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const method = String(url).slice(String(url).lastIndexOf('/') + 1);
        calls.push(method);
        return { ok: true, status: 200, json: async () => responses[method] };
    };
    /** 让出足够多拍, 把 fetch 的整条 promise 链(info → status → log)跑完。 */
    const settle = async () => {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
    };
    try {
        const react = makeHookReact();
        const b = loadBundle('lib/client.js', {
            requireOverrides: {
                react,
                // git 页签体只用到这两个官方 hook 与两个图标; 它们与本回归无关, 给空实现即可。
                '@deepseek-ai/dsh-client-ui-primitives': {
                    useAnchoredPosition: () => null,
                    useDismissOnOutsidePointer: () => {},
                    IconBranchOutline16: () => null,
                    IconChevronDownOutline14: () => null,
                    // worktree 切换器的图标: 列表空时那条按钮不渲染, 但补上免得这个 stub 变成隐式契约。
                    IconFolderOpenOutline16: () => null,
                },
            },
        });
        const git = b.slots.find(
            (s) =>
                s.options.name === 'sidebar.right.pane.tab' &&
                s.options.key === 'dsh-file-git-explorer/git',
        );
        assert.ok(git !== undefined, 'git 页签体应注册在 sidebar.right.pane.tab');
        /** 会话快照: 两个会话 id, **同一个工作区**(这就是复现条件)。 */
        const propsFor = (id) => ({
            sessionId: id,
            useTabInfo: () => ({
                tab: {
                    id: 'tab-git',
                    kind: 'fge-git',
                    title: 'Git',
                    visible: true,
                    navigation: { revision: 1, params: {} },
                },
            }),
            useSessions: (selector) =>
                selector({ current: id, byId: { [id]: { cwd: CWD, running: false } } }),
        });
        const flush = (rendered) => {
            for (const fn of rendered.effects) fn();
        };

        // 1) 第一个会话: 没有快照 ⇒ 老老实实 info → status → log, 最后再补一条 worktrees。
        //    ⚠ worktrees 是**工作区数据的一部分**(切换器的列表), 所以它跟在同一轮加载的尾巴上、
        //      也进同一份快照 —— 正因为进了快照, 下面"第二个会话零请求"才照样成立。
        flush(react.render(git.component, propsFor('session-a')));
        await settle();
        assert.deepEqual(
            calls,
            ['info', 'status', 'log', 'worktrees'],
            '首次挂载应取一遍 git 数据(外加切换器那份 worktree 列表)',
        );
        // 真实 React 在 setState 后会重渲染; 这里手动重渲染一次, 让那份数据落进快照
        // (落盘在"每次渲染后"的那条 effect 里)。
        flush(react.render(git.component, propsFor('session-a')));

        // 2) 第二个会话, **同一个工作区**: 一次请求都不该发, 数据直接上屏(不白、不等)。
        const before = calls.length;
        react.remount(); // 切会话 = 组件换实例
        const second = react.render(git.component, propsFor('session-b'));
        flush(second);
        await settle();
        assert.deepEqual(calls.slice(before), [], '同工作区切会话不得再发 git 请求');
        const text = treeText(second.tree);
        assert.ok(text.includes('变更列表'), '上栏标题应在屏上');
        assert.ok(text.includes('a.txt'), '变更列表应直接是那份快照(不再等一次 status)');
        assert.ok(text.includes('工作区里的提交'), '提交历史也应直接是快照里那一页');
        assert.ok(!text.includes('读取中'), '快照在手时不该出现「读取中…」');
        assert.ok(!text.includes('读取历史'), '快照在手时不该出现「读取历史…」');
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ---- fge: 详情浮起的两条硬约束(页签条"闪一下" / 右栏自己跳回 git 树) ----
//
// 这两条都是**只在真浏览器里才看得见**的时序行为, 但成因离散且可离线复现:
//   · 新页签挂载的那一次 commit 里调 sidebarRight 必抛「no session surface is mounted」,
//     官方座位在同一轮 effect flush 的收尾就重绑好 —— 所以**必须用微任务重试**。
//     退回 setTimeout(60ms) 就会把"详情页签已在页签条上"的中间态画到屏幕上 3–5 帧:
//     使用者看到的就是"先加一个 tag, 闪一下, 消失"。
//   · 详情页签追加在来源 pane 末尾, 官方 float 把 activeTabId 改成 `tabs[index-1]`
//     (dockkit float reducer) —— 从「文件」页签点文件时, 左边那格正是 git 树,
//     观感就是"右栏自己切回 git 树了"。所以浮起之后要把用户原本那一格 focus 回来。
async function checkAsync(label, fn) {
    try {
        await fn();
        ok(label);
    } catch (err) {
        failures.push(label + ' :: ' + (err && err.message));
        console.error('not ok - ' + label + ' :: ' + (err && err.message));
    }
}

await checkAsync(
    'fge: 座位空隙的重试走微任务(不走定时器) + 浮起后把用户那一格 focus 回来',
    async () => {
        const floatCalls = [];
        const focusCalls = [];
        const requireOverrides = {
            // 芯片要复刻官方外观(FileTypeIcon / classifyFileType 等), 这里给个"什么都能当函数调"的桩。
            '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
        };
        const b = loadBundle('lib/client.js', {
            requireOverrides,
            // 右栏面板量得出宽度(否则会走"量不出 rect"那一路, 那是另一条合法分支)。
            documentOverrides: {
                querySelector: (sel) => {
                    if (typeof sel === 'string' && sel.includes('[data-sidebar-right-panel')) {
                        return {
                            getBoundingClientRect: () => ({
                                width: 300,
                                height: 900,
                                left: 1300,
                                top: 0,
                            }),
                        };
                    }
                    if (typeof sel === 'string' && sel.includes('aria-selected')) {
                        return {
                            getAttribute: (name) =>
                                name === 'data-dockkit-tab' ? 'tab-files' : null,
                        };
                    }
                    return null;
                },
            },
            ctx: {
                sidebarRight: {
                    float: (tabId) => {
                        floatCalls.push(tabId);
                        // 真浏览器实测: 新页签挂载那一轮里官方座位还没重绑, 第一次必抛这个错。
                        if (floatCalls.length === 1)
                            throw new Error('sidebarRight: no session surface is mounted');
                    },
                    focus: (tabId) => focusCalls.push(tabId),
                    close: () => {
                        throw new Error('sidebarRight: no session surface is mounted');
                    },
                    active: () => undefined,
                },
            },
        });

        // 1) 用户点了一下右栏正文(不是页签条) —— 插件应记住"用户原本在看的页签"。
        const click = b.listeners.find((l) => l.type === 'click' && l.capture === true);
        assert.ok(click !== undefined, 'apply() 应挂一个捕获阶段的 click 监听记录用户页签');
        click.fn({ target: { closest: () => null } });

        // 2) 渲染官方文档芯片 —— 文件详情与 diff 详情都走这一条采纳路径。
        const shadow = b.slots.find(
            (s) =>
                s.options.name === 'sidebar.right.pane.tab.title' &&
                s.options.key === OFFICIAL_TEXT_ID,
        );
        assert.ok(shadow !== undefined, '应影子注册官方 text 芯片槽');
        shadow.component({
            sessionId: 'session-1',
            useTabInfo: () => ({
                tab: {
                    id: 'tab-doc',
                    kind: 'text',
                    title: 'README.md',
                    visible: true,
                    navigation: { revision: 1, params: {}, address: '' },
                },
            }),
        });

        // 3) 手动 flush 那次渲染注册的 effect(桩里的 React 不会自己跑)。
        const effects = b.react.__effects.slice();
        assert.ok(effects.length > 0, '芯片应注册 useEffect(采纳悬浮详情)');
        for (const effect of effects) effect.fn();
        // 微任务重试: 让出几拍, 但不给定时器任何机会(桩里的 setTimeout 只记账、不执行)。
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        assert.deepEqual(
            floatCalls,
            ['tab-doc', 'tab-doc'],
            '第一次抛错后应在同一个 task 内立刻重试',
        );
        assert.deepEqual(
            b.timers.map((t) => t.ms),
            [],
            '座位空隙的重试不得走 setTimeout —— 那会把详情页签在页签条上画出来(实测 45–66ms / 3–5 帧)',
        );
        assert.deepEqual(
            focusCalls,
            ['tab-files'],
            '浮起后应把用户原本那一格 focus 回来(否则右栏跳回 git 树)',
        );
    },
);

await checkAsync('fge: 右栏宽度可拖 + 钳在 [200px, 15vw] + 拖动后记忆', async () => {
    const vars = {};
    const stored = [];
    const frame = {
        attrs: new Set(),
        setAttribute(name) {
            this.attrs.add(name);
        },
        removeAttribute(name) {
            this.attrs.delete(name);
        },
        parentElement: null,
    };
    const panelWidth = { value: 240 };
    const windowListeners = [];
    const b = loadBundle('lib/client.js', {
        innerWidth: 1600, // 上限 = 15vw = 240px
        requireOverrides: {
            '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
        },
        win: {
            addEventListener: (type, fn, capture) => windowListeners.push({ type, fn, capture }),
            removeEventListener: (type, fn) => {
                const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
                if (i >= 0) windowListeners.splice(i, 1);
            },
        },
        documentOverrides: {
            documentElement: {
                style: { setProperty: (k, v) => (vars[k] = v), removeProperty: () => {} },
            },
            querySelector: (sel) =>
                typeof sel === 'string' && sel.includes('[data-sidebar-right-panel')
                    ? {
                          getBoundingClientRect: () => ({
                              width: panelWidth.value,
                              height: 1000,
                              top: 0,
                          }),
                      }
                    : null,
        },
        storage: {
            getItem: () => null,
            setItem: (k, v) => stored.push({ k, v }),
        },
    });

    const down = b.listeners.find((l) => l.type === 'pointerdown' && l.capture === true);
    assert.ok(down !== undefined, 'apply() 应挂捕获阶段的 pointerdown 接管拖柄');

    const handle = {
        parentElement: frame,
        closest: (sel) => (sel === '[data-side="rightbar"]' ? handle : null),
    };
    const ev = (x) => ({
        clientX: x,
        target: handle,
        preventDefault: () => {},
        stopPropagation: () => {},
    });
    down.fn(ev(1000));
    assert.ok(
        frame.attrs.has('data-fge-resizing'),
        '拖动期间应给 frame 挂 data-fge-resizing(关掉官方过渡)',
    );
    const move = windowListeners.find((l) => l.type === 'pointermove');
    const up = windowListeners.find((l) => l.type === 'pointerup');
    assert.ok(move !== undefined && up !== undefined, '拖动应挂 pointermove / pointerup');

    // 往右拖 500px: 240 + 500 = 740 → 必须被 15vw(=240) 钳住
    move.fn(ev(500));
    assert.equal(vars['--fge-rightbar-px'], '240px', '向右拖不得越过 15vw 上限');
    // 往左拖 500px: 240 - 500 = -260 → 必须被 200px 下限接住
    move.fn(ev(1500));
    assert.equal(vars['--fge-rightbar-px'], '200px', '向左拖不得低于 200px 下限');
    // 松手时量到的是"已经生效"的面板宽度(真实页面里 CSS 变量此刻已作用于轨道 / 面板 max-width)
    panelWidth.value = 200;
    up.fn(ev(1500));
    assert.ok(!frame.attrs.has('data-fge-resizing'), '松手应摘掉 data-fge-resizing');
    assert.deepEqual(
        stored.map((s) => s.k),
        ['fge-rightbar-w-v1'],
        '存储键应固定(读回来的同一个键)',
    );
    assert.deepEqual(
        stored.map((s) => s.v),
        ['200'],
        '拖动结果应写进 localStorage(刷新 / 切会话保持)',
    );
});

check('fge: git 头部 38px(与会话头部对齐) + 拖柄不再隐藏 + 终端底色不写透明 + 订主题事件', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    // 头部高度: 官方页签条 0–38, 官方的「文件」页签头也是 38px ⇒ 底边线落在 y=76, 与会话头部
    // (`wSkVaW_header`)的底边线对齐。写成 padding 撑出来的高度会差 4px(实测 33.8px, 线在 y≈71.8)。
    assert.match(source, /\.fge-head\{[^}]*height:38px/, '.fge-head 必须是 38px 高(border-box)');
    assert.ok(
        !/\[data-side="rightbar"\]\{display:none\}/.test(source),
        '右栏拖柄不能再被 hiding —— 隐藏就没法拖',
    );
    // 右栏 chrome 的按钮: 「分栏」与「进全屏」都藏。
    // ⚠ 「进全屏」曾放回来过一轮, 用户随后指出**位置放错了** —— 全屏要落在详情浮窗上, 不是右栏页签条这格。
    //    它的细则(以及本插件自己加的那枚浮窗全屏开关)由下面那条 `详情浮窗的「全屏」开关` 守。
    assert.match(source, /'\[data-dockkit-split-button\]\{display:none\}'/, '「分栏」按钮仍然隐藏');
    // 详情浮窗头上的「送回侧栏」藏掉(用户口径): 它把详情变回右栏页签, 与"详情只以浮层出现"相反。
    // ⚠ 但**必须**限定在"我们的浮窗"里 —— 官方浮动宿主是所有页签共用的, 别的页签被浮起来
    //    (拖页签 / 页签菜单)时也长着同一个按钮, 裸选择器会把人家一起藏了。
    assert.match(
        source,
        /'\[data-dockkit-float\]:has\(\[data-dockkit-float-title\] \.fge-doc-name\) \[data-dockkit-float-dock\]\{display:none\}'/,
        '详情浮窗的「送回侧栏」要藏掉, 且按"标题里有本插件的文件名芯片"限定',
    );
    assert.ok(
        !/'\[data-dockkit-float-dock\]\{display:none\}'/.test(source),
        '不许写成裸的 [data-dockkit-float-dock] —— 会把别的页签浮窗的「送回侧栏」也藏掉',
    );
    // xterm 只认具体颜色: 传 rgba(0,0,0,0) 会被判无效并回落成它的默认黑,
    // 浅色主题下标题条(白)与终端体(黑)就断开, 看着就是"标题条错位"。
    assert.ok(
        !/background:\s*'rgba\(0,0,0,0\)'/.test(source),
        '终端 theme.background 必须给具体颜色(透明会被 xterm 丢掉 → 变纯黑)',
    );
    const b = loadBundle('lib/client.js');
    assert.ok(
        b.events.some((e) => e.name === 'theme/change'),
        '应订 theme/change: 主题切换时活着的终端要就地换色',
    );
});

check(
    'fge: 终端表面 code-block + 抽屉/舌跟对话区同宽 + 条无底色 + 滚动条 6px 圆角 + 选中即复制(mouseup) / Alt+C 兜底',
    () => {
        // 直接看**注入出去的 CSS**: 这几条规则是字符串拼出来的, 读源码文本容易被拼法绕过去。
        const styles = [];
        loadBundle('lib/client.js', {
            documentOverrides: {
                getElementById: () => null,
                createElement: (tag) =>
                    tag === 'style'
                        ? { id: '', textContent: '', setAttribute: () => {}, appendChild: () => {} }
                        : { style: {}, setAttribute: () => {}, appendChild: () => {} },
                head: { appendChild: (el) => styles.push(String(el.textContent || '')) },
            },
        });
        const css = styles.join('\n');
        assert.ok(css.length > 0, 'ensureStyles 应注入一段 CSS');
        // ⚠ 官方浅色主题里 `bg-base` / `bg-layer-1/2/3` **全是纯白**, 终端用它们就与页面融合、
        // 标题条那条分隔线也跟着看不出来(用户实测反馈)。官方终端卡片用的是 code-block 底色。
        assert.match(
            css,
            /\.fge-term\b[^}]*background:var\(--dsw-alias-markdown-code-block/,
            '终端抽屉应用 code-block 底色',
        );
        assert.match(
            css,
            /\.fge-term-body\{[^}]*background:var\(--dsw-alias-markdown-code-block/,
            '终端体应用 code-block 底色(不是 bg-base)',
        );
        assert.match(
            css,
            /\.fge-term-body \.xterm-viewport\{background-color:var\(--dsw-alias-markdown-code-block/,
            'viewport 覆盖色必须与画布同一个 token, 否则又会出现"接缝"',
        );
        // 标题条**不要自己的底色**(用户口径: 把那块色去掉) —— 透出抽屉表面, 分界靠下面那条 border。
        assert.match(css, /\.fge-term-strip\{[^}]*background:none/, '标题条不应再有自己的底色');
        // 抽屉 / 抽屉舌的宽度 = **composer 卡片(uV2eYG_card)的宽度**, 不是正文那一列。
        // 官方: `--dsh-composer-card-max-width = calc(chat-content-width + 32px)`、`side-clearance = 16px`,
        // 卡片自己 = `min(容器宽 - 2*side-clearance, card-max-width)`。只写 `max-width:chat-content-width`
        // 会比卡片**窄 32px**(左右各 16)—— 用户报的"宽度跟卡片不一致"; 座位本身是整条中栏, 所以还要自己减 clearance。
        assert.match(
            css,
            /\.fge-term\{[^}]*width:calc\(100% - var\(--dsh-composer-side-clearance,0px\) - var\(--dsh-composer-side-clearance,0px\)\)/,
            '抽屉宽度要减掉 composer 的左右 clearance(座位是整条中栏)',
        );
        assert.match(
            css,
            /\.fge-term\{[^}]*max-width:var\(--dsh-composer-card-max-width,var\(--dsh-chat-content-width,100%\)\)[^}]*margin-inline:auto/,
            '抽屉上限要用 composer 卡片的上限(居中)',
        );
        // 左右两侧都要有描边: 原来只有 border-top, 标题条那一段自己不带底色, 接缝就只剩下面那条分隔线,
        // 于是 grip 与 body 之间"断了一截"(用户口径的断层感)。官方 composer 座的横条就是四周描边的。
        assert.match(
            css,
            /\.fge-term\{[^}]*border:1px solid var\(--dsw-alias-border-l2\);border-bottom:0/,
            '抽屉左右两侧要有描边(下边贴座位底, 不画)',
        );
        assert.match(
            css,
            /\.fge-tongue\{[^}]*width:calc\(100% - var\(--dsh-composer-side-clearance,0px\)/,
            '抽屉舌也要跟抽屉同一列(同一个宽度公式)',
        );
        assert.match(
            css,
            /\.fge-tongue\{[^}]*max-width:var\(--dsh-composer-card-max-width/,
            '抽屉舌的上限也要跟卡片一致',
        );
        // 滚动条: 6px + 两端圆角(参考 dsh 自己的滚动条)。
        assert.match(
            css,
            /\.scrollbar\.vertical > \.slider\{[^}]*border-radius:3px/,
            '滚动条滑块要圆角',
        );
        // 页签与终端体同色(于是"连着终端"), 但**不得再用投影盖掉条的底边** —— 那样页签下面就没有那条线了。
        const tab = /\.fge-term-tab\{[^}]*\}/.exec(css);
        assert.ok(tab !== null, '应有 .fge-term-tab 规则');
        assert.match(
            tab[0],
            /background:var\(--dsw-alias-markdown-code-block/,
            '页签底色应与终端体同色',
        );
        assert.ok(
            !/box-shadow/.test(tab[0]),
            '页签不得再用 1px 投影盖住 strip 的底边(用户要求这条线在页签下面也连续)',
        );
        // 页签与终止键要落在**拖柄 + 标题条**这条带子的垂直中心(用户口径)。
        // 做法: 条里 `align-items:center` + 下内边距比上边多 `拖柄高 - 分隔线高` —— 拖柄在条上面、
        // 分隔线在条下面, 两者把带子的中心往上推了 2px, 用下内边距补回来。真机量过: 页签 / 终止键 /
        // 带子三者中心都在 19.5px(偏差 0)。
        const strip = /\.fge-term-strip\{[^}]*\}/.exec(css);
        assert.ok(strip !== null, '应有 .fge-term-strip 规则');
        assert.match(strip[0], /align-items:center/, '标题条里要垂直居中(原来贴底 flex-end)');
        assert.match(
            strip[0],
            /padding:3px 8px calc\(3px \+ var\(--fge-term-grip,5px\) - 1px\)/,
            '标题条的下内边距要抵掉拖柄与分隔线的偏心(拖柄高 - 分隔线高)',
        );
        assert.match(tab[0], /align-self:center/, '页签自己声明居中, 不靠条的默认对齐');
        assert.match(
            css,
            /--fge-term-grip:5px/,
            '拖柄高要在 .fge-term 上声明一次, 拖柄与下内边距共用它',
        );
        assert.match(
            css,
            /\.fge-term-grip\{height:var\(--fge-term-grip,5px\)/,
            '拖柄高度读同一个变量',
        );
        // 拖柄不许有 hover 底色(用户口径: hover 到边缘时那一整条 5px 的底色跟旁边不一样, 很扎眼)。
        // 可拖的提示交给 `cursor:ns-resize`。
        assert.ok(
            !/\.fge-term-grip:hover/.test(css),
            '终端抽屉的上缘拖柄不许有 hover 底色(用户口径)',
        );
        assert.ok(
            !/\.fge-term-glyph\{[^}]*margin-bottom/.test(css),
            '终止键不再自己贴底(margin-bottom), 跟着条一起居中',
        );
        // 终止键里的图标必须是**官方 SVG**, 不许退回文字字形 `■`: 同一个码位在不同平台/字体回退下
        // 大小与粗细都不一样(与刷新键那个 `⟳` 同一个毛病)。取色走 currentColor, 由 .fge-term-kill 给危险色。
        const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
        assert.match(
            source,
            /h\(primitives\.IconStopFill16, \{ size: 12 \}\)/,
            '终止键要换成官方 SVG 图标 IconStopFill16(尺寸 12)',
        );
        assert.ok(!/'■'/.test(source), '终止键不许再退回文字字形 ■(注释里提历史可以, 字面量不行)');
        assert.match(
            css,
            /\.fge-term-glyph\{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 4px\}/,
            '图标按钮的盒子里不要再有 font-size/line-height(那是给文字字形的)',
        );
        // 开关的**尺寸全套取偶数**(盒子 18 与终止键一致 / 轨道 12 / 滑块 8 / 文字行盒 12)。
        // 条里内容行高是奇数(页签 21px), 控件自己若是 17 / 轨道 13 / 行盒 11.5, 居中就落在 .5px 上 ——
        // 相邻元素的**文字与几何各自吸到不同的半像素**, 用户看到的就是"文字和开关垂直没对齐"。
        // 真机量: 修前 轨道 top=13.000 而文字行盒 top=13.750(不同相位); 修后两者都是 13.500 ✓
        const switchRule = /\.fge-term-switch\{[^}]*\}/.exec(css);
        assert.ok(switchRule !== null, '应有 .fge-term-switch 规则');
        assert.match(switchRule[0], /height:18px/, '开关盒子高 18(与终止键一致, 居中不留半像素)');
        assert.match(
            css,
            /\.fge-term-switch-track\{position:relative;flex:0 0 auto;width:24px;height:12px;border-radius:6px/,
            '轨道 24×12、圆角 6(半高, 偶数)',
        );
        assert.match(
            css,
            /\.fge-term-switch-knob\{position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%/,
            '滑块 8×8、四角整数留 2px',
        );
        assert.match(
            css,
            /\.fge-term-switch\[aria-checked="true"\] \.fge-term-switch-knob\{left:14px\}/,
            '开的滑块位置 = 24−8−2 = 14(整数 px, 不做百分比)',
        );
        assert.match(
            css,
            /\.fge-term-switch-label\{white-space:nowrap;line-height:12px\}/,
            '文字行盒 12px(偶数且与轨道同高) —— 它和轨道共一条中心线、同一个像素相位',
        );
        // xterm 自带滚动条 14px 且宽高是内联样式, 必须 !important 收到 6px。
        assert.match(
            css,
            /\.xterm-scrollable-element > \.scrollbar\.vertical\{width:6px!important\}/,
            'xterm 滚动条要收到 6px 宽(官方默认 14px)',
        );
        assert.match(
            css,
            /\.xterm-scrollable-element > \.scrollbar\.vertical > \.slider\{width:100%!important/,
            '滑块要跟着轨道收窄(否则滑块比轨道宽)',
        );
        // 终端里的复制: 选中即复制(终端不吃系统复制快捷键 —— Ctrl+C 必须留给 SIGINT, 所以拖选后靠 mouseup)。
        assert.match(source, /attachCustomKeyEventHandler/, '终端要挂自定义键处理(Alt+C 复制)');
        assert.match(source, /ev\.altKey/, 'Alt+C 复制要判 Alt 修饰键');
        assert.ok(
            !/ctrlKey && ev\.shiftKey/.test(source),
            '不要占用 Ctrl+Shift+C(那是浏览器/DevTools 的检查元素)',
        );
        assert.match(source, /writeClipboard/, '复制必须走 primitives.writeClipboard');
        // 终端里的复制: **选中即复制**(mouseup 上读选区) + **Alt+C 兜底**, 两条路共用 copySelection;
        // 条右侧那枚开关只停"自动"那条(Alt+C 与开关无关)。
        assert.match(
            source,
            /listen\(hostRef\.current, 'mouseup'/,
            '选中即复制: 必须在终端体上挂 mouseup(拖选 / 双击 / 三击都以 mouseup 收尾)',
        );
        assert.match(
            source,
            /function listen\(target, type, fn, capture\)/,
            '监听要走登记表挂 —— 挂在 document 上的那几个(捕获阶段)也必须在 cleanup 里摘干净',
        );
        assert.match(
            source,
            /rec\[0\]\.removeEventListener\(rec\[1\], rec\[2\], rec\[3\]\)/,
            'cleanup 要照登记表逐个摘(visible 抖动会让 effect 重跑, 不摘就越挂越多)',
        );
        assert.match(
            source,
            /function copySelection\(force, expandTail\)/,
            '选中即复制与 Alt+C 必须共用同一条 copySelection',
        );
        assert.match(
            source,
            /copySelection\(false, blocked\)/,
            'mouseup 那条走非强制(同一段不重复写)',
        );
        assert.match(
            source,
            /copySelection\(true, false\)/,
            'Alt+C 必须走强制, 但不做"补到行尾"的推断(那是拖拽手势才有的信息)',
        );
        assert.match(
            source,
            /TERM_COPY_KEY = 'fge-term-copy-v1'/,
            '开关状态要有存储键(整机一个偏好)',
        );
        assert.match(source, /function readTermCopy\(\)/, '开关要能读回上次的状态(默认开)');
        assert.match(source, /function writeTermCopy\(on\)/, '开关切换要记下来');
        // 开关: role=switch + aria-checked 表状态; 长在"整条可点即收起"的标题条里, 所以必须 stopPropagation。
        const sw = /className: 'fge-term-switch'[\s\S]{0,1600}?'选中复制'/.exec(source);
        assert.ok(sw !== null, '标题条里应有 .fge-term-switch 这枚开关(含文字标签)');
        assert.match(sw[0], /role: 'switch'/, '开关要声明 role=switch');
        assert.match(
            sw[0],
            /'aria-checked': copyOn \? 'true' : 'false'/,
            '开关状态走 aria-checked',
        );
        assert.match(sw[0], /ev\.stopPropagation\(\)/, '点开关不许连带收起抽屉(条本身可点即收起)');
        assert.match(sw[0], /writeTermCopy\(next\)/, '开关切换要落盘');
        assert.match(sw[0], /'选中复制'/, '开关要有文字标签(光一个轨道看不出是什么)');
        assert.match(
            source,
            /h\(TerminalView, \{[\s\S]{0,200}?copyOnSelect: copyOn/,
            '开关的值要传给终端视图(否则开关只是个装饰)',
        );
        // ⚠ 拖拽途中**不许**落选区: xterm 的 setSelection 会先 `_removeMouseDownListeners()`,
        //   拖到一半调用会把这次拖拽直接弄断(它就再也收不到 mousemove 了)。
        const mcFrom = source.indexOf('function onMoveCapture(ev)');
        assert.ok(mcFrom > 0, '应有 onMoveCapture(内容下方那条边界)');
        const mcBody = source.slice(mcFrom, source.indexOf('function copySelection(', mcFrom));
        assert.ok(
            !/\.select\(|clearSelection\(/.test(mcBody),
            '拖拽途中的边界处理只能"吃掉事件", 不许调用 select()/clearSelection()(那会弄断拖拽)',
        );
        assert.match(
            mcBody,
            /ev\.stopPropagation\(\)/,
            '内容下方那条边界靠捕获阶段 stopPropagation 实现(xterm 的拖拽监听在 document 冒泡阶段)',
        );
        assert.match(
            source,
            /listen\(document, 'mousemove', onMoveCapture, true\)/,
            '边界要挂在 document 的**捕获**阶段 —— 挂冒泡会被 xterm 的拖拽先吃掉',
        );
        assert.match(
            mcBody,
            /modes\.mouseTrackingMode !== 'none'/,
            '应用开了鼠标上报(全屏 TUI)时一概不碰: 那时鼠标归应用',
        );
        assert.match(
            source,
            /dragBlocked = true/,
            '被边界挡过要记下来 —— 松手时尾巴要补到那行文字末尾, 不许把最后一行截断',
        );
    },
);

// 终端内核: ADR-0006 —— PTY / shell / 进程 / 屏幕快照归官方 `ctx.webTerminals`,
// 本插件只留"抽屉外壳 + xterm 渲染"。下面既跑帧桥那条真实契约, 也钉住几个接线点。
check('fge: 终端内核 = 官方 ctx.webTerminals(帧桥 ack / mount-detach / close, 不再自建 WS)', () => {
    const b = loadBundle('lib/client.js');
    const apply = b.exports.__applyTerminalFrame;
    assert.equal(typeof apply, 'function', '应暴露 __applyTerminalFrame 供离线校验');
    const calls = [];
    const term = {
        reset: () => calls.push(['reset']),
        resize: (cols, rows) => calls.push(['resize', cols, rows]),
        write: (data, cb) => {
            calls.push(['write', data]);
            cb();
        },
    };
    const acks = [];
    const view = { acknowledge: (revision) => acks.push(revision) };
    let last = 0;
    last = apply(
        term,
        view,
        {
            revision: 1,
            frame: { type: 'snapshot', info: { cols: 120, rows: 30 }, screen: 'SCREEN' },
        },
        last,
    );
    assert.deepEqual(
        calls,
        [['reset'], ['resize', 120, 30], ['write', 'SCREEN']],
        'snapshot 必须**先 reset + 按 host 尺寸 resize, 再写屏**(顺序反了就是串屏)',
    );
    assert.deepEqual(acks, [1], '写完必须 acknowledge —— 官方那条流 await 它才放下一帧');
    assert.equal(last, 1, 'ack 过的那一帧成为新的 lastRevision');
    calls.length = 0;
    last = apply(term, view, { revision: 2, frame: { type: 'output', data: 'hi' } }, last);
    assert.deepEqual(calls, [['write', 'hi']], 'output 帧直接写, 不 reset');
    assert.deepEqual(acks, [1, 2], 'output 帧同样要 ack');
    calls.length = 0;
    apply(term, view, { revision: 2, frame: { type: 'output', data: 'dup' } }, last);
    assert.deepEqual(calls, [], '同一个 revision 不重放');
    assert.deepEqual(acks, [1, 2], '重放的帧不许再 ack(官方认的是 pendingRender 那一帧)');

    // 接线点(源码契约)。
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    assert.match(
        source,
        /ctx\.webTerminals\.view\(sessionId, TERM_KEY\)/,
        '终端要按 (会话, TERM_KEY) 取官方 view —— 同一个会话反复开关抽屉拿到同一个终端',
    );
    assert.match(
        source,
        /view\.state\.subscribe\(syncViewState\)/,
        '要订阅官方 view 的 state 快照流',
    );
    assert.match(source, /view\.mount\(\)/, '要挂官方 view 的 DOM 生命周期');
    assert.match(
        source,
        /detach !== null[\s\S]{0,80}detach\(\)/,
        '收起抽屉只 detach(不 close): 进程与屏幕留给 host 的官方终端',
    );
    assert.match(source, /view\.close\(\)/, '终止键要走官方 close()(请求结束进程)');
    assert.ok(!/new WebSocket/.test(source), '不再自己拉 WebSocket(协议 / 重连 / 回放全归官方)');
    assert.ok(!/\/fge\/ws\/terminal/.test(source), '不再有自建的终端 WS 路径');
});

check('fge: 终端选区尾巴收敛(纯函数: 最后一行有内容 / 收到那行 / 行号算法)', () => {
    const styles = [];
    const b = loadBundle('lib/client.js', {
        documentOverrides: {
            createElement: () => ({ style: { setProperty: () => {} } }),
            head: { appendChild: () => {} },
            getElementById: () => null,
        },
    });
    assert.equal(
        typeof b.exports.__findLastContentRow,
        'function',
        '选区的两个纯函数必须递出来给离线护栏跑',
    );

    const { __findLastContentRow: findLast, __clampSelectionTail: clamp } = b.exports;

    // —— 最后一行有内容: 空行不算, 中间的空行也不算"尾巴"(它只是被跳过了) ——
    const rows = ['alpha', 'beta', '', 'gamma-here', '', ''];
    const reader = (i) => rows[i];
    assert.equal(findLast(reader, rows.length - 1), 3, '第 3 行才是最后一行有内容');
    assert.equal(findLast(reader, 2), 1, '从第 2 行往上找: 第 2 行空, 落到第 1 行');
    assert.equal(
        findLast(() => '', 9),
        -1,
        '整屏都空 → -1(调用方据此什么都别做)',
    );
    assert.equal(
        findLast((i) => (i === 0 ? 'x' : ''), 5),
        0,
        '一路扫到第 0 行也要能找到',
    );

    // —— 尾巴收敛: 只动尾巴, 中间的空行与起点都不许动 ——
    const cols = 40;
    const beyond = { start: { x: 2, y: 0 }, end: { x: 20, y: 12 } };
    assert.deepEqual(
        clamp(beyond, 3, 10, cols, false),
        { column: 2, row: 0, length: 3 * cols + (10 - 2) },
        '尾巴越过内容底 → 收到第 3 行文字末尾(起点与行号都不变)',
    );
    assert.equal(
        clamp({ start: { x: 2, y: 0 }, end: { x: 7, y: 2 } }, 3, 10, cols, false),
        null,
        '尾巴本来就在内容里 → 不动(用户自己选的)',
    );
    assert.deepEqual(
        clamp({ start: { x: 3, y: 8 }, end: { x: 20, y: 13 } }, 3, 10, cols, false),
        { clear: true },
        '整段都拖在空白里 → 清掉(那儿一个字都没有)',
    );
    assert.equal(
        clamp({ start: { x: 2, y: 0 }, end: { x: 5, y: 3 } }, 3, 10, cols, false),
        null,
        '尾巴**正好贴**在内容底但没被挡过 → 不许补(那是双击选词 / 用户就要选到这一列)',
    );
    assert.deepEqual(
        clamp({ start: { x: 2, y: 0 }, end: { x: 5, y: 3 } }, 3, 10, cols, true),
        { column: 2, row: 0, length: 3 * cols + (10 - 2) },
        '被边界挡过时同样贴在那儿 → 补到文字末尾(实测: 不补会把 gamma-here 截成 gamma-h)',
    );
    assert.equal(
        clamp({ start: { x: 2, y: 0 }, end: { x: 10, y: 3 } }, 3, 10, cols, true),
        null,
        '已经到文字末尾了就不用再补',
    );
    assert.equal(clamp(beyond, -1, 10, cols, false), null, '一行内容都没有时不动选区');
    assert.equal(clamp(beyond, 3, 10, 0, false), null, 'cols 不合理时不动选区');
    assert.equal(clamp(null, 3, 10, cols, false), null, '没有选区时不动');

    // —— 行号算法: 必须与 xterm 的 getCoords 同款(1 基 + 越界夹住), 否则"内容下方"这条边界会错半行 ——
    const { __mouseRowAt: rowAt } = b.exports;
    assert.equal(rowAt(100, 100, 160, 16, 0), 0, '正好压在上边缘 = 第 0 行');
    assert.equal(rowAt(109, 100, 160, 16, 0), 0, '第 0 行里任意位置都是第 0 行');
    assert.equal(
        rowAt(110, 100, 160, 16, 0),
        0,
        '正好压在两行交界上仍算上一行(xterm 用 ceil, 边界归上面那行)',
    );
    assert.equal(rowAt(110.5, 100, 160, 16, 0), 1, '越过交界才跨行');
    assert.equal(rowAt(100 + 160 + 50, 100, 160, 16, 0), 15, '拖到容器外面 → 夹到最后一行');
    assert.equal(rowAt(0, 100, 160, 16, 0), 0, '拖到容器上面 → 夹到第一行');
    assert.equal(rowAt(109, 100, 160, 16, 300), 300, '滚动过的视口: 第 0 行 = viewportY');
    assert.equal(rowAt(110.5, 100, 160, 16, 300), 301, '滚动过的视口要加上 viewportY(绝对行号)');
    assert.equal(rowAt(110, 100, 0, 16, 0), -1, '容器没布局 → -1(调用方什么都别做)');
    assert.equal(rowAt(110, 100, 160, 0, 0), -1, 'rows 不合理 → -1');
    assert.ok(styles.length === 0, '这里不需要注入样式');
});

check('fge: git 页签上下两栏(上栏 3/4)+ 按目录归类 + 提交说明折叠两行', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    // 上栏(变更列表 / 当前 diff)默认占正文 3/4 —— 常量是唯一出处, 别在别处再写一个 75。
    assert.match(source, /GIT_SPLIT_DEFAULT = 75/, '上栏默认占比必须是 3/4(75)');

    // 两栏各滚各的 + 中间一条可拖的拖柄(直接看**注入出去的 CSS**, 拼法绕不过去)。
    const styles = [];
    const b = loadBundle('lib/client.js', {
        documentOverrides: {
            getElementById: () => null,
            createElement: (tag) =>
                tag === 'style'
                    ? { id: '', textContent: '', setAttribute: () => {}, appendChild: () => {} }
                    : { style: {}, setAttribute: () => {}, appendChild: () => {} },
            head: { appendChild: (el) => styles.push(String(el.textContent || '')) },
        },
    });
    const css = styles.join('\n');
    assert.match(
        css,
        /\.fge-body\{[^}]*display:flex[^}]*flex-direction:column/,
        '.fge-body 应是上下两栏的竖排 flex 容器',
    );
    assert.match(css, /\.fge-pane\{[^}]*overflow:auto/, '两栏要各自滚动(不能再是一个大滚动容器)');
    assert.match(css, /\.fge-grip\{[^}]*cursor:ns-resize/, '中间要有可拖的分栏拖柄');
    // 分栏拖柄与终端抽屉上缘那条**同一口径**: 不许有 hover 底色。它也是一整条 5px 通宽横带, 一亮就是
    // 一整条, 而这里夹在两块长得很像的列表之间, 变色会被读成"这条跟别处不是一个颜色"。
    // 可拖的提示交给 `cursor:ns-resize`; 底色必须显式常驻 `transparent`。
    assert.ok(!/\.fge-grip:hover/.test(css), '分栏拖柄不许有 hover 底色(与终端上缘拖柄同口径)');
    assert.match(css, /\.fge-grip\{[^}]*background:transparent/, '分栏拖柄底色应恒为 transparent');
    assert.match(css, /\.fge-dir\{/, '目录行样式缺了');

    // ---- 滚动条不许造成"形变" ----
    // 两栏各自滚动 ⇒ 滚动条一出现就挤掉内容宽度, 整栏抽一下(用户口径的"形变")。
    // 用户口径的最终形态是**两栏都不显示滚动条**: 于是滚动条从不占位、内容宽度恒定,
    // 形变从根上没了, 当初那条 `scrollbar-gutter:stable` 留白也就成了死代码(它本来就是给滚动条占位的)。
    // ⚠ 只能**两条一起**隐藏: 只藏一条会让两栏内容宽度差 8px, 两个列表的右缘 / 截断点当场错开。
    assert.match(
        css,
        /\.fge-pane\{[^}]*scrollbar-width:none/,
        '两栏都不显示滚动条(标准属性那条路)',
    );
    assert.match(
        css,
        /\.fge-pane::-webkit-scrollbar\{display:none\}/,
        'Chromium 走的是 ::-webkit-scrollbar 那条路, 两行都要写',
    );
    assert.ok(
        !/\.fge-pane\{[^}]*scrollbar-gutter:stable/.test(css),
        '两栏已经没有滚动条, 留白是死代码, 应当去掉',
    );
    // 展开态的说明**自己那条**要留着: 那是"该滚的那一条"(用户口径: 滚动条出现在这一段里)。
    assert.match(
        css,
        /\.fge-msg-text:not\(\[data-clamp="1"\]\)\{[^}]*max-height:[^}]*overflow:auto/,
        '展开态的说明要**自己滚**(限高), 不能把整栏撑长',
    );
    assert.match(
        css,
        /\.fge-msg-text:not\(\[data-clamp="1"\]\)\{[^}]*scrollbar-gutter:stable/,
        '说明自己出滚动条时, 里面的文字宽度也不许变',
    );
    // 开关左对齐 = 它的 x 与容器宽度无关(右对齐会随滚动条 / 右栏拖宽漂移)。
    assert.match(css, /\.fge-msg-bar\{[^}]*text-align:left/, '开关左对齐, 位置才与容器宽度无关');

    // ---- 分支按钮撑满到 ⟳ 之前 ----
    assert.match(css, /\.fge-branch\{[^}]*flex:1 1 auto/, '分支按钮要吃掉头部剩余空间');
    assert.ok(
        !/\.fge-branch\{[^}]*max-width:11em/.test(css),
        '分支按钮不再卡 max-width(用户口径: 加长到 fge-btn 前面)',
    );
    assert.match(css, /\.fge-branch-name\{[^}]*min-width:0/, '按钮里那格名字要能省略号');

    // ---- 刷新键 = 官方 SVG 图标, 不再是 `⟳` 文字字形 ----
    // 同一个码位在不同平台 / 字体回退下画出来的粗细和大小都不一样(Windows 上明显偏细偏小),
    // 与旁边那些官方图标(分支 / 上下游箭头)不是一个画风 —— 换成 `primitives.IconRefreshOutline14`。
    assert.match(
        source,
        /IconRefreshOutline14/,
        '刷新键要用官方 SVG 图标(primitives.IconRefreshOutline14)',
    );
    assert.ok(
        !/['"]⟳['"]/.test(source),
        '刷新键不许再退回 `⟳` 字形(平台字体回退画出来不一样, 与官方图标不搭)',
    );
    // 忙时的进度提示: 按钮在 busy 时本就是 `disabled`, 图标借这个状态自转 —— 原来那个 `…` 不能再和图标并存。
    assert.match(
        css,
        /\.fge-refresh\[disabled\] svg\{animation:fge-spin 1s linear infinite\}/,
        'busy(disabled)时图标要转起来当"正在 fetch"的提示',
    );
    assert.match(
        css,
        /@keyframes fge-spin\{to\{transform:rotate\(360deg\)\}\}/,
        '要有那段 keyframes, 否则上面那条动画名是空的',
    );

    assert.equal(
        (source.match(/className: 'fge-spacer'/g) || []).length,
        1,
        '头部不再放 .fge-spacer(只剩终端标题条那一处), 否则会和弹性按钮平分空白',
    );

    // 提交说明: 折叠态**只两行**, 放不下才有「展开 / 收起」(不然一段多行 message 能占掉半屏)。
    assert.match(
        css,
        /\.fge-msg-text\[data-clamp="1"\]\{[^}]*-webkit-line-clamp:2/,
        '提交说明折叠态必须夹在两行',
    );
    assert.match(css, /\.fge-msg-toggle\{/, '放不下时要给「展开 / 收起」');
    assert.ok(
        /scrollHeight > el\.clientHeight/.test(source),
        '「放不下」要**量**出来, 不能按行数猜(一行很长的 subject 折行后同样得给出口)',
    );
    // 开关画在**文字上方**: 展开后原地不动, 不用拉滚动条去找「收起」(用户口径)。
    const barAt = source.indexOf("className: 'fge-msg-bar'");
    const textAt = source.indexOf("className: 'fge-msg-text'");
    assert.ok(barAt !== -1 && textAt !== -1, '说明块应同时有 .fge-msg-bar 与 .fge-msg-text');
    assert.ok(
        barAt < textAt,
        '「展开 / 收起」必须在说明文字**之前**渲染 —— 否则展开后按钮跑到最底下',
    );
    // 下栏(提交历史 / 聚焦提交)最多 60% ⇒ 上栏的下限由这个上限反推(100 - 60 = 40)。
    assert.match(source, /GIT_SPLIT_BOTTOM_MAX = 60/, '下栏最多占 60%(用户口径)');
    assert.match(
        source,
        /GIT_SPLIT_MIN = 100 - GIT_SPLIT_BOTTOM_MAX/,
        '上栏下限要从 60% 反推, 不要写死两个互相打架的数',
    );

    // 标题栏: 去 opacity + 换实色底 —— 浅色下 `bg-base` 就是面板自己的纯白, 再叠 0.72 的不透明度,
    // 滚上来的行就透过去了(用户报的"文字内容会出现在 fge-section 下层")。
    assert.ok(
        !/\.fge-section\{[^}]*opacity:/.test(css),
        '标题栏不得再用 opacity(会把下面滚动的行透出来)',
    );
    assert.match(
        css,
        /\.fge-section\{[^}]*border-bottom:\.5px solid var\(--dsw-alias-border-l3\)/,
        '标题栏下边线用官方那套 .5px border-l3(明暗自动翻转)',
    );
    // ⚠ 不透明契约(实测教训): `--dsw-alias-markdown-tag` 是**标签/芯片的填充色**, 语义上就是一层淡强调色 ——
    //   官方两套主题恰好定成实色, 但由强调色派生的主题会把它做成半透明(本机 Sage Mist 就是
    //   `rgba(135,186,129,0.14)`)。直接拿它当 background, 横条就是透的, 滚上来的行照样穿过去。
    //   所以: 底座只能是实色的**面**(bg-base), 强调色只许作为 background-image 叠在它上面。
    const sectionRule = (css.match(/\.fge-section\{[^}]*\}/) || [''])[0];
    assert.match(
        sectionRule,
        /background-color:var\(--dsw-alias-bg-base/,
        '横条底座要用面板自己的实色(bg-base)—— 它按构造一定不透明',
    );
    assert.match(
        sectionRule,
        /background-image:linear-gradient\(var\(--dsw-alias-markdown-tag/,
        '强调色只能作为叠加层(background-image), 这样它半透明也不影响挡不挡得住',
    );
    assert.ok(
        !/background:var\(--dsw-alias-markdown-tag/.test(sectionRule),
        '不要直接把强调色当 background —— 主题可以把它定成半透明',
    );
    // 热重载时旧 <style> 必须被换掉: 直接 return 会把旧 CSS 留在页面上, 改样式的人会以为"没生效"。
    assert.match(
        source,
        /getElementById\(id\)[\s\S]{0,140}?old\.remove\(\)/,
        'ensureStyles 要换掉旧 <style>(热重载不刷新页面时, 直接 return 会留旧 CSS)',
    );
    assert.ok(
        !/\.fge-section\{[^}]*rgba\(128,128,128/.test(css),
        '标题栏不要再写死 rgba(128,128,128,…)',
    );

    // 层级线: 1px 虚线(官方没有先例, 最近的 subagent 树是 .5px 实线; 而 .5px 虚线会碎成看不见)。
    assert.match(
        css,
        /\.fge-guide\{[^}]*border-left:1px dashed var\(--dsw-alias-border-l2\)/,
        '层级线应是 1px 虚线 + border-l2',
    );
    assert.match(css, /\.fge-guide\[data-part="top"\]\{bottom:50%\}/, '最后一个子项那一列收到行中');
    assert.match(
        css,
        /\.fge-guide\[data-part="bottom"\]\{top:50%\}/,
        '有子项的目录那一列从行中起头',
    );
    assert.match(
        css,
        /\.fge-row\{[^}]*position:relative/,
        '行要 position:relative, 层级线才挂得住',
    );

    // 聚焦提交: 下栏接管 + 容器感 + 返回键 + Esc 分层。
    assert.match(
        css,
        /\.fge-pane-bottom\[data-focus="1"\]\{background:color-mix\(in srgb, var\(--dsw-alias-brand-primary\)/,
        '聚焦态整栏要有一层极淡的品牌色底(容器感)',
    );
    // 聚焦态下栏的滚动条由 `.fge-pane` 那条统一处理(两栏都不显示), 这里不再有单独的规则。
    assert.match(css, /\.fge-hash\{/, 'hash 胶囊样式缺了');
    assert.ok(/focusCommit\(/.test(source), '点提交应当**聚焦**(下栏接管), 不再就地展开');
    assert.ok(!/toggleCommit/.test(source), '就地展开那套(toggleCommit)应已退场');
    assert.ok(!/withExpanded/.test(source), '就地展开那套(withExpanded)应已退场');
    assert.match(source, /fge-back/, '聚焦视图要有返回键');
    assert.match(source, /focusEsc/, 'Esc 返回要接进 apply 里那条唯一的 keydown 分层');
    assert.match(
        source,
        /scrollBefore\.current = pane === null \? 0 : pane\.scrollTop/,
        '进聚焦前要记下列表的滚动位置(用户口径: 返回别丢你翻到哪儿了)',
    );
    assert.match(
        source,
        /restoreScroll\.current = true/,
        '返回时还原滚动位置 —— 且只在"刚返回"那一次(重挂不该按陈旧值把列表跳走)',
    );

    // hash 胶囊: 复制的是**完整** hash, 且必须先 stopPropagation(否则连带进聚焦)。
    const chipAt = source.indexOf('function HashChip');
    const chip = chipAt === -1 ? '' : source.slice(chipAt, chipAt + 1600);
    assert.ok(chip !== '', '应有 HashChip 组件');
    assert.ok(
        /stopPropagation\(\)[\s\S]{0,120}writeClipboard\(props\.hash\)/.test(chip),
        'hash 胶囊的点击必须先 stopPropagation、再复制**完整** hash',
    );

    // 按目录归类: 纯函数(见 exports.__pathTree —— 浏览器 bundle 不能 require 本包的模块)。
    const tree = b.exports.__pathTree;
    assert.ok(tree !== undefined, '应暴露 __pathTree 供离线校验');
    const built = tree.compact(tree.build(['a/a1.txt', 'a/a2.txt', 'a/deep/x/y.txt'], (p) => p));
    // `a/` 只出现一次目录行, 两个文件是它的 basename —— 不是平铺 a/a1.txt、a/a2.txt。
    assert.deepEqual(
        built.dirs.map((d) => d.name),
        ['a'],
    );
    assert.deepEqual(
        built.dirs[0].files.map((f) => f.name),
        ['a1.txt', 'a2.txt'],
    );
    assert.deepEqual(
        built.dirs[0].files.map((f) => f.path),
        ['a/a1.txt', 'a/a2.txt'],
        '完整路径要留着(diff 请求与 key 都用它)',
    );
    // 单链目录压成一行: a/deep/x/y.txt → 目录行 `deep/x`(否则一个文件白吃三行)。
    assert.deepEqual(
        built.dirs[0].dirs.map((d) => d.name),
        ['deep/x'],
    );
    assert.deepEqual(
        built.dirs[0].dirs[0].files.map((f) => f.name),
        ['y.txt'],
    );
    // 根下的散文件不缩进, 且排在目录之后(目录在前、文件在后)。
    const flat = tree.compact(tree.build(['b.txt', 'a/a1.txt'], (p) => p));
    assert.deepEqual(
        flat.files.map((f) => f.name),
        ['b.txt'],
    );
    assert.deepEqual(
        flat.dirs.map((d) => d.name),
        ['a'],
    );

    // ---- 层级线(纵向虚线): 一格一格算出来的, 最容易差一位 ----
    const guides = tree.guides;
    assert.equal(typeof guides, 'function', '应暴露 guides 纯函数供离线校验');
    const hs = (depth, continues, isLast, kids) =>
        guides({ depth, isLast, continues }, kids).map((s) => s.part);
    const xs = (depth, continues, isLast, kids) =>
        guides({ depth, isLast, continues }, kids).map((s) => s.x);
    // 顶层没有"父那一列"; 顶层文件一条线都没有。
    assert.deepEqual(hs(0, [], true, false), []);
    // 有子项的目录: 自己那一列从**行中**起头(从文件夹图标连下去); x 落在图标中心(15 = 9 + 12/2)。
    assert.deepEqual(hs(0, [], false, true), ['bottom']);
    assert.deepEqual(xs(0, [], false, true), [15]);
    // 深度 1: 父那一列由"我是不是最后一个子项"决定; 自己还有子项再加下半格。
    assert.deepEqual(hs(1, [], false, true), ['full', 'bottom']);
    assert.deepEqual(xs(1, [], false, true), [15, 27]);
    assert.deepEqual(hs(1, [], true, false), ['top']);
    // 深度 2: continues[0] 说的是"第 1 层祖先还有后续兄弟" → 那一列要继续贯穿本行。
    assert.deepEqual(hs(2, [true], true, false), ['full', 'top']);
    assert.deepEqual(xs(2, [true], true, false), [15, 27]);
    // 反过来: 祖先已经是最后一个子项 → 那一列早就收住了, 本行不该再出现。
    assert.deepEqual(hs(2, [false], true, false), ['top']);
    assert.deepEqual(xs(2, [false], true, false), [27]);

    // ---- 真跑一遍整棵树(不是 grep 源码)----
    //
    // ⚠ 这一条是补事故的: 上一版的顶层调用把 `[]` 传进了 `makeFileRow` 那一格, 而"按目录归类"只在
    //   **有目录**时才走到那条分支, 于是 grep 式护栏完全没拦住 —— 真渲染时直接 TypeError。
    //   现在顶层只有 `treeRows.root(tree, keyPrefix, makeFileRow)` 三个参数, 并在这里**真的调用**。
    const buildTreeRows = b.exports.__treeRows;
    assert.equal(typeof buildTreeRows, 'function', '应暴露 __treeRows(注入 h 的行数组工厂)');
    const rows = buildTreeRows((type, props, ...kids) => ({ type, props, kids }));
    const flattened = rows.root(
        tree.compact(tree.build(['a/a1.txt', 'b/b1.txt', 'z.txt'], (p) => p)),
        'c:',
        (file, pos) => ({
            kind: 'file',
            name: file.name,
            depth: pos.depth,
            isLast: pos.isLast,
            continues: pos.continues.slice(),
        }),
    );
    const shape = flattened.map((row) =>
        row.kind === 'file' ? row.name : 'dir:' + row.props.title,
    );
    assert.deepEqual(
        shape,
        ['dir:a', 'a1.txt', 'dir:b', 'b1.txt', 'z.txt'],
        '目录在前、文件在后, 且每个目录的子项紧跟它',
    );
    assert.deepEqual(
        flattened.filter((r) => r.kind === 'file').map((r) => [r.name, r.depth, r.isLast]),
        [
            ['a1.txt', 1, true],
            ['b1.txt', 1, true],
            ['z.txt', 0, true],
        ],
        '文件行的深度 / 是不是最后一个子项',
    );
    assert.deepEqual(
        flattened.filter((r) => r.kind === 'file').map((r) => r.continues),
        [[true], [true], []],
        'a / b 都还有兄弟 ⇒ 它们那一列要继续贯穿下去; 顶层没有祖先列',
    );
    // 有子项的目录自带一段"下半格"引导线, 线就吊在文件夹图标下面。
    const dirRow = flattened[0];
    const dirGuides = dirRow.kids[0];
    assert.equal(dirRow.props.className, 'fge-dir');
    assert.equal(dirRow.props.style.paddingLeft, '9px', '顶层目录不缩进');
    assert.deepEqual(
        dirGuides.map((g) => [g.props['data-part'], g.props.style.left]),
        [['bottom', '15px']],
        '目录行自己那一列从行中起头、x 落在文件夹图标中心',
    );

    // 两个顶层调用点都必须走三参数的 `root` —— 老的 4/5 位置参数写法一个都不许留。
    assert.match(source, /changeRows = treeRows\.root\(/, '变更列表要走 treeRows.root(三参数)');
    assert.match(
        source,
        /focusRows = focusRows\.concat\(\s*treeRows\.root\(/,
        '聚焦提交里的文件清单要走 treeRows.root',
    );
    assert.ok(
        !/treeRows\(/.test(source),
        '不许再出现 `treeRows(...)` 的位置参数写法(顶层一律 treeRows.root)',
    );
    assert.equal(
        (source.match(/treeRows\.root\(/g) || []).length,
        2,
        '顶层恰好两处: 变更列表 + 聚焦提交里的文件清单(多一份列表就得在这里显式加一条)',
    );
});

check('fge: 右侧栏默认铺「文件」+「Git」两格, Git 是活动那格', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    // 用户口径: **git 侧栏也像文件侧栏一样默认打开**。一次 seed 里先开官方「工作区文件」、
    // 再开本插件的「Git」—— 后开的那格成为活动页签, 于是打开右栏直接是变更列表。
    // (带 params 的 `openTab(DIFF_KIND, {...})` 用的是逗号, 不会被这条正则收进来。)
    const calls = [...source.matchAll(/ctx\.sidebarRight\.openTab\(([A-Z_]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(
        calls,
        ['FILES_KIND', 'GIT_KIND'],
        '默认页签应恰好铺「文件」+「Git」这一对, 且 Git 在后(= 活动格)',
    );
});

// ---- 终端 16 色 ANSI 调色板: 与终端面的**对比度**(纯计算, 不用浏览器) ----
//
// 补的是这起事故: 只设 `background` / `foreground` 时, xterm 会用**内置的默认调色板**, 而那是为**深色背景**
// 设计的 —— 亮白 `#ffffff` / 亮黄 `#ffff00` 落到浅色终端面上几乎看不见(用户报的"字体高亮导致看不清");
// 更糟的是 `drawBoldTextInBrightColors` 默认开着, **加粗**的字会切到那排亮色上。所以调色板必须自己给,
// 并且在这里逐个颜色算对比度 —— 这是"看得清"唯一可离线度量的判据。
function srgbChannel(v) {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (m === null) throw new Error('不是 6 位 hex: ' + String(hex));
    const n = parseInt(m[1], 16);
    return (
        0.2126 * srgbChannel((n >> 16) & 255) +
        0.7152 * srgbChannel((n >> 8) & 255) +
        0.0722 * srgbChannel(n & 255)
    );
}
/** WCAG 对比度: (亮的 + .05) / (暗的 + .05)。 */
function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

check('fge: 终端 16 色 ANSI 调色板与终端面的对比度达标(看得清)', () => {
    const b = loadBundle('lib/client.js');
    const palette = b.exports.__terminalPalette;
    assert.equal(typeof palette, 'function', '应暴露 __terminalPalette 供离线校验');
    // 真机上出现过的三种终端面: 官方浅色 / 本机主题(Sage Mist)浅色 / 官方深色。
    const surfaces = [
        { label: '官方浅色', hex: '#f9fafb', dark: false },
        { label: '本机主题浅色', hex: '#E4EAE0', dark: false },
        { label: '官方深色', hex: '#1b1b1c', dark: true },
    ];
    const measured = [];
    for (const surface of surfaces) {
        const p = palette(surface.dark);
        const keys = Object.keys(p);
        assert.equal(keys.length, 16, surface.label + ' 下应当是 16 色 ANSI 调色板');
        for (const key of keys) {
            assert.match(p[key], /^#[0-9a-f]{6}$/i, key + ' 应是 6 位 hex(xterm 要具体颜色)');
            const ratio = contrast(p[key], surface.hex);
            // 深色的 `black` 是约定的"暗淡槽", 放宽到 3:1;其余一律按 WCAG AA 正文的 4.5:1。
            const floor = surface.dark && key === 'black' ? 3 : 4.5;
            measured.push({ where: surface.label, key, ratio, floor });
            assert.ok(
                ratio >= floor,
                surface.label +
                    ' 下 ' +
                    key +
                    ' = ' +
                    p[key] +
                    ' 对比度只有 ' +
                    ratio.toFixed(2) +
                    ':1(< ' +
                    floor +
                    ') —— 这就是"看不清"',
            );
        }
    }
    measured.sort((x, y) => x.ratio - y.ratio);
    console.log(
        '  调色板余量最紧的三个: ' +
            measured
                .slice(0, 3)
                .map((m) => m.where + '/' + m.key + ' ' + m.ratio.toFixed(2) + ':1')
                .join(' · '),
    );
});

check('fge: 右栏页签 Alt+J / Alt+L 切换(到边不环绕)', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    const b = loadBundle('lib/client.js');
    const next = b.exports.__tabNeighbor;
    assert.equal(typeof next, 'function', '应暴露 __tabNeighbor 供离线校验');

    // 用户口径的"不做无限切换": 到边返回 -1(调用方据此什么都不做), 而不是绕回另一端。
    assert.equal(next(0, 2, -1), -1, '在最左还往左 → 不切(不环绕)');
    assert.equal(next(1, 2, 1), -1, '在最右还往右 → 不切(不环绕)');
    assert.equal(next(0, 2, 1), 1, '左 → 右');
    assert.equal(next(1, 2, -1), 0, '右 → 左');
    // 三个格子时中间那个两个方向都能走。
    assert.equal(next(1, 3, 1), 2);
    assert.equal(next(1, 3, -1), 0);
    assert.equal(next(0, 3, -1), -1);
    assert.equal(next(2, 3, 1), -1);
    // 只有一格 / 没有选中格子时都不动。
    assert.equal(next(0, 1, 1), -1, '只有一格 → 不动');
    assert.equal(next(-1, 3, 1), -1, '没找到选中格 → 不动');

    // 接线: 必须是 Alt+J / Alt+L、走 DOM 的选中格 + sidebarRight.focus, 且该让的都让开。
    assert.match(
        source,
        /if \(!ev\.altKey \|\| ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.shiftKey\) return;/,
        '只吃纯 Alt(不带 ctrl/meta/shift)',
    );
    assert.match(source, /ev\.key === 'j' \|\| ev\.key === 'J' \? -1/, 'Alt+J 必须是"左一格"');
    assert.match(source, /ev\.key === 'l' \|\| ev\.key === 'L' \? 1/, 'Alt+L 必须是"右一格"');
    assert.match(
        source,
        /\[data-sidebar-right-panel\] \[data-dockkit-tab\]\[aria-selected="true"\]/,
        '要按页签条上真正选中的那一格算左右邻居(与 rememberUserTab 同一条 DOM 契约)',
    );
    assert.match(source, /ctx\.sidebarRight\.focus\(id\)/, '切过去要用 sidebarRight.focus');
    assert.match(
        source,
        /fge-term-host[\s\S]{0,120}host\.contains\(active\)/,
        '焦点在终端里时让给终端',
    );
    assert.match(source, /data-rightbar-collapsed/, '右栏收起时不切(切了也看不见)');
});

check('fge: Alt+Ctrl+R 刷新 git 树(与 ⟳ 同一条)+ 打开抽屉自动聚焦终端', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');

    // —— Alt+Ctrl+R: 一个动作只有一个入口 ——
    // 快捷键必须与页签上那枚 `⟳` 指向**同一个** manualRefresh, 不是另写一套刷新逻辑。
    assert.match(
        source,
        /var gitRefresh = \{ current: null \};/,
        '要有模块级的刷新回调位(apply 那条全局 keydown 才够得着页签体里的 manualRefresh)',
    );
    assert.match(
        source,
        /gitRefresh\.current = manualRefresh;/,
        'Alt+Ctrl+R 与 `⟳` 必须是同一个 manualRefresh',
    );
    assert.ok(
        !/gitRefresh\.current = busy \? null/.test(source),
        '不许因为 busy 就不注册 —— "按了完全没反应"比"按了但忙"更难排查(manualRefresh 自己会早退)',
    );
    assert.match(
        source,
        /gitRefresh\.current = null;[\s\S]{0,80}\n {8}\}\);/,
        '卸载时要清掉 —— 留着陈旧闭包会把上一个会话的工作区再刷一遍',
    );
    // 取 Alt+Ctrl+R 那一段(注释到 effect 标签之间就是整个 effect), 逐条按它的边界断言。
    const from = source.indexOf('// git 树刷新: **Alt+Ctrl+R**');
    assert.ok(from > 0, '应有 Alt+Ctrl+R 的刷新快捷键');
    const hotkey = source.slice(from, source.indexOf("'fge: alt+ctrl+r refresh git tree'", from));
    assert.ok(hotkey.length > 0, 'Alt+Ctrl+R 的 ctx.effect 要有标签');
    assert.match(
        hotkey,
        /if \(!ev\.altKey \|\| !ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.shiftKey\) return;/,
        '必须是 Alt+Ctrl, 且不带 meta/shift',
    );
    assert.match(
        hotkey,
        /ev\.key === 'r' \|\| ev\.key === 'R' \|\| ev\.code === 'KeyR'/,
        '要认 r/R/KeyR',
    );
    assert.match(
        hotkey,
        /window\.addEventListener\('keydown', onKey, true\)/,
        '要挂 window 的**捕获**阶段(官方快捷键也在捕获; window 比 document 更靠前)',
    );
    assert.match(hotkey, /ev\.preventDefault\(\);/, '认下了就要吃掉这次按键');
    assert.match(
        hotkey,
        /ev\.stopPropagation\(\);/,
        '还要拦住传播 —— 否则这一按会落到 xterm 变成发给 PTY 的字节(它现在连终端焦点也不放过)',
    );
    assert.ok(
        !/fge-term-host/.test(hotkey),
        'Alt+Ctrl+R **不再**让给终端: 终端侧没有这组绑定, 加 Ctrl 就是为了能从任何焦点触发',
    );
    assert.match(
        hotkey,
        /gitRefreshPending\.current = true;[\s\S]{0,200}ctx\.sidebarRight\.focus\(GIT_ID\)/,
        '页签体没挂载时: 记一笔 + 切到 Git 页签, 别干等',
    );
    assert.match(
        source,
        /gitRefreshPending\.current = false;[\s\S]{0,40}manualRefresh\(\);/,
        '挂载时要把那一笔兑现(一次性), 否则快捷键只在"正看着 git"时才灵',
    );

    // —— 打开抽屉自动聚焦终端 ——
    // 位置很关键: xterm 的 focus() 是打到它自己那个隐藏 textarea 上的, `open()` 之前调等于没调。
    const openAt = source.indexOf('term.open(hostRef.current);');
    const focusAt = source.indexOf('term.focus();');
    assert.ok(openAt > 0, '终端要 open');
    assert.ok(focusAt > openAt, 'focus() 必须在 open() **之后**(元素没挂上就没有焦点可给)');
    assert.equal(
        source.split('term.focus();').length - 1,
        1,
        '只该聚焦一次(不要在每次渲染里抢焦点 —— 用户点去 composer 打字后不该被抢回来)',
    );
    assert.match(
        source.slice(focusAt, focusAt + 220),
        /catch \(e\)/,
        '拿不到焦点要吞掉, 不能让整个终端挂掉',
    );
});

check('fge: 详情标题加长 + 文件名点击复制', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');

    // —— 详情标题的宽度: 真因是**夹着标题的那个页签**被官方钉死, 不是标题自己 ——
    // 官方 `._tab_…{min-width:80px;max-width:170px}`。⚠ 三个都踩过的坑:
    //   ① 标题 `[data-dockkit-tab-title]` 自己没有 max-width, 改它是**空操作**;
    //   ② 浮窗里那格**不带 `data-dockkit-tab`**(实测: 开着详情时只有「文件」「Git」两格带它),
    //      所以按 `[data-dockkit-tab][class*="_floatTitle_"]` 选**匹配不到浮窗**;
    //   ③ 但浮窗那格**确实**带 `_floatTitle_`(官方是 `Ce(me.tab, me.floatTitle)`), 只是 ② 那个条件多余。
    //   ⇒ 两条各自独立生效的钩子: "谁夹着标题"(类名变了也还在) + 官方那格自己的类。
    assert.match(
        source,
        /'\[class\*="_float_"\] \*:has\(> \[data-dockkit-tab-title\]\)\{max-width:none!important\}'/,
        '要按"标题的父元素"放开浮窗里那格(浮窗那格没有 data-dockkit-tab, 按它选会漏)',
    );
    assert.match(
        source,
        /'\[class\*="_floatTitle_"\]\{max-width:none!important\}'/,
        '再留一条锚在官方类名上的独立钩子(不依赖 :has)',
    );
    assert.ok(
        !/'\[data-dockkit-tab\]\[class\*="_floatTitle_"\]\{max-width:none!important\}'/.test(
            source,
        ),
        '浮窗那格没有 data-dockkit-tab, 带这个条件的选择器永远匹配不到 —— 别再退回去',
    );
    assert.ok(
        !/\{max-width:none!important;min-width:0;flex:1 1 auto\}/.test(source),
        '标题元素本来就没有 max-width, 别再给它加那条空操作(真因在夹着它的那格上)',
    );
    assert.match(
        source,
        /\.fge-chip-label\{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/,
        'diff 芯片也不许自己钉 max-width(22em)—— 浮窗有地方时它会把路径先截掉',
    );
    assert.ok(!/\.fge-chip-label\{[^}]*max-width/.test(source), '同样的病不要在另一条路径上留着');

    // —— 文件名点击复制 ——
    // 复制的必须是**文件名本身**; 判定"这算点击"不能靠 `onClick`: 页签条与浮窗头部都在 pointerdown 时对
    // **自己** `setPointerCapture`(官方 `onTabPressed` / `data-dockkit-float-grip` 那条 header),
    // 之后 mouse/click 全被重定向到捕获元素 —— 官方自己的 onClick 照常触发(它就是捕获元素), 而更深的
    // 子元素**永远收不到**(实测 click 计数 0, 连自身 pointerup 也是 0)。所以只能挂窗口级 pointerup 自己结算。
    assert.match(
        source,
        /h\(DocName, \{ name: title \}\)/,
        '影子页签(文档详情)里的文件名要走 DocName(不是裸字符串)',
    );
    assert.match(
        source,
        /h\('span', \{ className: 'fge-chip-label', title: label \}, h\(DocName, \{ name: label \}\)\)/,
        'diff 详情那条路径(显示的是路径)也要能给点击复制',
    );
    const fnAt = source.indexOf('function DocName(props)');
    assert.ok(fnAt > 0, '应有 DocName');
    const body = source.slice(fnAt, source.indexOf('function FileCopyButton(', fnAt));
    assert.match(body, /primitives\.writeClipboard\(name\)/, '点击要复制**文件名**');
    assert.ok(
        !/\bonClick\b/.test(body),
        '不许用 onClick —— 官方那两处 setPointerCapture 会把子元素的 click 吃干净(实测计数 0)',
    );
    assert.match(body, /onPointerDown: onPointerDown/, '要自己记下"按下"那一下');
    assert.match(
        body,
        /window\.addEventListener\('pointerup', settle, true\)/,
        '结算必须挂在窗口(捕获阶段)—— 挂在元素上照样被 pointer capture 改掉目标',
    );
    assert.match(
        body,
        /window\.addEventListener\('pointercancel', settle, true\)/,
        '取消也要清掉按下态',
    );
    assert.match(
        body,
        /Math\.abs\(ev\.clientX - from\.x\) >= 4 \|\| Math\.abs\(ev\.clientY - from\.y\) >= 4/,
        '位移阈值要与官方拖拽起手判据(4px)逐字对齐, 否则拖页签会顺手复制',
    );
    assert.ok(
        !/stopPropagation|preventDefault/.test(body),
        '不许吃掉这次点击 —— 页签条里那一下还要用来选中页签(复制只是搭便车)',
    );
    assert.match(body, /className: 'fge-doc-name'/, '要有自己的类名(样式与护栏都按它找)');
    assert.match(body, /'data-s': state/, '反馈沿用 data-s = done / failed');
    assert.match(body, /setState\(ok === false \? 'failed' : 'done'\)/, '写入失败要能反馈(failed)');
    // ⚠ padding/margin 会给标题造出 2px 的假溢出, 而官方判断"要不要加右侧渐隐"的容差只有 1px
    //   (`scrollWidth > clientWidth + 1`)—— 于是**已经完整显示**的文件名会亮起渐隐。
    assert.match(
        source,
        /\.fge-doc-name\{cursor:pointer;border-radius:3px\}/,
        '文件名芯片不许自己带 padding/margin(会骗过官方那 1px 容差的渐隐判据)',
    );
    assert.ok(
        !/\.fge-doc-name\{[^}]*\b(padding|margin)\b/.test(source),
        '同上: 别把那条 padding/margin 加回来',
    );
    assert.match(
        source,
        /\.fge-doc-name\[data-s="done"\]\{color:#3fa34d\}/,
        '成功反馈只染色, 不换文字(换成"已复制"就看不见自己点的是哪个文件了)',
    );
});

check('fge: 详情浮窗的「全屏」开关(右栏页签条那枚仍然藏)', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');

    // 右栏页签条那枚「进全屏」: 位置放错过一轮 —— 用户要的是**详情面板**全屏, 不是右栏那一格。现在仍然藏。
    assert.match(
        source,
        /'\[data-sidebar-right-mode="fullscreen"\]\{display:none\}'/,
        '右栏页签条那枚「进全屏」不出现(全屏落在详情浮窗上)',
    );

    // 全屏开关只在**浮窗**里露面: 标题槽在页签条与浮窗头部两处都渲染, 所以默认藏、只有浮窗里放开。
    assert.match(source, /'\.fge-float-full\{display:none;/, '「全屏」按钮默认藏(页签条上不出现)');
    assert.match(
        source,
        /'\[data-dockkit-float\] \.fge-float-full\{display:inline-flex\}'/,
        '只在浮窗里放开它',
    );
    // 全屏几何: 官方没有移动/缩放浮窗的公开接口, 只能给浮窗打标记 + 用 !important 压掉它 inline 的几何。
    assert.match(
        source,
        /'\[data-dockkit-float\]\[data-fge-float-full\]\{inset:0!important;width:auto!important;height:auto!important;border-radius:0!important;z-index:50!important\}'/,
        '全屏态要 inset:0!important 压过官方 inline 的 left/top/width/height, 并把 20px 圆角归零',
    );
    assert.match(
        source,
        /'\[data-dockkit-float\]\[data-fge-float-full\] \[data-dockkit-float-resize\]\{display:none\}'/,
        '全屏时右下角那个缩放手柄没有意义',
    );

    const fnAt = source.indexOf('function FloatFullButton()');
    assert.ok(fnAt > 0, '应有 FloatFullButton');
    const body = source.slice(fnAt, source.indexOf('// ---- diff 页签', fnAt));
    assert.match(
        body,
        /h\(primitives\.IconFullscreenOutline16, \{ size: 14 \}\)/,
        '要用官方图标, 不自己画',
    );
    assert.match(body, /closest\('\[data-dockkit-float\]'\)/, '标记要打在**浮窗元素**上');
    assert.match(body, /setAttribute\('data-fge-float-full', ''\)/, '全屏 = 打标记');
    assert.match(body, /removeAttribute\('data-fge-float-full'\)/, '退出全屏 / 卸载要摘掉标记');
    assert.ok(
        /stopPropagation/.test(body),
        '必须吃掉 pointerdown —— 官方整条 header 是拖拽柄, 会 setPointerCapture 把子元素的 click 吞掉',
    );

    // 两条详情路径(文档详情 / diff 详情)都要有这枚按钮。
    const n = source.split('h(FloatFullButton, null)').length - 1;
    assert.ok(n >= 2, '文档详情与 diff 详情两条路径都要有(实际 ' + String(n) + ' 处)');
});

check('fge: 详情浮窗 Alt+滚轮 = 横向滚动', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    const at = source.indexOf('fge: alt+wheel scrolls the float sideways');
    assert.ok(at > 0, '应注册这条 effect');
    const body = source.slice(source.lastIndexOf('ctx.effect(', at), at);

    // ⚠ 被动监听里 preventDefault 会被忽略 —— 那样横滚的同时竖滚也会发生。
    assert.match(
        body,
        /window\.addEventListener\('wheel', onWheel, \{ capture: true, passive: false \}\)/,
        'wheel 监听必须显式 `passive: false`(否则 preventDefault 无效)',
    );
    assert.match(
        body,
        /if \(ev\.altKey !== true \|\| ev\.ctrlKey === true \|\| ev\.metaKey === true\) return;/,
        '只认 Alt; 带 Ctrl/Meta 的(浏览器缩放 / 系统手势)一概不碰',
    );
    assert.match(
        body,
        /float\.querySelector\('\[data-dockkit-float-title\] \.fge-doc-name'\) === null\) return;/,
        '只认本插件自己的详情浮窗(官方浮动宿主是所有页签共用的)',
    );
    assert.match(body, /box\.scrollLeft = next;/, '横滚要落到那个盒子上');
    // 先判"滚不动"再 preventDefault: 到边 / 无处可滚时放行, 否则滚轮会"失灵"。
    assert.match(
        body,
        /if \(next === box\.scrollLeft\) return;[\s\S]{0,120}ev\.preventDefault\(\)/,
        '要先判"滚不动"再 preventDefault(到边时放行给普通竖滚)',
    );
    assert.match(
        body,
        /window\.removeEventListener\('wheel', onWheel, \{ capture: true \}\)/,
        '卸载要摘干净',
    );
});

check('fge: worktree 切换器(主仓 / 各 worktree)', () => {
    const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8');
    const host = readFileSync(join(PLUGIN, 'lib/index.js'), 'utf8');
    const lib = readFileSync(join(PLUGIN, 'lib/git.js'), 'utf8');

    // host: 一条专用路由 + 可离线测的纯解析函数(夹具在 tests/git.test.mjs)。
    assert.match(host, /worktrees:\s*handleWorktrees/, 'host 要注册 /fge/api/worktrees');
    assert.match(
        host,
        /\['worktree', 'list', '--porcelain'\]/,
        '列工作区只能靠 `git worktree list`(不能由客户端报路径)',
    );
    assert.match(lib, /export function parseWorktreeList\(/, '解析器要是纯函数(离线可测)');

    // client: **只有 git 数据**跟着选中的 worktree 走(终端仍旧拿会话的 root), 且列表走专用路由。
    assert.match(
        source,
        /var dataRoot = worktreePath \|\| sessionCwd;/,
        'git 数据根 = 选中的 worktree, 否则会话工作区',
    );
    assert.match(
        source,
        /api\('info', dataRoot \? \{ root: dataRoot \} : \{\}\)/,
        '取数据要把这个根带上',
    );
    assert.match(source, /api\('worktrees', \{ root: reqRoot \}\)/, '列表走专用路由');
    assert.match(
        source,
        /workspaceKey\(res\.repoRoot\) !== workspaceKey\(worktreePath\)/,
        'worktree 被删 / prune 之后必须能识别出来并回落(否则按钮写着它、数据其实是主仓)',
    );
    assert.match(source, /setWorktreePath\(null\)/, '回落 = 清掉选中项');
    assert.match(source, /function pickWorktree\(entry\)/, '要有切换函数');
    assert.match(source, /className: 'fge-wt'/, '按钮要有自己的类名(样式与护栏都按它找)');
    assert.match(
        source,
        /var wtVisible = worktreePath !== null \|\| wtEntries\.length > 1;/,
        '平时不占位置: 只有仓库里存在别的 worktree 才露出按钮',
    );
    assert.match(
        source,
        /worktree: worktreePath,/,
        '选中项按会话记(与 viewedRef 同款存进 gitViews)',
    );
    assert.ok(
        !/'\.fge-wt\{[^}]*flex:1/.test(source),
        '切换器按钮不许也是弹性项 —— 弹性项只能有一个(分支那颗)',
    );
});

console.log('');
if (failures.length > 0) {
    console.error('client bundle 装配: ' + String(failures.length) + ' 项失败');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log('client bundle 装配: ' + String(passed) + ' 项检查全部通过');
