/**
 * db-console SQL 编辑器「双层对齐」回归守卫(源码级, 无浏览器)。
 *
 * 背景: 高亮层(underlay, .dbc-hl)是 textarea 的透明底衬, 两层必须逐像素同度量。
 * 壳层 / 主题插件会用 `#root pre{font-size:Npx!important;line-height:1.55}` 全局
 * 改写代码块字号(StyleVault 的「代码块字号」选项层就是这样)。一旦 underlay 是
 * <pre>, 该规则就会命中它: 高亮层 14px / 输入层 13px, 可见文本比原生光标每行多出
 * 约 7.7% 宽度 —— 表现为「光标永远追不上行尾, 打字却出现在末尾」。
 *
 * 本测试锁定源码口径的不变量:
 *   1) underlay 元素不得是壳层会重写的代码块标签(pre / code);
 *   2) 两层共享的 .dbc-hl,.dbc-ta 规则必须显式钉住 font-size / line-height;
 *   3) 运行时度量镜像仍在(外部 CSS 可能只改写输入层; 经典滚动条还会让输入层内容
 *      宽度比高亮层窄, 换行点随之错开)。
 *
 * 局限: 真实层叠与排版校验需要浏览器; 本仓库测试均为 Node 侧, 没有浏览器 seam,
 * 故此处只做源码守卫(能挡住「把 div 改回 pre」「删掉度量镜像」这类回归)。
 * Run: node plugins/db-console/tests/editor-metrics.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// ---- 1. underlay 元素标签 ----
const m = /createElement\(\s*'([a-zA-Z]+)'\s*,\s*\{\s*ref:\s*hlRef\b/.exec(source);
assert.ok(m, '未能在 client.js 中定位 underlay(hlRef)的 createElement 调用');
const underlayTag = m[1];
assert.ok(
    underlayTag !== 'pre' && underlayTag !== 'code',
    `underlay 不得使用 ${underlayTag}: 壳层会以 #root pre{font-size:...!important} 改写它, 两层度量会错位`,
);

// ---- 2. 两层共享规则的字体度量 ----
const ruleStart = source.indexOf('.dbc-hl,.dbc-ta{');
assert.ok(ruleStart >= 0, '未找到 .dbc-hl,.dbc-ta 共享规则');
const rule = source.slice(ruleStart, source.indexOf('}', ruleStart));
for (const decl of [
    'font-size:13px',
    'line-height:22px',
    'font-family:var(--ds-font-family-code)',
]) {
    assert.ok(rule.includes(decl), `.dbc-hl,.dbc-ta 缺少 ${decl}, 两层度量可能不一致`);
}

// ---- 3. 运行时度量镜像仍在 ----
assert.ok(
    source.includes('syncLayerMetrics'),
    '缺少 syncLayerMetrics: 高亮层不再镜像输入层的实测度量',
);
assert.ok(
    /ta\.offsetWidth\s*-\s*ta\.clientWidth/.test(source),
    '缺少滚动条占位补偿: 经典滚动条下两层内容宽度会不同, 换行点随之错开',
);

console.log('db-console editor metrics: all assertions passed (underlay=<' + underlayTag + '>)');
