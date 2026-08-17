# 安装 ds-balance V2(第二行:余额 + 今日/本月调用量)

> 背景:动态插件只能通过 DSH agent 工具 `cordis_define` / `cordis_run` 注入
> (coding 会话没有这些工具, 本文件给**主 agent 会话**用)。
>
> 前置:文件已就绪并验证通过——
>
> - `plugins/ds-balance/host.js`(余额 + 官方用量接口, 非官方判定)
> - `plugins/ds-balance/client.js`(独立第二行, 非官方/无 key 整行隐藏)
> - `scripts/verify-ds-balance.mjs`(host 逻辑冒烟, `pnpm check` 已全绿)

## 步骤 1:停掉旧版本(若有)

如果之前装过 ds-balance 旧版(如 `dsbal-1` / `pkg-2`),先停旧再装新,
避免两行并存:

```
cordis_stop:   pluginId = <旧插件 id, 如 dsbal-1>
cordis_undefine: pluginId = <旧插件 id, 如 dsbal-1>
```

旧状态以实际为准(GUI cordis 面板左下角可查 pluginId 与状态)。

## 步骤 2:用 V2 文件重建插件

给主 agent 的指令(agent 用 fs 工具读文件, 再把内容作为 `code.host` / `code.client`):

```
cordis_define: kind: new, idPrefix: dsbal
  code.host   <- /Users/a1/workspace/dsh-plugin/plugins/ds-balance/host.js   的完整内容
  code.client <- /Users/a1/workspace/dsh-plugin/plugins/ds-balance/client.js 的完整内容
cordis_run:   pluginId + packageId, mode: run
```

即:先 `read` 两个文件, 然后 `cordis_define`(idPrefix: `dsbal`,
code.host / code.client 分别粘贴两个文件内容), 再 `cordis_run` 激活。

## 步骤 3:界面批准

Client 端需要授权:在 GUI 的 Run 卡上点批准。激活后官方 stats 行**下方**
出现第二行:

```
DeepSeek ¥68.64 | 今日 12 次 · 34K tok | 本月 345 次 · 1.2M tok
```

## 验证

- 非官方 base URL(配了 `DEEPSEEK_BASE_URL` 指向网关)→ 第二行不显示。
- 未配置 `DEEPSEEK_API_KEY` → 第二行不显示。
- 官方 API + key → 余额 + 今日/本月调用量;悬停看明细。
- 若用量接口返回 `code: 40002/40003`(接口不接受 API key), 第二行退化为只显示余额。
  自测命令见 `plugins/ds-balance/README.md`。

## 卸载

```
cordis_stop:    pluginId = <ds-balance 插件 id>
cordis_undefine: pluginId = <ds-balance 插件 id>
```
