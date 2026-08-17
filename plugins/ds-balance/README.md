# DeepSeek 余额状态栏 (DSH 动态插件)

在 DSH Web 的官方 stats 状态栏**同一行**显示 DeepSeek API 余额:

```
DeepSeek ¥68.64 | 12 轮 · 3 步 | LLM 45s · 工具调用 12s | 缓存命中 60% | 输入 12K tok · 输出 5K tok
```

- 每 5 分钟自动刷新;悬停可看明细(总余额 / 赠送 / 充值)。
- 未配置 Key 显示 `DeepSeek 未配置 Key`;查询失败显示 `DeepSeek 余额 --`,不影响官方统计部分。
- 兼容 `DEEPSEEK_BASE_URL` 自定义网关(自动去掉末尾 `/v1` 再拼 `/user/balance`)。

## 文件

| 文件        | 内容                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.js`   | Host 端函数体 — 解析 `DEEPSEEK_API_KEY`(credentials 服务), 用 curl 请求 `GET /user/balance`, 经 `harness.handle('ds-balance/query')` 暴露给 Client;带 60s 缓存 + 并发去重。Key 走显式 env opt-in, 不进进程 argv。 |
| `client.js` | Client 端函数体 — 注册进 `conversation.composer.dock`, 以 `priority: 1` 接管官方 `stats` 单元格, 余额并入官方那一行;官方 stats 统计逻辑为逐行复刻(与当前 ui-conversation 版本一致)。                              |

两个文件的内容就是 `cordis_define` 的 `code.host` / `code.client` 函数体, 可直接照抄。

## 如何在 DSH 中(重新)加载

动态插件是**进程内临时**的: DSH 重启后需要重新创建并运行, 否则状态栏恢复官方原样。

1. 让 agent 用本目录两个文件重建插件:

   ```
   cordis_define: kind: new, idPrefix: dsbal
     code.host   <- host.js 的内容
     code.client <- client.js 的内容
   cordis_run:   pluginId + packageId, mode: run
   ```

2. 在界面批准 Run 卡(Client 端需要授权), 激活后状态栏即显示余额。

## 备注

- 依赖动态插件专属符号(`harness` / `host` / `styles` / React 内置), 不能作为静态 cordis.yml 插件直接挂载。
- 实现方式: 接管官方 `stats` 单元格(而不是新增一个独立单元格), 因此官方 stats 行被完整复刻;若官方后续更新 stats 的样式或字段, 需要同步更新 `client.js`。
- 停止: `cordis_stop`(恢复官方原样);彻底删除: `cordis_undefine`。
