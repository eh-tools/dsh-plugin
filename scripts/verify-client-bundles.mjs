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
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useRef: (value) => ({ current: value }),
    };
}

function makeDocumentStub() {
    const node = () => ({
        style: {},
        setAttribute: () => {},
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
    };
}

/**
 * 在 stub 环境里加载一个 client bundle 并执行 apply()。
 * @returns {{id: string, exports: object, slots: Array, tabs: Array, requires: string[]}}
 */
function loadBundle(relPath) {
    const source = readFileSync(join(ROOT, relPath), 'utf8');
    let registration = null;
    const win = {
        __ModuleLoader__: {
            load: (mod) => {
                registration = mod;
            },
        },
        localStorage: { getItem: () => null, setItem: () => {} },
        location: { protocol: 'http:', host: '127.0.0.1' },
        setTimeout: () => 0,
    };
    // 顶层唯一的副作用就是这次注册
    new Function('window', 'document', source)(win, makeDocumentStub());
    assert.ok(registration !== null, relPath + ' 顶层应调用 window.__ModuleLoader__.load');

    const requires = [];
    const react = makeReactStub();
    const requireStub = (spec) => {
        requires.push(spec);
        if (spec === 'react') return react;
        if (SEED_MODULES.has(spec)) return {};
        throw new Error('require 了种子表外的模块: ' + spec);
    };
    const exportsObj = registration.factory(requireStub);
    assert.equal(typeof exportsObj.apply, 'function', relPath + ' 应导出 apply');

    const slots = [];
    const tabs = [];
    const ctx = {
        slots: {
            inject: (_name, factory) => factory(),
            register: (options, component) => {
                slots.push({ options, component });
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
        get: () => undefined,
    };
    exportsObj.apply(ctx);
    return { id: registration.id, exports: exportsObj, slots, tabs, requires };
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

    check('fge: 终端抽屉注册进 conversation.composer.dock', () => {
        const dock = slotOf(b, 'conversation.composer.dock');
        assert.equal(dock.length, 1);
        assert.equal(dock[0].options.id, 'fge-terminal');
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

console.log('');
if (failures.length > 0) {
    console.error('client bundle 装配: ' + String(failures.length) + ' 项失败');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log('client bundle 装配: ' + String(passed) + ' 项检查全部通过');
