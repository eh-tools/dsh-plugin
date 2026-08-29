/**
 * Smoke tests for the tool-vision plugin.
 *
 * Spins up an in-process mock OpenAI-compatible server (llama-server stand-in),
 * loads the plugin from lib/index.js, registers it on a minimal fake `ctx.tools`,
 * and asserts the tool's schema, request wire format, error handling, and config
 * validation. No real model or network access required.
 *
 * The tool now reads images from the durable attachment store (pasted images)
 * rather than file paths.  The fake context therefore provides:
 *   - `ctx.get('attachments')` → a mock `readImage(ref)` returning the test
 *     image bytes plus the same ref;
 *   - `exec.agent.session.events` → a synthetic event log containing one
 *     image block whose `attachmentId` matches the one passed to the tool.
 *
 * Run: node tests/smoke.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../lib/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_IMAGE = path.join(ROOT, 'fixtures', 'vision_test.png');

// A stable attachment id used across tests.  The real store uses sha256, but
// the tool only compares strings, so any unique value works for testing.
const TEST_ATTACHMENT_ID = 'sha256:deadbeef'.padEnd(71, '0');

/** Cached test-image bytes + ref so every call shares one read. */
let testImageFixture = null;
async function loadTestImageFixture() {
    if (testImageFixture) return testImageFixture;
    const data = new Uint8Array(await readFile(TEST_IMAGE));
    const ref = {
        attachmentId: TEST_ATTACHMENT_ID,
        mediaType: 'image/png',
        bytes: data.byteLength,
        width: 4,
        height: 4,
    };
    testImageFixture = { data, ref };
    return testImageFixture;
}

/** Build a synthetic session event containing one image block. */
function makeEvents(attachmentId, mediaType = 'image/png') {
    return [
        {
            type: 'user/message',
            seq: 0,
            data: {
                content: [
                    { type: 'text', text: '请识别这张图片' },
                    {
                        type: 'image',
                        attachment: {
                            attachmentId,
                            mediaType,
                            bytes: 100,
                            width: 4,
                            height: 4,
                        },
                    },
                ],
            },
        },
    ];
}

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
            lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
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

/**
 * Minimal registrant context: `ctx.tools` for apply(), `ctx.get('attachments')`
 * for the mock attachment store, and `ctx.on('dispose')` for cleanup.
 */
function fakeCtx() {
    let registered = null;
    const disposers = [];
    return {
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
        get registered() {
            return registered;
        },
    };
}

/**
 * Build a mock `attachments` service whose `readImage(ref)` returns the test
 * image bytes.  Only the fields the tool touches are implemented.
 */
function mockAttachments() {
    return {
        imageLimits: {
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
            maxImageBytes: 30 * 1024 * 1024,
        },
        async readImage(ref) {
            const fixture = await loadTestImageFixture();
            // Return the fixture bytes regardless of which ref is requested —
            // tests that need a different image can swap this out.
            return { ref, data: fixture.data };
        },
    };
}

/** Build the `exec` argument the tool expects: signal + agent.session.events. */
function makeExec({ attachmentId = TEST_ATTACHMENT_ID, mediaType = 'image/png', events } = {}) {
    return {
        signal: new AbortController().signal,
        agent: {
            session: {
                events: events ?? makeEvents(attachmentId, mediaType),
            },
        },
    };
}

/** Create a unique temp directory and return its path. */
function mkdtemp() {
    return new Promise((resolve, reject) => {
        import('node:fs/promises').then((fs) => {
            fs.mkdtemp(path.join(os.tmpdir(), 'vision-test-')).then(resolve, reject);
        });
    });
}

/** Reserve a free TCP port and release it (race window acceptable in tests). */
async function freePort() {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

/** Poll GET /v1/models until it stops answering, or fail after timeoutMs. */
async function waitForPortClosed(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
                signal: AbortSignal.timeout(500),
            });
            if (!response.ok) return;
        } catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`port ${port} still answering after ${timeoutMs}ms`);
}

async function main() {
    // Ensure the test image fixture is loaded once.
    await loadTestImageFixture();

    // 1. Registration + schema shape.
    {
        const ctx = fakeCtx();
        ctx.get = () => mockAttachments();
        apply(ctx, {});
        assert.ok(ctx.registered, 'apply() must register a tool');
        assert.equal(ctx.registered.name, 'vision');
        assert.equal(ctx.registered.parameters.required[0], 'attachmentId');
        assert.equal(ctx.registered.parameters.additionalProperties, false);
        assert.equal(typeof ctx.registered.execute, 'function');
        assert.equal(typeof ctx.registered.output.render, 'function');
        // The output schema must use JSON-Schema form. Per-property
        // `required: true` is outside the runtime's supported subset and makes
        // the real `ctx.tools.register` throw at mount time — the fake registry
        // here would silently accept it, so assert the shape explicitly.
        assert.deepEqual(ctx.registered.output.schema.required, ['text', 'model', 'durationMs']);
        for (const [name, prop] of Object.entries(ctx.registered.output.schema.properties)) {
            assert.ok(
                !Object.hasOwn(prop, 'required'),
                `output property "${name}" must not declare per-property required`,
            );
        }
        assert.equal(ctx.registered.output.schema.additionalProperties, false);
        console.log('ok 1 — registration + schema');
    }

    // 2. Config validation fails loud.
    {
        const ctx = fakeCtx();
        ctx.get = () => mockAttachments();
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
            ctx.get = () => mockAttachments();
            apply(ctx, { baseUrl: mock.url });
            const result = await ctx.registered.execute(
                { attachmentId: TEST_ATTACHMENT_ID, prompt: '描述这张图' },
                makeExec(),
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
            ctx.get = () => mockAttachments();
            apply(ctx, { baseUrl: mock.url, defaultPrompt: '看图说话' });
            await ctx.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec());
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
            ctx.get = () => mockAttachments();
            apply(ctx, { baseUrl: mock.url, model: '' });
            const result = await ctx.registered.execute(
                { attachmentId: TEST_ATTACHMENT_ID },
                makeExec(),
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
            ctx.get = () => mockAttachments();
            apply(ctx, { baseUrl: mock.url });
            await assert.rejects(
                ctx.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec()),
                /HTTP 500/,
            );
        } finally {
            await mock.close();
        }
        console.log('ok 6 — server error propagation');
    }

    // 7. Missing / unknown attachment id errors.
    {
        const ctx = fakeCtx();
        // attachments with a root pointing nowhere — the fallback store read
        // will fail because the file doesn't exist.
        ctx.get = () => ({ root: '/tmp/vision-test-nonexistent-' + Date.now() });
        apply(ctx, {});
        // A valid 64-hex sha256 that doesn't exist in events or store:
        // falls through to readFromStore, which fails with "not found".
        const ghostHash = 'f'.repeat(64);
        await assert.rejects(
            ctx.registered.execute({ attachmentId: 'sha256:' + ghostHash }, makeExec()),
            /not found in the attachment store/,
        );
        // Empty attachmentId is rejected before any service lookup.
        await assert.rejects(
            ctx.registered.execute({ attachmentId: '' }, makeExec()),
            /attachmentId.*must be a non-empty/,
        );
        console.log('ok 7 — unknown / empty attachment id errors');
    }

    // 8. Connection refused yields a friendly error.
    {
        const ctx = fakeCtx();
        ctx.get = () => mockAttachments();
        apply(ctx, { baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 2000 });
        await assert.rejects(
            ctx.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec()),
            /failed to reach the vision server/,
        );
        console.log('ok 8 — unreachable server error');
    }

    // 9. autoStart spawns a missing server, the call succeeds, and the child
    //    exits after the call when keepAliveMs is 0.
    {
        const port = await freePort();
        const mockServer = path.join(ROOT, 'fixtures', 'mock-server-ondemand.mjs');
        const ctx = fakeCtx();
        ctx.get = () => mockAttachments();
        apply(ctx, {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            autoStart: true,
            serverCommand: `node "${mockServer}" ${port}`,
            keepAliveMs: 0,
            startupTimeoutMs: 10000,
        });
        const result = await ctx.registered.execute(
            { attachmentId: TEST_ATTACHMENT_ID, prompt: '描述' },
            makeExec(),
        );
        assert.equal(result.text, 'ondemand 描述');
        assert.equal(result.model, 'ondemand-vision');
        await waitForPortClosed(port, 5000);
        console.log('ok 9 — autoStart spawn + exit after use');
    }

    // 10. keepAliveMs keeps the auto-started server alive across calls; the
    //     plugin dispose stops it even while kept alive.
    {
        const port = await freePort();
        const mockServer = path.join(ROOT, 'fixtures', 'mock-server-ondemand.mjs');
        const ctx = fakeCtx();
        ctx.get = () => mockAttachments();
        apply(ctx, {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            autoStart: true,
            serverCommand: `node "${mockServer}" ${port}`,
            keepAliveMs: 60000,
            startupTimeoutMs: 10000,
        });
        const result = await ctx.registered.execute(
            { attachmentId: TEST_ATTACHMENT_ID },
            makeExec(),
        );
        assert.equal(result.text, 'ondemand 描述');
        // Still up because keepAliveMs is large.
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
        assert.ok(response.ok, 'auto-started server should survive while keepAliveMs > 0');
        // A second call reuses the running server.
        await ctx.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec());
        ctx.dispose();
        await waitForPortClosed(port, 5000);
        console.log('ok 10 — keepAliveMs retention + dispose cleanup');
    }

    // 11. autoStart with a broken command fails loud (exited early) instead of
    //     hanging until the startup timeout.
    {
        const port = await freePort();
        const ctx = fakeCtx();
        ctx.get = () => mockAttachments();
        apply(ctx, {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            autoStart: true,
            serverCommand: 'node /no/such/mock-server.mjs',
            startupTimeoutMs: 10000,
        });
        await assert.rejects(
            ctx.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec()),
            /auto-started server exited early/,
        );
        console.log('ok 11 — broken autoStart command fails loud');
    }

    // 12. autoStart off + reachable external server: no spawn, works as before.
    {
        const mock = await startMockServer({});
        try {
            const ctx = fakeCtx();
            ctx.get = () => mockAttachments();
            apply(ctx, { baseUrl: mock.url, autoStart: true });
            const result = await ctx.registered.execute(
                { attachmentId: TEST_ATTACHMENT_ID },
                makeExec(),
            );
            assert.equal(result.text, '图中有一个红色圆形和一个蓝色正方形。');
        } finally {
            await mock.close();
        }
        console.log('ok 12 — external server takes precedence over autoStart');
    }

    // 13. apiKey (raw string) is sent as `Authorization: Bearer` on every request.
    {
        const mock = await startMockServer({});
        try {
            const ctx = fakeCtx();
            ctx.get = () => mockAttachments();
            apply(ctx, { baseUrl: mock.url, model: 'gpt-4o', apiKey: 'sk-test-123' });
            await ctx.registered.execute(
                { attachmentId: TEST_ATTACHMENT_ID, prompt: '描述' },
                makeExec(),
            );
            assert.equal(mock.lastRequest.headers.authorization, 'Bearer sk-test-123');
            // Auto-detection path must authenticate too: /v1/models got the header.
            const ctx2 = fakeCtx();
            ctx2.get = () => mockAttachments();
            apply(ctx2, { baseUrl: mock.url, apiKey: 'sk-test-456' });
            await ctx2.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec());
            assert.equal(mock.lastRequest.headers.authorization, 'Bearer sk-test-456');
        } finally {
            await mock.close();
        }
        console.log('ok 13 — apiKey sent as Authorization: Bearer');
    }

    // 14. apiKey via env:NAME reference; missing env fails loud at apply().
    {
        const mock = await startMockServer({});
        try {
            process.env.VISION_TEST_API_KEY = 'sk-env-789';
            try {
                const ctx = fakeCtx();
                ctx.get = () => mockAttachments();
                apply(ctx, { baseUrl: mock.url, apiKey: 'env:VISION_TEST_API_KEY' });
                await ctx.registered.execute(
                    { attachmentId: TEST_ATTACHMENT_ID, prompt: '描述' },
                    makeExec(),
                );
                assert.equal(mock.lastRequest.headers.authorization, 'Bearer sk-env-789');
            } finally {
                delete process.env.VISION_TEST_API_KEY;
            }
            const ctx2 = fakeCtx();
            ctx2.get = () => mockAttachments();
            assert.throws(
                () => apply(ctx2, { apiKey: 'env:VISION_TEST_API_KEY' }),
                /env var "VISION_TEST_API_KEY" .* is not set/,
            );
        } finally {
            await mock.close();
        }
        console.log('ok 14 — apiKey env:NAME reference + missing-env fail loud');
    }

    // 15. No attachment service mounted → clear error.
    {
        const ctx = fakeCtx();
        // ctx.get returns undefined for any key (no attachments service).
        ctx.get = () => undefined;
        apply(ctx, {});
        await assert.rejects(
            ctx.registered.execute({ attachmentId: TEST_ATTACHMENT_ID }, makeExec()),
            /no attachment service is mounted/,
        );
        console.log('ok 15 — missing attachment service error');
    }

    // 16. Image larger than maxImageBytes is rejected before reading.
    {
        const mock = await startMockServer({});
        try {
            const ctx = fakeCtx();
            // Custom attachments whose ref reports a huge byte count.
            ctx.get = () => ({
                imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 30 * 1024 * 1024 },
                async readImage(ref) {
                    return { ref, data: new Uint8Array(0) };
                },
            });
            apply(ctx, { baseUrl: mock.url, maxImageBytes: 1000 });
            // Override the event to report a large image.
            const bigEvents = makeEvents(TEST_ATTACHMENT_ID);
            bigEvents[0].data.content[1].attachment.bytes = 999_999;
            await assert.rejects(
                ctx.registered.execute(
                    { attachmentId: TEST_ATTACHMENT_ID },
                    makeExec({ events: bigEvents }),
                ),
                /image too large/,
            );
        } finally {
            await mock.close();
        }
        console.log('ok 16 — oversized image rejected');
    }

    // 17. Fallback: attachment NOT in session events → read directly from the
    //     attachment store (paste-image plugin flow for text-only models).
    {
        const mock = await startMockServer({});
        const tmpStore = await mkdtemp();
        try {
            const fixture = await loadTestImageFixture();
            const hash = createHash('sha256').update(fixture.data).digest('hex');
            const attachmentId = 'sha256:' + hash;
            // Create the store layout: <root>/objects/<hash[:2]>/<hash>
            const storeFile = path.join(tmpStore, 'objects', hash.slice(0, 2), hash);
            await mkdir(path.dirname(storeFile), { recursive: true });
            await writeFile(storeFile, fixture.data);

            const ctx = fakeCtx();
            // attachments service exposes `root` (LocalAttachmentStore does);
            // no readImage needed — the fallback reads the file directly.
            ctx.get = () => ({ root: tmpStore });
            apply(ctx, { baseUrl: mock.url });

            // exec with NO session events — simulates paste-image plugin flow.
            const exec = {
                signal: new AbortController().signal,
                agent: { session: { events: [] } },
            };
            const result = await ctx.registered.execute(
                { attachmentId, prompt: '描述这张图' },
                exec,
            );
            assert.equal(result.text, '图中有一个红色圆形和一个蓝色正方形。');
            assert.equal(result.model, 'mock-vision-9b');
            // The wire request must carry the image as a data URI.
            const sent = mock.lastRequest;
            const imageBlock = sent.body.messages[0].content[1];
            assert.equal(imageBlock.type, 'image_url');
            assert.ok(imageBlock.image_url.url.startsWith('data:image/png;base64,'));
        } finally {
            await mock.close();
            await rm(tmpStore, { recursive: true, force: true });
        }
        console.log('ok 17 — fallback store read (paste-image plugin flow)');
    }

    // 18. Fallback: invalid attachmentId format → clear error.
    {
        const ctx = fakeCtx();
        ctx.get = () => ({ root: '/tmp/nonexistent-store' });
        apply(ctx, {});
        await assert.rejects(
            ctx.registered.execute(
                { attachmentId: 'not-a-valid-id' },
                { signal: new AbortController().signal, agent: { session: { events: [] } } },
            ),
            /does not look like a valid sha256/,
        );
        console.log('ok 18 — invalid attachmentId rejected (fallback path)');
    }

    // 19. Fallback: valid sha256 but file not in store → clear error.
    {
        const ctx = fakeCtx();
        ctx.get = () => ({ root: '/tmp/nonexistent-store-' + Date.now() });
        apply(ctx, {});
        const fakeHash = 'a'.repeat(64);
        await assert.rejects(
            ctx.registered.execute(
                { attachmentId: 'sha256:' + fakeHash },
                { signal: new AbortController().signal, agent: { session: { events: [] } } },
            ),
            /not found in the attachment store/,
        );
        console.log('ok 19 — missing store file rejected (fallback path)');
    }

    console.log('\nall smoke tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
