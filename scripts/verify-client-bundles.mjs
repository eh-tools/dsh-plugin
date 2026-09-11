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
 *   · apply() 注册的槽位名 / key / id / kind / priority 是否与声明一致。
 *
 * 它**不**渲染任何 UI: 真实渲染仍需要浏览器(见各插件 README 的验收清单)。
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
    });
    return {
        getElementById: () => null,
        createElement: node,
        head: { appendChild: () => {} },
        body: { appendChild: () => {}, removeChild: () => {} },
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

// ---- fge: 双 kind + 终端抽屉 ----
{
    const b = loadBundle('plugins/file-git-explorer/lib/client.js');
    check('fge: bundle id 与 inject', () => {
        assert.equal(b.id, 'dsh-file-git-explorer');
        assert.ok(b.exports.inject.includes('slots'), 'inject 应含 slots');
        assert.ok(b.exports.inject.includes('sidebarRightTabs'), 'inject 应含 sidebarRightTabs');
    });
    check('fge: 只 require 了种子模块', () => {
        assert.deepEqual([...new Set(b.requires)], ['react']);
    });
    check('fge: 注册两个 extension 档 kind', () => {
        const kinds = b.tabs.map((t) => t.kind).sort();
        assert.deepEqual(kinds, ['fge-git', 'fge-shell']);
        for (const t of b.tabs) {
            assert.equal(t.priority, 'extension', t.kind + ' 应为 extension 档');
            assert.equal(typeof t.title, 'function', t.kind + ' 的 title 应为 thunk');
        }
    });
    check('fge: 两个 kind 的 body / title 都按 key 注册', () => {
        const bodyKeys = slotOf(b, 'sidebar.right.pane.tab').map((s) => s.options.key);
        const titleKeys = slotOf(b, 'sidebar.right.pane.tab.title').map((s) => s.options.key);
        for (const key of ['dsh-file-git-explorer/git', 'dsh-file-git-explorer/shell']) {
            assert.ok(bodyKeys.includes(key), '缺 pane.tab body: ' + key);
            assert.ok(titleKeys.includes(key), '缺 pane.tab title: ' + key);
        }
        for (const s of b.slots) {
            assert.equal(typeof s.component, 'function', s.options.name + ' 的组件应为函数');
        }
    });
    check('fge: 终端抽屉注册进 conversation.composer.dock', () => {
        const dock = slotOf(b, 'conversation.composer.dock');
        assert.equal(dock.length, 1);
        assert.equal(dock[0].options.id, 'fge-terminal');
    });
}

// ---- files-lite: 接管官方 files kind ----
{
    const b = loadBundle('plugins/files-lite/lib/client.js');
    check('files-lite: bundle id 与 inject', () => {
        assert.equal(b.id, 'dsh-files-lite');
        assert.ok(b.exports.inject.includes('slots'), 'inject 应含 slots');
        assert.ok(b.exports.inject.includes('sidebarRightTabs'), 'inject 应含 sidebarRightTabs');
    });
    check('files-lite: 以 extension 档接管 kind files', () => {
        assert.equal(b.tabs.length, 1);
        assert.equal(b.tabs[0].kind, 'files', '必须接管官方 kind, 而不是新建 kind');
        assert.equal(b.tabs[0].priority, 'extension', 'extension 档才能压过官方 builtin');
        assert.notEqual(
            b.tabs[0].id,
            '@deepseek-ai/dsh-client-ui-sidebar-files',
            'id 不能与官方重名',
        );
    });
    check('files-lite: body / title 按自己的 id 注册', () => {
        assert.deepEqual(
            slotOf(b, 'sidebar.right.pane.tab').map((s) => s.options.key),
            ['dsh-files-lite'],
        );
        assert.deepEqual(
            slotOf(b, 'sidebar.right.pane.tab.title').map((s) => s.options.key),
            ['dsh-files-lite'],
        );
    });
}

// ---- doc-copy: 文档页签菜单项 ----
{
    const b = loadBundle('plugins/doc-copy/lib/client.js');
    check('doc-copy: bundle id 与 inject', () => {
        assert.equal(b.id, 'dsh-doc-copy');
        assert.ok(b.exports.inject.includes('slots'), 'inject 应含 slots');
    });
    check('doc-copy: 只加菜单项, 不注册任何替换型槽', () => {
        const names = [...new Set(b.slots.map((s) => s.options.name))];
        assert.deepEqual(names, ['sidebar.right.tab.menu.item']);
        assert.equal(b.slots[0].options.id, 'doc-copy');
        // 关键回归护栏: 不得触碰 keyed 的正文槽(那会顶掉官方正文组件)
        assert.ok(
            !names.includes('sidebar.right.tab.document'),
            '不得注册 sidebar.right.tab.document(会替换官方正文)',
        );
    });
    check('doc-copy: 不注册任何 tab kind(只挂菜单, 不占 kind)', () => {
        assert.deepEqual(b.tabs, []);
    });
}

// ---- 跨插件冲突: 三类「boot 期直接抛错」的重复 ----
{
    const all = [
        ['file-git-explorer', loadBundle('plugins/file-git-explorer/lib/client.js')],
        ['files-lite', loadBundle('plugins/files-lite/lib/client.js')],
        ['doc-copy', loadBundle('plugins/doc-copy/lib/client.js')],
    ];

    check('跨插件: tab 类型 id 不重复(注册表对重名 id 抛错)', () => {
        const seen = new Map();
        for (const [name, bundle] of all) {
            for (const type of bundle.tabs) {
                assert.ok(
                    !seen.has(type.id),
                    'id "' + type.id + '" 被 ' + name + ' 与 ' + seen.get(type.id) + ' 同时注册',
                );
                seen.set(type.id, name);
            }
        }
    });

    check('跨插件: 同一档位内不重复声明同一个 kind', () => {
        // coexists(): 同 kind 的两档可以配对(extension 接管 builtin), 但**同档重复**
        // 是接线错误, 注册表直接抛错。
        const seen = new Map();
        for (const [name, bundle] of all) {
            for (const type of bundle.tabs) {
                const band = type.priority === undefined ? 'extension' : type.priority;
                const key = type.kind + '\u0000' + band;
                assert.ok(
                    !seen.has(key),
                    'kind "' +
                        type.kind +
                        '" 在 ' +
                        band +
                        ' 档被 ' +
                        name +
                        ' 与 ' +
                        seen.get(key) +
                        ' 重复注册',
                );
                seen.set(key, name);
            }
        }
    });

    check('跨插件: keyed 槽的 key 不重复(同槽同 key 会互相顶掉)', () => {
        const seen = new Map();
        for (const [name, bundle] of all) {
            for (const slot of bundle.slots) {
                if (typeof slot.options.key !== 'string') continue;
                const key = slot.options.name + '\u0000' + slot.options.key;
                assert.ok(
                    !seen.has(key),
                    '槽 ' +
                        slot.options.name +
                        ' 的 key "' +
                        slot.options.key +
                        '" 被 ' +
                        name +
                        ' 与 ' +
                        seen.get(key) +
                        ' 重复占用',
                );
                seen.set(key, name);
            }
        }
    });

    check('跨插件: list 槽的 id 不重复', () => {
        const seen = new Map();
        for (const [name, bundle] of all) {
            for (const slot of bundle.slots) {
                if (typeof slot.options.id !== 'string') continue;
                const key = slot.options.name + '\u0000' + slot.options.id;
                assert.ok(
                    !seen.has(key),
                    '槽 ' +
                        slot.options.name +
                        ' 的 id "' +
                        slot.options.id +
                        '" 被 ' +
                        name +
                        ' 与 ' +
                        seen.get(key) +
                        ' 重复占用',
                );
                seen.set(key, name);
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
