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
      '.worktrees',
      // playwright 登录脚本: page.evaluate 回调在浏览器上下文运行,
      // localStorage 等静态 no-undef 检查无意义
      'plugins/ds-balance/scripts/deepseek-login.cjs',
      // 静态插件的 client bundle: 浏览器 CJS 闭包(window.__ModuleLoader__ /
      // require / module 不在 node globals 里, no-undef 检查无意义)
      'plugins/ds-balance/lib/client.js',
      'plugins/paste-image/lib/client.js',
      'plugins/file-git-explorer/lib/client.js',
      'plugins/deepseek-harness/lib/client.js',
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
