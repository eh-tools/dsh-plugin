/**
 * Regression tests for the paste-image host half (lib/index.js).
 *
 * Drives the REAL route handler the browser hits (POST /paste-image/api/save)
 * through a fake ctx. The fake `ctx.shell` is wired to reproduce the exact
 * production failure — the agent sandbox denies the write (seatbelt read-only
 * mkdir EPERM: "Operation not permitted") — so a host half that routes its
 * write through `ctx.shell` fails here. The fixed host half writes with
 * node:fs directly and never touches the shell.
 *
 * Run: node plugins/paste-image/tests/save.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

/** A fake ctx.shell that reproduces the production read-only sandbox denial. */
function denyingShell() {
    const calls = [];
    return {
        resolve: (spec) => spec,
        async run(spec) {
            calls.push(spec);
            return {
                exitCode: 1,
                stderr: { text: 'mkdir: /x/attachments: Operation not permitted' },
            };
        },
        get calls() {
            return calls;
        },
    };
}

/** Build the fake ctx and capture the registered route handler entry. */
function fakeCtx({ cwd, shell }) {
    let entry = null;
    return {
        webServer: {
            register(route) {
                entry = route;
            },
        },
        sessions: {
            get(id) {
                return id === 's1' ? { header: { cwd } } : undefined;
            },
        },
        shell,
        get route() {
            return entry;
        },
    };
}

/** A minimal IncomingMessage stand-in: headers/method/url + async body chunks. */
function jsonRequest({ url, body, host = '127.0.0.1:3080', method = 'POST', headers = {} }) {
    const chunks = [Buffer.from(JSON.stringify(body))];
    return {
        method,
        url,
        headers: { host, 'x-dsh-plugin': '1', ...headers },
        [Symbol.asyncIterator]: async function* () {
            for (const chunk of chunks) yield chunk;
        },
    };
}

/** A minimal ServerResponse stand-in capturing status and payload. */
function fakeRes() {
    let status = 0;
    let payload = '';
    return {
        writeHead(code) {
            status = code;
        },
        end(text) {
            payload = text;
        },
        get status() {
            return status;
        },
        get json() {
            return payload ? JSON.parse(payload) : null;
        },
    };
}

/** A tiny but real PNG-ish byte payload (any non-empty bytes will do). */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

async function main() {
    const tmp = await mkdtemp(path.join(tmpdir(), 'paste-image-test-'));
    try {
        const shell = denyingShell();
        const ctx = fakeCtx({ cwd: tmp, shell });
        apply(ctx, {});
        assert.ok(ctx.route, 'apply() must register a route');
        assert.equal(ctx.route.kind, 'prefix');
        assert.equal(ctx.route.path, '/paste-image/api');
        const handler = ctx.route.handler;

        // 1. Happy path: the image lands at <cwd>/attachments/<ts>-<name> with
        //    the exact decoded bytes — even though ctx.shell would deny it.
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    body: {
                        sessionId: 's1',
                        name: 'shot (1).png',
                        mediaType: 'image/png',
                        data: PNG_BYTES.toString('base64'),
                    },
                }),
                res,
            );
            assert.equal(res.status, 200);
            const saved = res.json;
            assert.ok(saved.path.startsWith(`${tmp}/attachments/`), `path in cwd: ${saved.path}`);
            assert.ok(saved.path.endsWith('-shot__1_.png'), `sanitized name: ${saved.path}`);
            assert.deepEqual(await readFile(saved.path), PNG_BYTES);
            const entries = await readdir(path.join(tmp, 'attachments'));
            assert.equal(entries.length, 1);
            assert.equal(shell.calls.length, 0, 'write must NOT go through ctx.shell');
            console.log('ok 1 — happy path writes via node:fs despite sandbox-denying shell');
        }

        // 2. Untrusted Host header is rejected before any handling.
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    host: 'evil.example',
                    body: { sessionId: 's1', name: 'a.png', mediaType: 'image/png', data: 'x' },
                }),
                res,
            );
            assert.equal(res.status, 403);
            assert.equal(res.json.ok, false);
            console.log('ok 2 — untrusted Host rejected (403)');
        }

        // 3. Non-POST method rejected.
        {
            const res = fakeRes();
            await handler(
                jsonRequest({ url: '/paste-image/api/save', method: 'GET', body: {} }),
                res,
            );
            assert.equal(res.status, 405);
            console.log('ok 3 — non-POST rejected (405)');
        }

        // 4. Unknown subroute rejected.
        {
            const res = fakeRes();
            await handler(jsonRequest({ url: '/paste-image/api/other', body: {} }), res);
            assert.equal(res.status, 404);
            console.log('ok 4 — unknown route rejected (404)');
        }

        // 5. Validation errors surface as 400 with a readable message.
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    body: { sessionId: 's1', name: 'a.png', mediaType: 'image/tiff', data: 'x' },
                }),
                res,
            );
            assert.equal(res.status, 400);
            assert.match(res.json.error, /unsupported media type/);
            console.log('ok 5 — unsupported media type rejected (400)');
        }
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    body: { sessionId: 's1', name: 'a.png', mediaType: 'image/png', data: '' },
                }),
                res,
            );
            assert.equal(res.status, 400);
            assert.match(res.json.error, /empty image data/);
            console.log('ok 6 — empty image data rejected (400)');
        }
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    body: { sessionId: 'nope', name: 'a.png', mediaType: 'image/png', data: 'x' },
                }),
                res,
            );
            assert.equal(res.status, 400);
            assert.match(res.json.error, /unknown session/);
            console.log('ok 7 — unknown session rejected (400)');
        }

        // 6. Oversized image (base64 of 30MiB+1 byte) rejected before writing.
        {
            const big = Buffer.alloc(30 * 1024 * 1024 + 1, 0x61);
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    body: {
                        sessionId: 's1',
                        name: 'big.png',
                        mediaType: 'image/png',
                        data: big.toString('base64'),
                    },
                }),
                res,
            );
            assert.equal(res.status, 400);
            assert.match(res.json.error, /image too large/);
            const entries = await readdir(path.join(tmp, 'attachments'));
            assert.equal(entries.length, 1, 'oversized image must not be written');
            console.log('ok 8 — oversized image rejected (400), nothing written');
        }

        // 7. Missing CSRF header is rejected before any handling.
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    headers: { 'x-dsh-plugin': undefined },
                    body: { sessionId: 's1', name: 'a.png', mediaType: 'image/png', data: 'x' },
                }),
                res,
            );
            assert.equal(res.status, 403);
            assert.equal(res.json.ok, false);
            console.log('ok 9 — missing CSRF header rejected (403)');
        }

        // 8. Default filename extension follows mediaType when name is empty.
        {
            const res = fakeRes();
            await handler(
                jsonRequest({
                    url: '/paste-image/api/save',
                    body: {
                        sessionId: 's1',
                        name: '',
                        mediaType: 'image/webp',
                        data: PNG_BYTES.toString('base64'),
                    },
                }),
                res,
            );
            assert.equal(res.status, 200);
            const saved = res.json;
            assert.ok(saved.path.endsWith('.webp'), `expected .webp, got ${saved.path}`);
            assert.deepEqual(await readFile(saved.path), PNG_BYTES);
            console.log('ok 10 — empty name uses mediaType extension (.webp)');
        }

        console.log('\nall paste-image host tests passed');
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
