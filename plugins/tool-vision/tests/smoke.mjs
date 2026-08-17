/**
 * Smoke tests for the tool-vision plugin.
 *
 * Spins up an in-process mock OpenAI-compatible server (llama-server stand-in),
 * loads the plugin from lib/index.js, registers it on a minimal fake `ctx.tools`,
 * and asserts the tool's schema, request wire format, error handling, and config
 * validation. No real model or network access required.
 *
 * Run: node tests/smoke.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apply } from '../lib/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_IMAGE = path.join(ROOT, 'fixtures', 'vision_test.png');

/** Start a mock OpenAI server; returns { url, close, lastRequest }. */
function startMockServer({ failWith }) {
    let lastRequest = null;
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'mock-vision-9b' }] }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            lastRequest = { url: req.url, body: JSON.parse(body) };
            if (failWith) {
                res.writeHead(failWith.status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(failWith.body ?? { error: { message: failWith.message } }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    model: 'mock-vision-9b',
                    choices: [{ message: { content: '图中有一个红色圆形和一个蓝色正方形。' } }],
                }),
            );
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/v1`,
                close: () => new Promise((done) => server.close(done)),
                get lastRequest() {
                    return lastRequest;
                },
            });
        });
    });
}

/** Minimal registrant context: just enough of `ctx.tools` for apply(). */
function fakeCtx() {
    let registered = null;
    return {
        tools: {
            register(definition) {
                registered = definition;
                return () => {
                    registered = null;
                };
            },
        },
        get registered() {
            return registered;
        },
    };
}

const signal = () => new AbortController().signal;

async function main() {
    // 1. Registration + schema shape.
    {
        const ctx = fakeCtx();
        apply(ctx, {});
        assert.ok(ctx.registered, 'apply() must register a tool');
        assert.equal(ctx.registered.name, 'vision');
        assert.equal(ctx.registered.parameters.required[0], 'image');
        assert.equal(ctx.registered.parameters.additionalProperties, false);
        assert.equal(typeof ctx.registered.execute, 'function');
        assert.equal(typeof ctx.registered.output.render, 'function');
        console.log('ok 1 — registration + schema');
    }

    // 2. Config validation fails loud.
    {
        const ctx = fakeCtx();
        assert.throws(() => apply(ctx, { baseUrl: 'not-a-url' }), /baseUrl must be an http/);
        assert.throws(() => apply(ctx, { maxTokens: -1 }), /maxTokens must be a positive integer/);
        assert.throws(
            () => apply(ctx, { maxImageBytes: 0 }),
            /maxImageBytes must be a positive integer/,
        );
        assert.throws(() => apply(ctx, { model: 42 }), /model must be a non-empty string/);
        console.log('ok 2 — config validation');
    }

    // 3. End-to-end against the mock server: data URI + prompt + parsed text.
    {
        const mock = await startMockServer({});
        try {
            const ctx = fakeCtx();
            apply(ctx, { baseUrl: mock.url });
            const result = await ctx.registered.execute(
                { image: TEST_IMAGE, prompt: '描述这张图' },
                { signal: signal() },
            );
            assert.equal(result.text, '图中有一个红色圆形和一个蓝色正方形。');
            assert.equal(result.model, 'mock-vision-9b');
            assert.ok(result.durationMs >= 0);
            const sent = mock.lastRequest;
            assert.equal(sent.body.messages[0].role, 'user');
            const [textBlock, imageBlock] = sent.body.messages[0].content;
            assert.equal(textBlock.text, '描述这张图');
            assert.equal(imageBlock.type, 'image_url');
            assert.ok(imageBlock.image_url.url.startsWith('data:image/png;base64,'));
            assert.equal(sent.body.stream, false);
            assert.ok(sent.body.max_tokens > 0);
        } finally {
            await mock.close();
        }
        console.log('ok 3 — mock end-to-end (data URI wire format)');
    }

    // 4. Default prompt is used when `prompt` is omitted.
    {
        const mock = await startMockServer({});
        try {
            const ctx = fakeCtx();
            apply(ctx, { baseUrl: mock.url, defaultPrompt: '看图说话' });
            await ctx.registered.execute({ image: TEST_IMAGE }, { signal: signal() });
            assert.equal(mock.lastRequest.body.messages[0].content[0].text, '看图说话');
        } finally {
            await mock.close();
        }
        console.log('ok 4 — defaultPrompt fallback');
    }

    // 5. Model auto-detection from /v1/models.
    {
        const mock = await startMockServer({});
        try {
            const ctx = fakeCtx();
            apply(ctx, { baseUrl: mock.url, model: '' });
            const result = await ctx.registered.execute(
                { image: TEST_IMAGE },
                { signal: signal() },
            );
            assert.equal(result.model, 'mock-vision-9b');
        } finally {
            await mock.close();
        }
        console.log('ok 5 — model auto-detection');
    }

    // 6. Server errors propagate with status.
    {
        const mock = await startMockServer({
            failWith: { status: 500, body: { error: { message: 'oom' } } },
        });
        try {
            const ctx = fakeCtx();
            apply(ctx, { baseUrl: mock.url });
            await assert.rejects(
                ctx.registered.execute({ image: TEST_IMAGE }, { signal: signal() }),
                /HTTP 500/,
            );
        } finally {
            await mock.close();
        }
        console.log('ok 6 — server error propagation');
    }

    // 7. Missing / unsupported image errors.
    {
        const ctx = fakeCtx();
        apply(ctx, {});
        await assert.rejects(
            ctx.registered.execute({ image: '/no/such/file.png' }, { signal: signal() }),
            /image not found/,
        );
        await assert.rejects(
            ctx.registered.execute({ image: path.join(ROOT, 'smoke.mjs') }, { signal: signal() }),
            /unsupported image type ".mjs"/,
        );
        console.log('ok 7 — image path / type errors');
    }

    // 8. Connection refused yields a friendly error.
    {
        const ctx = fakeCtx();
        apply(ctx, { baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 2000 });
        await assert.rejects(
            ctx.registered.execute({ image: TEST_IMAGE }, { signal: signal() }),
            /failed to reach the vision server/,
        );
        console.log('ok 8 — unreachable server error');
    }

    console.log('\nall smoke tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
