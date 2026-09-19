/**
 * browser-operator 离线单测的最小 harness。
 *
 * 单独成模块,**是为了让 harness 自己的守卫能被断言** —— 见 tests/harness.test.mjs。
 * 之前在 tests/policy.test.mjs 里,「runner 之后还能登记 check」这类缺陷没有任何用例
 * 能钉住,于是它一路活到 review。
 *
 * 约定:用例**只能登记在 runner 之前**(也就是文件按「导入 → 登记 → runner」的顺序写)。
 * `check` / `checkAsync` 在 runner 开始之后再被调用会**抛错**,而不是悄悄收下 ——
 * 静默丢弃一条用例正是这个 harness 存在的意义所反对的。
 *
 * 输出格式与仓库里既有的手写 runner 一致:`ok - <label>` / `not ok - <label> :: <msg>`,
 * 结尾 `全部通过:N 项` 或 `M 项失败 / 共 N 项` + `process.exit(1)`。
 */

/**
 * 造一个独立的 harness。测试之间的状态(计数、runner 相位)彼此隔离,
 * 所以自测用例可以在一个临时 harness 上放故意失败的用例,而不弄脏真实那本账。
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.log] 通过行往哪写,默认 `console.log`
 * @param {(line: string) => void} [options.error] 失败行与汇总往哪写,默认 `console.error`
 * @param {(code: number) => void} [options.exit] 非零退出怎么走,默认 `process.exit`
 * @param {import('node:assert/strict')} [options.assert] 断言库,必传(用它的 `fail` 报 thenable)
 */
export function createHarness({ log = console.log, error = console.error, exit, assert } = {}) {
    if (typeof assert?.fail !== 'function') {
        throw new Error(
            'browser-operator: createHarness 需要一个 assert 实现(assert.fail 必须是函数)',
        );
    }
    const doExit = exit ?? ((code) => process.exit(code));

    let passed = 0;
    const failures = [];
    /** runner 的相位:`register` 收用例,`running` 正在 await,`done` 已收工。 */
    let phase = 'register';

    /** 记一次结果。同步 check 与异步 check 共用,断言细节由调用方给。 */
    function record(label, failure) {
        if (failure === undefined) {
            passed += 1;
            log('ok - ' + label);
            return;
        }
        failures.push(`${label} :: ${failure?.message ?? String(failure)}`);
        error('not ok - ' + label + ' :: ' + (failure?.message ?? String(failure)));
    }

    /**
     * runner 开工后还敢登记用例的守卫。**这是本 harness 的核心不变量**:
     * 用例登记在 runner 之后 = 永远不会跑 = 失败不可观测。
     */
    function assertCanRegister(kind) {
        if (phase !== 'register') {
            throw new Error(
                `browser-operator: ${kind} 不能在 runner 之后登记 —— 那条用例永远不会跑,失败会被静默吞掉。` +
                    '请把登记移到文件里 runner 之前的位置。',
            );
        }
    }

    /** 同步用例。`fn` 必须是同步函数:返回 thenable 就说明该用 `checkAsync`。 */
    function check(label, fn) {
        assertCanRegister('check');
        try {
            const result = fn();
            if (typeof result?.then === 'function') {
                // 别把它当未处理的 rejection 丢掉 —— 那正是同步 harness 吞掉异步失败的方式。
                result.catch(() => {});
                assert.fail(
                    `browser-operator: check('${label}') 的回调返回了 thenable(多半是 async 函数);` +
                        '同步 check 不 await 它,断言失败只能变成未处理的 rejection。请改用 checkAsync。',
                );
            }
            record(label);
        } catch (failure) {
            record(label, failure);
        }
    }

    /**
     * 异步用例:只**登记**,由 runner 统一 await —— 否则失败的断言只会变成未处理的
     * rejection,进程照样 exit 0,门禁就瞎了。
     */
    const queue = [];
    function checkAsync(label, fn) {
        assertCanRegister('checkAsync');
        queue.push({ label, fn });
    }

    /** 登记闸门落下的那一刻之后的登记都算越界 —— 由 runner 在 await 之前调用。 */
    function beginRun() {
        phase = 'running';
    }

    /**
     * 跑登记在案的异步用例。放在文件末尾。
     *
     * 报「失败条数 + 总数」并 `exit(1)`,与同步用例的失败合并计数。
     */
    async function run() {
        beginRun();
        const registered = queue.splice(0, queue.length);
        for (const { label, fn } of registered) {
            try {
                await fn();
                record(label);
            } catch (failure) {
                record(label, failure);
            }
        }
        phase = 'done';
        if (failures.length > 0) {
            error(`\n${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
            doExit(1);
            return false;
        }
        log(`\n全部通过:${passed} 项`);
        return true;
    }

    const state = {
        get passed() {
            return passed;
        },
        get phase() {
            return phase;
        },
        failures,
    };

    return { check, checkAsync, run, state };
}
