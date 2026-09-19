/**
 * Jev 客户端与凭证。
 *
 * 凭证只走 `ctx.credentials` —— 那个服务自己就分层覆盖 process env / provider
 * store / `.env`,所以这里**不**自己读 `process.env`。服务契约要求每次操作重新
 * 解析、不跨操作缓存。
 *
 * @module dsh-browser-operator/jev
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';

/** 环境变量名即 `CredentialRef`(运行时就是个 POSIX 环境变量名字符串)。 */
export const TYPESAFE_REF = 'TYPESAFE_API_KEY';

/**
 * 解析 TypeSafe 的 API key。
 *
 * @param {{ resolve: (ref: string) => Promise<{ value: string, source: string } | undefined> } | undefined} credentials
 * @returns {Promise<{ value: string, source: string }>}
 */
export async function resolveApiKey(credentials) {
  if (credentials === undefined || credentials === null) {
    throw new Error(
      'browser-operator: 凭证服务不可用,无法解析 ' +
        `${TYPESAFE_REF}。请在 DSH 里挂载 credentials 服务后重试。`,
    );
  }
  const resolved = await credentials.resolve(TYPESAFE_REF);
  if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
    throw new Error(
      `browser-operator: 没有配置 ${TYPESAFE_REF},browser_act 需要它才能调用 Jev。` +
        `两条配置路径:① 在 .env 里写 ${TYPESAFE_REF}=<你的 key>;` +
        '② 写进 DSH 的凭证存储(~/.dsh/.credentials.yaml)。' +
        '另外 9 个 browser_* 工具不受影响,照常可用。',
    );
  }
  return { value: resolved.value, source: resolved.source };
}

/**
 * 造一个 `decide`。
 *
 * ⚠ SDK 默认 `maxRetries: 2`(含超时与连接类错误)与 10000 ms 超时 —— 那与
 * ADR-0009 决策点 6 钉的「立即停,不静默重试」和单步 5000 ms 直接冲突,所以这里
 * **显式**关掉重试并传显式超时。
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {number} options.timeoutMs
 * @param {(options: object) => object} [options.clientFactory] 测试用注入点
 */
export function createDecide({ apiKey, model, timeoutMs, clientFactory }) {
  const make = clientFactory ?? ((options) => new TypeSafeClient(options));
  const client = make({
    apiKey,
    // ⚠ 构造器上的模型配置键是 `defaultModel`,**不是** `model` —— 传 `model` 会被
    // **静默忽略**(实测:defaultModel 仍是 'jev-latest')。`model` 只在 per-call 的
    // systemOne 请求上有效。这里两个都给:`defaultModel` 才是真正生效的那个。
    defaultModel: model,
    model,
    timeout: timeoutMs,
    retry: { maxRetries: 0 },
  });
  return async function decide({ state, questions }) {
    return client.systemOne({ state, questions });
  };
}
