/**
 * DSH 主题 token 漂移检查(手动, 升级 dsh 后跑一次)
 *
 * 运行:
 *   node scripts/check-theme-token-drift.mjs
 *   node scripts/check-theme-token-drift.mjs --json
 *   node scripts/check-theme-token-drift.mjs --dsh-root <dsh 安装目录> --scheme <方案 json>
 *
 * 为什么需要它: StyleVault 那一层是「按 token 名覆盖」的 —— 它只认自己清单里
 * 的 90 来个语义 token。DSH 每加一批 token(0.2.1 的 `--dsw-menu-surface-fill`
 * 就是一例), 这些新 token 就退回官方配色; 浅色方案跑在深色外壳上时, 弹层会变成
 * 深色底板 + 深色字(灰底黑字)。这类回归靠肉眼看, 通常要等某个弹层变灰才发现。
 *
 * 本脚本把「官方语义 token」和「方案能覆盖的 token」做差集, 直接列出缺口与
 * 官方浅/深值, 于是升级后一条命令就能看到哪里又漏了。
 *
 * 口径:
 *   · 官方 token 从 dsh-client-ui-theme 的 stylesheet 里提取(alias / specific /
 *     menu / elevation / mask / shadow / linear / gradient 这几族);
 *     `--dsw-static-*`(原始色板)与 `--dsw-font-*` 不算语义 token, 不在口径内。
 *   · 方案 token 取方案 JSON 的 `tokens` 键, 再并入 profile 里
 *     `patches/dsh-stylevault@0.3.0.patch` 的补丁层 token(本地补丁会按方案
 *     明暗推导一批新 token, 它们也算覆盖)。
 *
 * 退出码默认 0(只报告); 加 `--fail-on-drift` 时有缺口就退出 1, 方便接进 CI。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SCHEME = join(
    ROOT,
    'plugins/stylevault-localchrome/assets/sage-mist.stylevault.json',
);
const DEFAULT_PROFILE_PATCH = join(
    homedir(),
    '.dsh/profiles/web/patches/dsh-stylevault@0.3.0.patch',
);

/** 算「语义 token」的前缀 —— 主题该控制的那些; 静态色板与字号体系不算。 */
const SEMANTIC_PREFIXES = [
    '--dsw-alias-',
    '--dsw-specific-',
    '--dsw-menu-',
    '--dsw-elevation-',
    '--dsw-mask-',
    '--dsw-shadow-',
    '--dsw-linear-',
    '--dsw-gradient-',
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

function fail(message) {
    console.error(`check-theme-token-drift: ${message}`);
    process.exit(2);
}

/** 官方 dsh 安装目录: 显式参数 > $DSH_ROOT > 全局 npm 安装 > profile 里那份。 */
function resolveDshRoot() {
    const explicit = option('--dsh-root', process.env.DSH_ROOT);
    const candidates = explicit
        ? [explicit]
        : [
              join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh'),
              join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh'),
          ];
    for (const candidate of candidates) {
        if (candidate && existsSync(candidate)) return resolve(candidate);
    }
    try {
        const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        const candidate = join(globalRoot, '@deepseek-ai/dsh');
        if (existsSync(candidate)) return resolve(candidate);
    } catch {
        /* npm 不在 PATH 时忽略, 走下面的报错 */
    }
    fail(
        '找不到 dsh 安装目录。用 --dsh-root <path> 或 DSH_ROOT 指定(目录里应有 ' +
            'node_modules/@deepseek-ai/dsh-client-ui-theme)。',
    );
    return '';
}

/** 官方 ui-theme 客户端 bundle —— token 定义在这个文件的 stylesheet 字符串里。 */
function resolveThemeBundle(dshRoot) {
    const candidates = [
        join(
            dshRoot,
            'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
        ),
        join(dshRoot, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
    ];
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) fail(`在 ${dshRoot} 下找不到 dsh-client-ui-theme/lib/client.js`);
    return hit;
}

/** 某位置属于深色块还是浅色块: 往前找最近的 `body{` / `body[data-ds-dark-theme]{`。 */
function schemeAt(text, index) {
    const dark = text.lastIndexOf('body[data-ds-dark-theme]{', index);
    const light = Math.max(text.lastIndexOf('body{', index), text.lastIndexOf(':root{', index));
    return dark > light ? 'dark' : 'light';
}

/** 从官方 bundle 里抽出 语义 token -> { light, dark }。 */
function readOfficialTokens(themeBundle) {
    const text = readFileSync(themeBundle, 'utf8');
    const tokens = new Map();
    const declaration = /(--dsw-[a-z0-9-]+)\s*:\s*([^;}"']+)/g;
    for (const match of text.matchAll(declaration)) {
        const name = match[1];
        if (!SEMANTIC_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        const value = match[2].trim();
        const mode = schemeAt(text, match.index);
        const entry = tokens.get(name) ?? { light: '', dark: '' };
        entry[mode] = value;
        tokens.set(name, entry);
    }
    return tokens;
}

/** 方案 JSON 的 tokens 键(自定义方案导出格式 1.0)。 */
function readSchemeTokens(file) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw.tokens !== 'object' || raw.tokens === null) {
        fail(`方案文件 ${file} 没有 tokens 对象(需要 StyleVault 1.0 导出格式)`);
    }
    return new Set(Object.keys(raw.tokens));
}

/** 本地 stylevault 补丁层能覆盖的 token 名 —— 补丁里的 `"--dsw-…":` 键。 */
function readPatchTokens(file) {
    if (!file || !existsSync(file)) return new Set();
    const text = readFileSync(file, 'utf8');
    return new Set(
        [...text.matchAll(/"(--dsw-[a-z0-9-]+)"\s*:/g)]
            .map((match) => match[1])
            .filter((name) => SEMANTIC_PREFIXES.some((prefix) => name.startsWith(prefix))),
    );
}

/** 按影响面分组, 让报告能直接指向"哪类控件会变灰"。 */
function areaOf(name) {
    if (/menu|popover|tooltip/.test(name)) return '弹层 / 菜单';
    if (/settings-/.test(name)) return '设置面板';
    if (/onboarding/.test(name)) return '引导 / 欢迎页';
    if (/illustration/.test(name)) return '插画占位';
    if (/file-diff|code-diff/.test(name)) return 'diff / 代码块';
    if (/state-/.test(name)) return '状态色';
    return '其它';
}

function main() {
    const dshRoot = resolveDshRoot();
    const themeBundle = resolveThemeBundle(dshRoot);
    const schemeFile = option('--scheme', DEFAULT_SCHEME);
    const patchFile = option('--patch', DEFAULT_PROFILE_PATCH);

    if (!existsSync(schemeFile)) fail(`找不到方案文件 ${schemeFile}`);
    const official = readOfficialTokens(themeBundle);
    const scheme = readSchemeTokens(schemeFile);
    const patch = readPatchTokens(patchFile);
    const covered = new Set([...scheme, ...patch]);
    const missing = [...official.keys()].filter((name) => !covered.has(name)).sort();

    const report = {
        dshRoot,
        themeBundle,
        schemeFile,
        patchFile: existsSync(patchFile) ? patchFile : null,
        counts: {
            official: official.size,
            scheme: scheme.size,
            patch: patch.size,
            covered: [...official.keys()].filter((name) => covered.has(name)).length,
            missing: missing.length,
        },
        missing: missing.map((name) => ({
            name,
            area: areaOf(name),
            light: official.get(name)?.light ?? '',
            dark: official.get(name)?.dark ?? '',
        })),
    };

    if (flag('--json')) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log('dsh 主题 token 漂移检查');
        console.log(`  dsh        : ${dshRoot}`);
        console.log(`  token 定义 : ${themeBundle}`);
        console.log(`  方案       : ${schemeFile}`);
        console.log(`  补丁层     : ${report.patchFile ?? '(无)'}`);
        console.log('');
        console.log(`  官方语义 token: ${report.counts.official}`);
        console.log(`  方案 token    : ${report.counts.scheme}`);
        console.log(`  补丁层 token  : ${report.counts.patch}`);
        console.log(`  已覆盖        : ${report.counts.covered}`);
        console.log(`  缺口          : ${report.counts.missing}`);
        if (missing.length > 0) {
            console.log('');
            console.log('  缺口按影响面(浅色方案的缺口会退回官方深色值):');
            const areas = new Map();
            for (const item of report.missing) {
                const list = areas.get(item.area) ?? [];
                list.push(item);
                areas.set(item.area, list);
            }
            for (const [area, items] of areas) {
                console.log(`  · ${area}`);
                for (const item of items) {
                    console.log(
                        `      ${item.name.padEnd(46)} light=${item.light || '?'}  dark=${item.dark || '?'}`,
                    );
                }
            }
            console.log('');
            console.log(
                '  处理: 在 stylevault 补丁层里按方案明暗推导这些值(照 --dsw-alias-* 映射),',
            );
            console.log(
                '        或把方案 JSON 补上(i.e. 导出一份新方案); 见 README「主题 token 漂移」。',
            );
        } else {
            console.log('  没有缺口: 官方语义 token 都在方案 / 补丁层覆盖范围内 ✓');
        }
    }

    if (flag('--fail-on-drift') && missing.length > 0) process.exitCode = 1;
}

main();
