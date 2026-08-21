#!/usr/bin/env node
/* scripts/build.mjs — 把 src/ 拼接为 lib/client.js（零依赖，Node ≥ 18）
 *
 * 用法：
 *   node scripts/build.mjs          重新生成 lib/client.js（确定性输出）
 *   node scripts/build.mjs --check  校验现有 lib/client.js 与 src/ 一致（不一致退出码 1）
 *
 * 布局约定：
 *   - src/css/*.css         原始样式表，按文件名排序拼接进 <style> 标签
 *   - src/*.js              工厂级片段（纯常量/纯函数）与 initX(shared) 模块，
 *                           按下方 JS_FILES 顺序拼接进工厂闭包；index.js 必须最后
 *   - 源码禁止顶层 import/export（拼接构建不支持 ESM 语法）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "lib", "client.js");
const PKG_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "0.0.0";

/** 我们的插件 JS 文件（按序拼接；index.js 最后） */
const JS_FILES = [
  "whale-shaders.js",   // 工厂级：鲸鱼 SVG/GLSL/矩阵工具
  "theme.js",           // initTheme
  "settings.js",        // initSettings
  "dom.js",             // initDom
  "whale.js",           // initWhale
  "whale-overlay.js",   // initWhaleOverlay（注册进 shell.overlay）
  "boot.js",            // initBoot
  "index.js"            // apply(ctx)
];

const CSS_HEADER = `/*!
 * dsh-deepseek-harness.css
 * DeepSeek 官网风格背景复刻（粒子鲸鱼）—— DSH Web GUI。
 * 颜色与蒙版取自 DeepSeek 官方站点：页面底色 #0d1017、canvas 蒙版、入场动画。
 * 全主题统一深色：浅色/深色均使用 harness 深色主题。
 */`;

function read(name) { return readFileSync(join(root, name), "utf8"); }

function build() {
  const cssDir = join(root, "src", "css");
  if (!existsSync(cssDir)) throw new Error("src/css 目录缺失");
  const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith(".css")).sort();
  const parts = cssFiles.map((f) => read(join("src", "css", f)).replace(/\s+$/, "\n"));
  const css = CSS_HEADER + "\n\n" + parts.join("\n");
  if (/`|\$\{/.test(css)) throw new Error("src/css/*.css 含反引号或 ${（会破坏产物模板字面量）");

  const jsDir = join(root, "src");
  const onDisk = readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort();
  const untracked = onDisk.filter((f) => !JS_FILES.includes(f));
  if (untracked.length > 0) throw new Error(`src/ 下有未加入 JS_FILES 的 JS 文件: ${untracked.join(", ")}`);
  for (const f of JS_FILES) {
    const src = read(join("src", f));
    for (const m of src.matchAll(/^(?!\s*\/\/)\s*(import|export)\b/gm)) {
      throw new Error(`${f}: 源码含顶层 ${m[1]} 语句——拼接构建不支持 ESM`);
    }
    if (f === "index.js" && !src.includes("function apply(ctx)")) {
      throw new Error("src/index.js 缺少 function apply(ctx)");
    }
  }

  let js = JS_FILES.map((f) => `\n/* ===================== ${f} ===================== */\n${read(join("src", f))}`).join("\n");
  js = js.replaceAll("__PKG_VERSION__", PKG_VERSION);

  return `/*!
 * dsh-deepseek-harness 客户端入口（自动生成）
 * 由 scripts/build.mjs 从 src/ 拼接生成——请勿直接修改本文件。
 */
window.__ModuleLoader__.load({
  id: "dsh-deepseek-harness",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // 设置页面板需要 React（平台 seed 模块）；拿不到就跳过设置 UI
    var react = null;
    try { react = require("react"); } catch (e) {}
    if (document.getElementById("dsh-deepseek-bg-css") === null) {
      var styleTag = document.createElement("style");
      styleTag.id = "dsh-deepseek-bg-css";
      styleTag.textContent = \`
${css}
\`;
      document.head.appendChild(styleTag);
    }
${js}

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
`;
}

const checkOnly = process.argv.includes("--check");
const out = build();
if (checkOnly) {
  const existing = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  if (existing !== out) { console.error("--check: lib/client.js 与 src/ 不一致"); process.exit(1); }
  console.log("--check: lib/client.js 与 src/ 一致 ✓");
} else {
  writeFileSync(OUT, out);
  console.log(`已生成 lib/client.js（${out.length} 字节：CSS ${readdirSync(join(root, "src", "css")).filter((f) => f.endsWith(".css")).length} 个文件 + JS ${JS_FILES.length} 个文件）`);
}
