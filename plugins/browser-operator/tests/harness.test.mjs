/**
 * `tests/harness.mjs` 自己的测试 —— 守卫不能只靠「读代码」保证。
 *
 * 这里用一个**临时的 harness 实例**装故意坏掉的用例,所以真实那本账不会被弄脏:
 * 断言的是临时 harness 的计数与输出,不是本文件的运行结果。
 *
 * 运行: node plugins/browser-operator/tests/harness.test.mjs
 */

import assert from 'node:assert/strict';

import { createHarness } from './harness.mjs';

const { checkAsync, run } = createHarness({ assert });

/** 用一个临时 harness 跑一段登记/收工的动作,把它的输出与计数收回来。 */
async function withTempHarness(body) {
    const lines = [];
    const temp = createHarness({
        assert,
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
        exit: () => {},
    });
    await body(temp);
    const passed = await temp.run();
    return { passed, lines, state: temp.state, output: lines.join('\n') };
}

checkAsync('runner 之后登记 checkAsync 会抛错,而不是被静默丢掉', async () => {
    let threw = null;
    const temp = createHarness({ assert, log: () => {}, error: () => {}, exit: () => {} });
    temp.checkAsync('before', async () => {});
    await temp.run();
    try {
        temp.checkAsync('after', async () => {});
    } catch (error) {
        threw = error;
    }
    assert.ok(threw !== null, 'runner 之后登记该抛错');
    assert.match(threw.message, /runner 之后登记/);
    // 关键:它**没有**被收进队列,所以 runner 早就收工了 —— 这条用例永远不会跑。
    assert.equal(temp.state.passed, 1);
    assert.equal(temp.state.failures.length, 0);
});

checkAsync('runner 之后迟到的失败用例不会伪造「全部通过」', async () => {
    // 复刻 review 的复现:把一条**注定失败**的 checkAsync 放在 runner 之后。
    // 修复前它被静默丢掉,于是 runner 照报「全部通过」,而那条用例从未跑过。
    let lateBodyRan = false;
    const result = await withTempHarness(async (temp) => {
        temp.checkAsync('earlier', async () => {});
        assert.equal(await temp.run(), true, 'runner 先正常收工');
        try {
            temp.checkAsync('late failure', async () => {
                lateBodyRan = true;
                assert.fail('这条用例永远不会跑');
            });
        } catch {
            // 守卫抛错即为期望结果;重要的是下面的账本。
        }
    });
    assert.equal(lateBodyRan, false, '迟到的用例体从未执行');
    assert.equal(result.state.failures.length, 0, '它从未进队列,所以没有失败记录');
    assert.equal(result.state.passed, 1, '只有先登记的那条算数');
});

checkAsync('runner 之后登记 check 同样会抛错', async () => {
    const temp = createHarness({ assert, log: () => {}, error: () => {}, exit: () => {} });
    temp.check('before', () => {});
    await temp.run();
    assert.throws(() => temp.check('after', () => {}), /runner 之后登记/);
});

checkAsync('把 async 函数喂给同步 check 会报错,而不是记成 ok', async () => {
    const result = await withTempHarness(async (temp) => {
        temp.check('async 用例', async () => {});
    });
    assert.equal(result.state.passed, 0, 'async 函数不该被记成通过');
    assert.equal(result.state.failures.length, 1);
    assert.match(result.output, /not ok - async 用例/);
    assert.match(result.output, /checkAsync/);
    assert.equal(result.passed, false, '有失败就该是非零退出');
});

checkAsync('返回 thenable 但断言已失败的同步 check 也不会记成 ok', async () => {
    const result = await withTempHarness(async (temp) => {
        temp.check('伪装的 thenable', () => Promise.reject(new Error('稍后才炸')));
    });
    assert.equal(result.state.passed, 0);
    assert.equal(result.state.failures.length, 1);
    assert.match(result.output, /thenable/);
});

checkAsync('真正的同步 check 照旧记 ok', async () => {
    const result = await withTempHarness(async (temp) => {
        temp.check('同步用例', () => {});
    });
    assert.equal(result.state.passed, 1);
    assert.match(result.output, /ok - 同步用例/);
    assert.equal(result.passed, true);
});

checkAsync('临时 harness 里失败的异步用例会走非零退出', async () => {
    let exitCode = null;
    const temp = createHarness({
        assert,
        log: () => {},
        error: () => {},
        exit: (code) => {
            exitCode = code;
        },
    });
    temp.checkAsync('真的会失败', async () => {
        assert.fail('boom');
    });
    assert.equal(await temp.run(), false, '有失败时 run 该返回 false');
    assert.equal(exitCode, 1, '有失败就该 exit(1)');
});

await run();
