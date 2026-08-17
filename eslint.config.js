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
      // 动态插件源码: cordis_define 的函数体, 不是独立模块
      'plugins/ds-balance/host.js',
      'plugins/ds-balance/client.js',
      'plugins/paste-image/host.js',
      'plugins/paste-image/client.js',
      // playwright 登录脚本: page.evaluate 回调在浏览器上下文运行,
      // localStorage 等静态 no-undef 检查无意义
      'plugins/ds-balance/scripts/deepseek-login.cjs',
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
