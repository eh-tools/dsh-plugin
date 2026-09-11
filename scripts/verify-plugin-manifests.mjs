/**
 * 插件包「安装链」预检(离线可跑, 不需要 DSH 进程)
 *
 * 运行: node scripts/verify-plugin-manifests.mjs
 *
 * 为什么需要它: 这条链上的错误**只在真实 boot 时才炸**, 而 boot 失败会把整个
 * profile 拉成 FAILED fiber。本脚本把 dsh 自身的校验规则与挂载契约在本地重放一遍,
 * 于是「重启才发现装不上」变成「提交前就发现」。
 *
 * 重放的规则(与 dsh 0.1.5-rc.1 实现一致):
 *   · `dsh.client.platform` 必须存在且为 `"web"`, 否则该包被**静默忽略**
 *     (dsh-client-modules: `decl.platform !== "web"` 直接 return null);
 *   · 声明了 `dsh.client` 就必须有可解析的 `exports["./client"]`(字符串, 或
 *     `{ default: string }`), 且文件真实存在, 否则抛
 *     `declares dsh.client but exports no "./client" bundle`;
 *   · 包名出现在 `dsh.profile.bundles` 时必须有 `dsh.bundle.patch` 且文件存在,
 *     否则抛 `profile bundle "<name>" declares no dsh.bundle in its package.json`;
 *   · 挂载行(cordis.patch.yml 的 insert)里的 `name` 必须**等于**包名, 否则那一行
 *     挂的是别的包(或什么都不挂), 而 boot 不会因此报错 —— 只会静默少一个插件;
 *   · manifest.json 的名字 / files[] 与磁盘一致(仓库自身的契约)。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 本仓库里所有「静态双半包」插件目录名(= 插件 id)。 */
const PLUGIN_IDS = ['file-git-explorer', 'files-lite', 'doc-copy'];

let passed = 0;
const failures = [];

function check(label, fn) {
    try {
        fn();
        passed += 1;
        console.log('ok - ' + label);
    } catch (err) {
        failures.push(label + ' :: ' + (err && err.message));
        console.error('not ok - ' + label + ' :: ' + (err && err.message));
    }
}

function readJson(abs) {
    return JSON.parse(readFileSync(abs, 'utf8'));
}

/** 复刻 dsh-client-modules 的 clientExportOf: 字符串或 { default: string }。 */
function clientExportOf(pkgName, exportsField) {
    if (typeof exportsField !== 'object' || exportsField === null) return undefined;
    const client = exportsField['./client'];
    if (client === undefined) return undefined;
    if (typeof client === 'string') return client;
    if (typeof client === 'object' && client !== null) {
        const fallback = client.default;
        if (typeof fallback === 'string') return fallback;
    }
    throw new Error(pkgName + " exports['./client'] 必须是字符串或 { default: 字符串 }");
}

for (const id of PLUGIN_IDS) {
    const dir = join(ROOT, 'plugins', id);
    const pkgPath = join(dir, 'package.json');

    check(id + ': 目录与 package.json 存在', () => {
        assert.ok(existsSync(pkgPath), '缺 ' + pkgPath);
    });
    if (!existsSync(pkgPath)) continue;

    const pkg = readJson(pkgPath);

    check(id + ': 包名 = dsh-<目录名>', () => {
        assert.equal(pkg.name, 'dsh-' + id);
    });

    check(id + ': dsh.client.platform === "web"', () => {
        const decl = pkg.dsh && pkg.dsh.client;
        assert.ok(decl !== undefined && decl !== null, '未声明 dsh.client');
        assert.equal(decl.platform, 'web', 'platform 不是 web → 该包会被静默忽略');
    });

    check(id + ': host 入口存在', () => {
        const main = pkg.main !== undefined ? pkg.main : clientExportOf(pkg.name, pkg.exports);
        assert.equal(typeof main, 'string', '缺 main');
        assert.ok(existsSync(join(dir, main)), '入口文件不存在: ' + main);
        const dot = pkg.exports && pkg.exports['.'];
        const dotPath = typeof dot === 'string' ? dot : dot && dot.default;
        if (typeof dotPath === 'string') {
            assert.ok(existsSync(join(dir, dotPath)), 'exports["."] 指向的文件不存在: ' + dotPath);
        }
    });

    check(id + ': exports["./client"] 可解析且文件存在', () => {
        const rel = clientExportOf(pkg.name, pkg.exports);
        assert.ok(typeof rel === 'string', '声明了 dsh.client 却没有 exports["./client"]');
        assert.ok(existsSync(join(dir, rel)), 'client bundle 文件不存在: ' + rel);
    });

    check(id + ': dsh.bundle.patch 声明且挂载层文件存在', () => {
        const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
        assert.equal(
            typeof patch,
            'string',
            '缺 dsh.bundle.patch(会被装成普通依赖而静默不进 bundle 栈)',
        );
        assert.ok(existsSync(join(dir, patch)), '挂载层文件不存在: ' + patch);
    });

    check(id + ': 挂载行的 name 等于包名', () => {
        const patch = pkg.dsh.bundle.patch;
        const text = readFileSync(join(dir, patch), 'utf8');
        // insert 行形如:  - id: <id>\n      name: 'dsh-<id>'
        assert.ok(
            text.includes("'" + pkg.name + "'") || text.includes('"' + pkg.name + '"'),
            '挂载层没有引用包名 ' + pkg.name + ' —— 那一行会挂空(且 boot 不报错)',
        );
    });

    check(id + ': manifest.json 与磁盘一致', () => {
        const manifestPath = join(dir, 'manifest.json');
        assert.ok(existsSync(manifestPath), '缺 manifest.json');
        const manifest = readJson(manifestPath);
        assert.equal(manifest.name, pkg.name, 'manifest.name 与包名不一致');
        assert.ok(
            Array.isArray(manifest.files) && manifest.files.length > 0,
            'manifest.files 应为非空数组',
        );
        for (const rel of manifest.files) {
            assert.ok(existsSync(join(dir, rel)), 'manifest.files 列了不存在的文件: ' + rel);
        }
        assert.equal(typeof manifest.install, 'string', '缺 install 说明');
        assert.ok(
            manifest.install.includes('<repo-abs-path>'),
            'install 必须用 <repo-abs-path> 占位符, 不能写本机绝对路径',
        );
    });

    check(id + ': README 存在且安装命令用占位符', () => {
        const readmePath = join(dir, 'README.md');
        assert.ok(existsSync(readmePath), '缺 README.md');
        const text = readFileSync(readmePath, 'utf8');
        assert.ok(text.includes('dsh plugin --profile web add link:'), 'README 缺安装命令');
        assert.ok(text.includes('<repo-abs-path>'), 'README 的安装命令必须用 <repo-abs-path>');
        assert.ok(
            !/[A-Za-z]:[\\/](dev-tools|Users)/.test(text),
            'README 里出现了本机绝对路径(违反仓库约定)',
        );
    });
}

console.log('');
if (failures.length > 0) {
    console.error('安装链预检: ' + String(failures.length) + ' 项失败');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log('安装链预检: ' + String(passed) + ' 项检查全部通过(' + PLUGIN_IDS.length + ' 个插件)');
