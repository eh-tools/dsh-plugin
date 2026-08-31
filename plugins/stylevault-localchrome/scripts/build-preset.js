#!/usr/bin/env node
/**
 * dsh-stylevault-localchrome — CLI: 从本机 Chrome 配色生成一份 StyleVault 1.0 预设 JSON。
 *
 * 用法:
 *   node scripts/build-preset.js                  # 读本机 Chrome 配色, 生成浅色预设, 打印到 stdout
 *   node scripts/build-preset.js --dark           # 强制定深色预设
 *   node scripts/build-preset.js --name "Chrome Green" --out sage.json
 *   node scripts/build-preset.js --accent "#87BA81"            # 跳过 Chrome, 直接用给定 accent
 *   node scripts/build-preset.js --file "<Preferences 路径>"   # 覆盖 Chrome profile 文件
 *   node scripts/build-preset.js --help
 *
 * 生成结果可直接粘贴到上游 GptsApp/dsh-stylevault 的 Settings → StyleVault → 导入。
 * 依赖: lib/chrome-theme.js(取色) + lib/presets.js(packTokens + 调色板推导)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChromeTheme } from '../lib/chrome-theme.js';
import { derivePalette, buildStyleVaultPreset } from '../lib/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(k, def) {
  const i = process.argv.indexOf(k);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const flag = (k) => process.argv.includes(k);

function usage() {
  console.log(
    [
      'dsh-stylevault-localchrome — 从 Chrome 配色生成 StyleVault 预设',
      '',
      '  --dark                   生成深色预设(缺省浅色)',
      '  --accent "#RRGGBB"       不用 Chrome, 直接用给定 accent',
      '  --name "名称"            预设名(默认 Chrome Day / Chrome Night)',
      '  --out <path>             写入文件(缺省打印到 stdout)',
      '  --file <Preferences>     覆盖 Chrome Preferences 路径',
      '  --help                   显示本帮助',
      '',
    ].join('\n'),
  );
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  if (flag('--help') || flag('-h')) {
    usage();
    return;
  }

  const dark = flag('--dark');
  const accentOverride = arg('--accent', '');
  const out = arg('--out', '');
  const file = arg('--file', '');
  const name = arg('--name', dark ? 'Chrome Night' : 'Chrome Day');

  let accent = accentOverride.trim();
  let chrome = null;

  if (!accent) {
    chrome = readChromeTheme({ file });
    if (!chrome.ok) {
      fail(
        `[svlc] 读取 Chrome 主题失败: ${chrome.error} (${chrome.file})\n` +
          '  · 确认 Chrome 已启动过 / 文件存在\n' +
          '  · 或用 --accent "#RRGGBB" 直接指定, 或 --file 指向正确的 Preferences',
      );
    }
    accent = chrome.color;
    if (!accent) {
      // 商店主题 / 非用户色主题时 user_color 可能是空的, 给出提示
      const hint = chrome.extensionThemeId
        ? `(extensions.theme.id = ${chrome.extensionThemeId}, 非本机用户色主题)`
        : '';
      fail(`[svlc] 未取到 user_color → 没有可用的 accent。${hint}`);
    }
  }

  const palette = derivePalette(accent, { dark });
  const preset = buildStyleVaultPreset({
    palette,
    colorScheme: dark ? 'dark' : 'light',
    name,
    description: `Generated from local Google Chrome theme accent ${accent}.`,
    basePreset: dark ? 'everforest-dark' : 'everforest-light',
  });

  const json = JSON.stringify(preset, null, 2);
  if (out) {
    const abs = path.resolve(__dirname, '..', out);
    fs.writeFileSync(abs, json + '\n', 'utf8');
    console.log(`[svlc] 已写入 ${abs}`);
    console.log(`[svlc] accent=${accent} · scheme=${dark ? 'dark' : 'light'} · preset="${name}"`);
  } else {
    console.log(json);
  }
}

main();
