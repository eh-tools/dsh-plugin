/**
 * 静态插件的 client bundle 装配冒烟(无浏览器, 离线可跑)
 *
 * 运行: node scripts/verify-client-bundles.mjs
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
 * 在 stub 环境里加载一个 client bundle 并执行 apply()。
 * @param {string} relPath bundle 相对仓库根的路径
 * @param {object} [options] 需要更真的环境时给的覆盖项:
 *   `sidebarRight`(替掉空对象)、`documentOverrides`、`requireOverrides`、`timers`(收 setTimeout)、
 *   `listeners`(收 document.addEventListener)、`innerWidth`。
 * @returns {{id: string, exports: object, slots: Array, tabs: Array, requires: string[], react: object}}
 */
function loadBundle(relPath, options = {}) {
    const source = readFileSync(join(ROOT, relPath), 'utf8');
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
    const b = loadBundle('plugins/file-git-explorer/lib/client.js');

    check('fge: bundle id 与 inject', () => {
        assert.equal(b.id, 'dsh-file-git-explorer');
        assert.ok(b.exports.inject.includes('slots'), 'inject 应含 slots');
        assert.ok(b.exports.inject.includes('sidebarRightTabs'), 'inject 应含 sidebarRightTabs');
        assert.ok(
            b.exports.inject.includes('sidebarRight'),
            'inject 应含 sidebarRight(float/close)',
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
        const b = loadBundle('plugins/file-git-explorer/lib/client.js', {
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
    const b = loadBundle('plugins/file-git-explorer/lib/client.js', {
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
    const source = readFileSync(join(ROOT, 'plugins/file-git-explorer/lib/client.js'), 'utf8');
    // 头部高度: 官方页签条 0–38, 官方的「文件」页签头也是 38px ⇒ 底边线落在 y=76, 与会话头部
    // (`wSkVaW_header`)的底边线对齐。写成 padding 撑出来的高度会差 4px(实测 33.8px, 线在 y≈71.8)。
    assert.match(source, /\.fge-head\{[^}]*height:38px/, '.fge-head 必须是 38px 高(border-box)');
    assert.ok(
        !/\[data-side="rightbar"\]\{display:none\}/.test(source),
        '右栏拖柄不能再被 hiding —— 隐藏就没法拖',
    );
    // xterm 只认具体颜色: 传 rgba(0,0,0,0) 会被判无效并回落成它的默认黑,
    // 浅色主题下标题条(白)与终端体(黑)就断开, 看着就是"标题条错位"。
    assert.ok(
        !/background:\s*'rgba\(0,0,0,0\)'/.test(source),
        '终端 theme.background 必须给具体颜色(透明会被 xterm 丢掉 → 变纯黑)',
    );
    const b = loadBundle('plugins/file-git-explorer/lib/client.js');
    assert.ok(
        b.events.some((e) => e.name === 'theme/change'),
        '应订 theme/change: 主题切换时活着的终端要就地换色',
    );
});

check(
    'fge: 终端表面 code-block + 抽屉/舌跟对话区同宽 + 条无底色 + 滚动条 6px 圆角 + Alt+C 复制',
    () => {
        // 直接看**注入出去的 CSS**: 这几条规则是字符串拼出来的, 读源码文本容易被拼法绕过去。
        const styles = [];
        loadBundle('plugins/file-git-explorer/lib/client.js', {
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
        // 抽屉 / 抽屉舌的宽度 = 上方对话区宽度(`--dsh-chat-content-width`, 即 wSkVaW_widthHandle 拖出来的那个);
        // 座位本身是整条中栏, 不给 max-width 就会比 composer 卡片宽出一截。
        assert.match(
            css,
            /\.fge-term\{[^}]*max-width:var\(--dsh-chat-content-width,100%\)[^}]*margin-inline:auto/,
            '终端抽屉宽度要跟对话区一致(居中)',
        );
        assert.match(
            css,
            /\.fge-tongue\{[^}]*max-width:var\(--dsh-chat-content-width,100%\)/,
            '抽屉舌也要跟对话区同宽',
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
        // Alt+C = 复制终端选区(终端里原生复制不可用; Ctrl+C 必须留给 SIGINT, 所以走 Alt+C)。
        const source = readFileSync(join(ROOT, 'plugins/file-git-explorer/lib/client.js'), 'utf8');
        assert.match(source, /attachCustomKeyEventHandler/, '终端要挂自定义键处理(Alt+C 复制)');
        assert.match(source, /ev\.altKey/, 'Alt+C 复制要判 Alt 修饰键');
        assert.ok(
            !/ctrlKey && ev\.shiftKey/.test(source),
            '不要占用 Ctrl+Shift+C(那是浏览器/DevTools 的检查元素)',
        );
        assert.match(source, /writeClipboard/, '复制必须走 primitives.writeClipboard');
    },
);

check('fge: git 页签上下两栏(上栏 3/4)+ 按目录归类 + 提交说明折叠两行', () => {
    const source = readFileSync(join(ROOT, 'plugins/file-git-explorer/lib/client.js'), 'utf8');
    // 上栏(变更列表 / 当前 diff)默认占正文 3/4 —— 常量是唯一出处, 别在别处再写一个 75。
    assert.match(source, /GIT_SPLIT_DEFAULT = 75/, '上栏默认占比必须是 3/4(75)');

    // 两栏各滚各的 + 中间一条可拖的拖柄(直接看**注入出去的 CSS**, 拼法绕不过去)。
    const styles = [];
    const b = loadBundle('plugins/file-git-explorer/lib/client.js', {
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
    assert.match(css, /\.fge-dir\{/, '目录行样式缺了');

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
    // 下栏(提交历史)最多 60% ⇒ 上栏下限必须抬到 40(往**上**拉也不能把变更列表挤没)。
    assert.match(source, /GIT_SPLIT_MIN = 40/, '下栏最多占 60%: 上栏拖拽下限应为 40');

    // 两份列表都得真的**走**这棵树上屏 —— 只定义不接线是最容易漏的一步。
    assert.ok(
        /changeRows = treeRows\(/.test(source),
        '变更列表要经 treeRows 上屏(不是原来的平铺循环)',
    );
    assert.ok(
        /historyRows = historyRows\.concat\(\s*treeRows\(/.test(source),
        '提交展开的文件清单要经 treeRows 上屏',
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
});

check('fge: 右侧栏默认铺「文件」+「Git」两格, Git 是活动那格', () => {
    const source = readFileSync(join(ROOT, 'plugins/file-git-explorer/lib/client.js'), 'utf8');
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

console.log('');
if (failures.length > 0) {
    console.error('client bundle 装配: ' + String(failures.length) + ' 项失败');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log('client bundle 装配: ' + String(passed) + ' 项检查全部通过');
