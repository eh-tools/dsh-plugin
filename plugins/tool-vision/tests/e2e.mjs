/**
 * End-to-end test against a real llama-server.
 *
 * Two modes:
 *   default     assumes a vision llama-server is already serving the
 *               OpenAI-compatible API (see README "启动 llama-server");
 *   --ondemand  uses autoStart: the plugin spawns llama-server itself via the
 *               default serverCommand, runs one real call, then the server must
 *               exit because keepAliveMs is 0.
 *
 * Run:
 *   node tests/e2e.mjs                 (external server on 8080)
 *   node tests/e2e.mjs --ondemand      (plugin spawns + tears down)
 *   node tests/e2e.mjs <baseUrl>       (external server on a custom endpoint)
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apply } from '../lib/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_IMAGE = path.join(ROOT, 'fixtures', 'vision_test.png');
const TEST_ATTACHMENT_ID = 'sha256:e2e' + '0'.repeat(58);

const ondemand = process.argv.includes('--ondemand');
const baseUrl = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:8080/v1';

// Load the test image once and expose it through a mock attachment store + a
// synthetic session event, mirroring how a pasted image reaches the tool at
// runtime.
const imageData = new Uint8Array(await readFile(TEST_IMAGE));
const imageRef = {
    attachmentId: TEST_ATTACHMENT_ID,
    mediaType: 'image/png',
    bytes: imageData.byteLength,
    width: 4,
    height: 4,
};

let registered;
const disposers = [];
const ctx = {
    tools: {
        register(definition) {
            registered = definition;
            return () => {
                registered = null;
            };
        },
    },
    on(event, handler) {
        if (event === 'dispose') disposers.push(handler);
    },
    dispose() {
        for (const fn of disposers.splice(0)) fn();
    },
    get(key) {
        if (key === 'attachments') {
            return {
                imageLimits: {
                    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
                    maxImageBytes: 30 * 1024 * 1024,
                },
                async readImage(ref) {
                    return { ref, data: imageData };
                },
            };
        }
        return undefined;
    },
};

apply(ctx, {
    baseUrl,
    defaultPrompt: '用中文简要描述这张图片的内容',
    ...(ondemand ? { autoStart: true, keepAliveMs: 0, startupTimeoutMs: 180000 } : {}),
});

const exec = {
    signal: new AbortController().signal,
    agent: {
        session: {
            events: [
                {
                    type: 'user/message',
                    seq: 0,
                    data: {
                        content: [
                            { type: 'text', text: '请识别这张图片' },
                            { type: 'image', attachment: imageRef },
                        ],
                    },
                },
            ],
        },
    },
};

const result = await registered.execute(
    { attachmentId: TEST_ATTACHMENT_ID, prompt: '用中文简要描述这张图片的内容' },
    exec,
);

assert.equal(typeof result.text, 'string');
assert.ok(result.text.length > 0, 'model returned empty text');
assert.ok(result.durationMs >= 0);
assert.ok(result.model.length > 0);

console.log(`mode:      ${ondemand ? 'on-demand (plugin spawned the server)' : 'external server'}`);
console.log(`model:     ${result.model}`);
console.log(`duration:  ${result.durationMs} ms`);
console.log('--- model answer ---');
console.log(result.text);

if (ondemand) {
    // keepAliveMs 0: the auto-started server must already be gone.
    await sleep(1000);
    try {
        const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
        assert.ok(
            !response.ok,
            `auto-started server should be stopped, got HTTP ${response.status}`,
        );
    } catch {
        // Connection refused = server stopped, as expected.
    }
    ctx.dispose();
    console.log('--- on-demand teardown verified (server stopped) ---');
}

console.log('--- e2e passed ---');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
