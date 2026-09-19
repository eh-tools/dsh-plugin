import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      'test-results',
      'playwright-report',
      // 个人 demo 目录(已 gitignore): 与仓库门禁无关, 不该因为个人脚本的风格问题
      // 把 `just check` 搞红。与 test-results 同款处理。
      'demos',
      // playwright 登录脚本: page.evaluate 回调在浏览器上下文运行,
      // localStorage 等静态 no-undef 检查无意义
      'plugins/ds-balance/scripts/deepseek-login.cjs',
      // 静态插件的 client bundle: 浏览器 CJS 闭包(window.__ModuleLoader__ /
      // require / module 不在 node globals 里, no-undef 检查无意义)
      'plugins/ds-balance/lib/client.js',
      'plugins/obsolete/paste-image/lib/client.js',
      'plugins/obsolete/file-git-explorer/lib/client.js',
      'plugins/db-console/lib/client.js',
      'plugins/deepseek-harness/lib/client.js',
      'plugins/batch-archive/lib/client.js',
      'plugins/stylevault-localchrome/lib/client.js',
      // deepseek-harness 的浏览器端源码(经 scripts/build.mjs 打包进 client
      // bundle): 运行在浏览器上下文且依赖打包期符号, node globals 下无法检查
      'plugins/deepseek-harness/src',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  prettier,
];
