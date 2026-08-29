/**
 * Regression tests for the paste-image host half (lib/index.js).
 *
 * The host wraps `apiProxy.sessions.prompt`: when the gate rejects an image
 * prompt with MODEL_DOES_NOT_SUPPORT_IMAGES (text-only model), it saves the
 * image through `attachments.saveImage` and replaces image blocks with
 * `[已粘贴图片: sha256:…]` text markers, then retries the prompt.
 *
 * Run: node plugins/obsolete/paste-image/tests/save.test.mjs
 */

import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** Build the fake ctx: mock apiProxy.sessions.prompt + attachments service. */
function fakeCtx({ promptImpl }) {
    const saveCalls = [];
    const mockAttachments = {
        imageLimits: {
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
            maxImageBytes: 30 * 1024 * 1024,
        },
        async validateImage() {},
        async saveImage(input) {
            saveCalls.push(input);
            return {
                attachmentId: 'sha256:mock' + '0'.repeat(58),
                mediaType: input.mediaType,
                bytes: input.data.byteLength,
                width: 4,
                height: 4,
                ...(input.name !== undefined ? { name: input.name } : {}),
            };
        },
        async readImage(ref) {
            return { ref, data: new Uint8Array(0) };
        },
    };
    const promptCalls = [];
    const sessions = {
        async prompt(request) {
            promptCalls.push(JSON.parse(JSON.stringify(request)));
            if (typeof promptImpl === 'function') return promptImpl(request);
            return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } };
        },
    };
    const ctx = {
        apiProxy: { sessions },
        attachments: mockAttachments,
        get(key) {
            if (key === 'attachments') return mockAttachments;
            if (key === 'apiProxy') return { sessions };
            return undefined;
        },
        get saveCalls() {
            return saveCalls;
        },
        get promptCalls() {
            return promptCalls;
        },
        get sessions() {
            return sessions;
        },
    };
    return ctx;
}

/** A MODEL_DOES_NOT_SUPPORT_IMAGES rejection shaped like apiproxy's err(). */
function modelDoesNotSupportImages(request) {
    return {
        rpcId: request.rpcId,
        result: {
            ok: false,
            error: {
                code: 'attachment-error',
                message: 'Model "glm-5.2" does not support image input.',
                details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            },
        },
    };
}

function imagePrompt({
    text = '看看这张图',
    mediaType = 'image/png',
    data = 'aGVsbG8=',
    name,
} = {}) {
    return {
        rpcId: 'rpc-1',
        payload: {
            sessionId: 's1',
            mode: 'queue',
            content: [
                { type: 'text', text },
                { type: 'image', mediaType, data, ...(name !== undefined ? { name } : {}) },
            ],
        },
    };
}

async function main() {
    // 1. Text-only model: first attempt rejected → images converted to markers
    //    → retried with text-only content → success returned.
    {
        const ctx = fakeCtx({
            promptImpl(request) {
                const hasImage = request.payload.content.some((p) => p.type === 'image');
                return hasImage
                    ? modelDoesNotSupportImages(request)
                    : { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } };
            },
        });
        apply(ctx, {});
        const request = imagePrompt({ name: 'shot.png' });
        const result = await ctx.sessions.prompt(request);
        assert.equal(result.result.ok, true, 'retry must succeed');
        // saveImage was called with the decoded bytes + mediaType + name.
        assert.equal(ctx.saveCalls.length, 1);
        assert.equal(ctx.saveCalls[0].mediaType, 'image/png');
        assert.equal(ctx.saveCalls[0].name, 'shot.png');
        assert.equal(Buffer.from(ctx.saveCalls[0].data).toString('base64'), 'aGVsbG8=');
        // The retried request has the marker text instead of the image block.
        const retried = ctx.promptCalls[1];
        assert.equal(retried.payload.content.length, 2);
        assert.equal(retried.payload.content[0].type, 'text');
        assert.equal(retried.payload.content[1].type, 'text');
        assert.match(retried.payload.content[1].text, /^\[已粘贴图片: sha256:mock0+\]$/);
        console.log('ok 1 — image converted to marker, retry succeeds');
    }

    // 2. Model supports images: first attempt succeeds → no conversion, no retry.
    {
        const ctx = fakeCtx({
            promptImpl(request) {
                return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } };
            },
        });
        apply(ctx, {});
        const request = imagePrompt();
        const result = await ctx.sessions.prompt(request);
        assert.equal(result.result.ok, true);
        assert.equal(ctx.saveCalls.length, 0, 'no save when model accepts images');
        assert.equal(ctx.promptCalls.length, 1, 'no retry when model accepts images');
        console.log('ok 2 — image-capable model: no conversion');
    }

    // 3. Non-image rejection (e.g. too large) is NOT converted/retried.
    {
        const ctx = fakeCtx({
            promptImpl(request) {
                return {
                    rpcId: request.rpcId,
                    result: {
                        ok: false,
                        error: {
                            code: 'attachment-error',
                            message: 'Image exceeds the configured byte limit.',
                            details: { reason: 'IMAGE_TOO_LARGE' },
                        },
                    },
                };
            },
        });
        apply(ctx, {});
        const request = imagePrompt();
        const result = await ctx.sessions.prompt(request);
        assert.equal(result.result.ok, false);
        assert.equal(result.result.error.details.reason, 'IMAGE_TOO_LARGE');
        assert.equal(ctx.saveCalls.length, 0);
        assert.equal(ctx.promptCalls.length, 1, 'must not retry on non-model rejection');
        console.log('ok 3 — other rejections pass through untouched');
    }

    // 4. saveImage failure surfaces a PASTE_IMAGE_SAVE_FAILED error, no retry.
    {
        const ctx = fakeCtx({
            promptImpl(request) {
                return modelDoesNotSupportImages(request);
            },
        });
        ctx.attachments.saveImage = async () => {
            throw new Error('boom');
        };
        apply(ctx, {});
        const request = imagePrompt();
        const result = await ctx.sessions.prompt(request);
        assert.equal(result.result.ok, false);
        assert.equal(result.result.error.details.reason, 'PASTE_IMAGE_SAVE_FAILED');
        assert.match(result.result.error.message, /boom/);
        assert.equal(ctx.promptCalls.length, 1, 'no retry after save failure');
        console.log('ok 4 — save failure surfaces clear error');
    }

    // 5. No apiProxy mounted: apply() exits silently without throwing.
    {
        const ctx = {
            apiProxy: undefined,
            get() {
                return undefined;
            },
        };
        assert.doesNotThrow(() => apply(ctx, {}));
        console.log('ok 5 — missing apiProxy handled gracefully');
    }

    console.log('\nall paste-image host tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
