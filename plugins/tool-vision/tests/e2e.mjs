/**
 * End-to-end test against a real running llama-server.
 *
 * Assumes a vision llama-server is already serving the OpenAI-compatible API
 * (see README "启动 llama-server"); points the plugin at it and asks the real
 * model to describe the fixture image.
 *
 * Run: node tests/e2e.mjs [baseUrl]   (default http://127.0.0.1:8080/v1)
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apply } from '../lib/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_IMAGE = path.join(ROOT, 'fixtures', 'vision_test.png');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080/v1';

let registered;
const ctx = {
    tools: {
        register(definition) {
            registered = definition;
            return () => {
                registered = null;
            };
        },
    },
};

apply(ctx, { baseUrl, defaultPrompt: '用中文简要描述这张图片的内容' });

const result = await registered.execute(
    { image: TEST_IMAGE, prompt: '用中文简要描述这张图片的内容' },
    { signal: new AbortController().signal },
);

assert.equal(typeof result.text, 'string');
assert.ok(result.text.length > 0, 'model returned empty text');
assert.ok(result.durationMs >= 0);
assert.ok(result.model.length > 0);

console.log(`model:    ${result.model}`);
console.log(`duration: ${result.durationMs} ms`);
console.log('--- model answer ---');
console.log(result.text);
console.log('--- e2e passed ---');
