// Playwright 一键登录: 弹出真实浏览器打开 platform.deepseek.com,
// 用户手动登录后轮询 localStorage 直到 userToken 出现, 以 JSON 输出到 stdout。
// 由插件 host 的 ds-balance/browser-login 调用:
//   node <本文件>  (spawn 时需 NODE_PATH 指向全局 node_modules, 以便解析 playwright)
// 退出码: 0 = 成功(输出 {"token": "..."}); 1 = 超时/脚本错误; 2 = 浏览器启动失败。
'use strict';

// playwright 模块路径由 host 通过环境变量 DSH_PLAYWRIGHT_PATH 提供
// (DSH_ 前缀保证在子进程环境清理后保留), 避免依赖 NODE_PATH/PATH。
const PW_PATH = process.env.DSH_PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(PW_PATH);

const LOGIN_URL = 'https://platform.deepseek.com';
const TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
    // 优先驱动系统 Google Chrome(channel: 'chrome'), 免下载 playwright chromium;
    // 只有本机没有 Chrome 时才回退 playwright 自带 chromium。
    let browser = null;
    for (const opts of [{ headless: false, channel: 'chrome' }, { headless: false }]) {
        try {
            browser = await chromium.launch(opts);
            break;
        } catch (err) {
            console.error(
                'launch attempt failed: ' + (err && err.message ? err.message : String(err)),
            );
        }
    }
    if (browser === null) {
        console.error(
            'PLAYWRIGHT_LAUNCH_FAILED: no usable browser (install playwright chromium with `npx playwright install chromium`)',
        );
        process.exit(2);
    }
    try {
        const page = await browser.newPage();
        await page.goto(LOGIN_URL);
        const deadline = Date.now() + TIMEOUT_MS;
        let token = null;
        while (Date.now() < deadline) {
            const raw = await page
                .evaluate(() => {
                    try {
                        return localStorage.getItem('userToken');
                    } catch {
                        return null;
                    }
                })
                .catch(() => null);
            if (raw) {
                try {
                    token = JSON.parse(raw).value;
                } catch {
                    token = raw;
                }
                if (typeof token === 'string' && token.length > 8) break;
            }
            await page.waitForTimeout(1000);
        }
        if (!token) {
            console.error('LOGIN_TIMEOUT');
            process.exit(1);
        }
        process.stdout.write(JSON.stringify({ token }));
    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('SCRIPT_ERROR: ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
});
