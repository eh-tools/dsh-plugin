# tool-vision:本地识图工具

把本地图片发给本地 llama-server(OpenAI 兼容接口)上的多模态模型,返回模型对图片的描述。
工具名 `vision`,供 DSH agent 调用(读图、OCR、版面理解、精细视觉描述)。

## 前置

- 本机已装 `llama-server`(llama.cpp)。**常驻模式**需要先手动拉起一个带 mmproj 的
  多模态模型(推荐命令);**on-demand 模式**(`autoStart: true`)不需要,插件会在
  调用时自动拉起、用后退出,此段落仅作参考:

  ```bash
  llama-server \
    -m ~/models/qwen3.5-9b/Qwen3.5-9B-Q4_K_M.gguf \
    --mmproj ~/models/qwen3.5-9b/mmproj-F16.gguf \
    --port 8080 --host 127.0.0.1 -c 4096 -ngl 99 \
    --image-min-tokens 1024 --alias qwen3.5-9b
  ```

  `--image-min-tokens 1024` 对精细定位/版面任务准确率更高。两个已验证可用的模型:

  | 模型          | 文件                                                | 体积        |
  | ------------- | --------------------------------------------------- | ----------- |
  | qwen3.5-9b    | `Qwen3.5-9B-Q4_K_M.gguf` + `mmproj-F16.gguf`        | 5.3G + 0.9G |
  | ornith-1.0-9b | `Ornith-1.0-9B-Q3_K_S.gguf` + `mmproj-...-f16.gguf` | 4.3G + 0.9G |

## 如何加载(挂载进 agent preset)

把 `cordis.yml` 里的段落加进目标 preset 的 `agent.cordis.yml`,保存后新建会话生效:

```yaml
- id: tool-vision
  name: /Users/a1/workspace/dsh-plugin/plugins/tool-vision/lib/index.js
  config:
    baseUrl: http://127.0.0.1:8080/v1
```

## 两种用法

**常驻服务(高频场景)**:按上面「前置」手动起 llama-server,`autoStart` 保持
`false`(默认),插件只对接 8080 端口。

**on-demand 单次调用(低频 / 想省内存)**:配置 `autoStart: true`,不手动起服务。
插件在每次调用前探测 `baseUrl`,不可达时用 `serverCommand` 自动拉起 llama-server,
请求完成后按 `keepAliveMs` 退出(`0` = 用完即退,进程与内存随之释放;`>0` =
闲置 N 毫秒后退出,适合连续多次调用)。外部已有服务时优先复用,不重复拉起;
插件 dispose 时会停掉自己拉起的进程。完整配置项见 `cordis.yml`。

## 配置项

见 `cordis.yml` 的配置表:`baseUrl` / `model` / `defaultPrompt` / `maxTokens` /
`timeoutMs` / `maxImageBytes` / `autoStart` / `serverCommand` / `keepAliveMs` /
`startupTimeoutMs`,全部有默认值,除 `baseUrl` 外通常无需改动。

## 开发与测试

```bash
# 冒烟测试(内置 mock 服务器 + mock on-demand 拉起,无需真实模型)
pnpm test          # 或 node plugins/tool-vision/tests/smoke.mjs

# 真实模型 e2e(两种模式)
node plugins/tool-vision/tests/e2e.mjs            # 对接已在跑的 llama-server
node plugins/tool-vision/tests/e2e.mjs --ondemand # 插件自动拉起 + 用完即退

# 全量门禁:lint + prettier + smoke + audit
just check
```

## 实现说明

- **零依赖**:只用 Node 内置模块(`node:fs/promises`、`node:path`)与全局 `fetch`,
  直接 `ctx.tools.register({...})` 原始注册,不 import 任何 `@deepseek-ai/*`,
  因此可以从任意绝对路径挂载,不需要装依赖。
- 请求体为 OpenAI `chat/completions` 格式:文本指令 + `image_url` data URI(base64 内联),
  `stream: false`;响应取 `choices[0].message.content`(兼容字符串与分块数组)。
- `model` 配置留空时自动 `GET /v1/models` 取第一个 id,兼容 llama-server 任意 `--alias`。
- 超时与取消:调用方 `exec.signal` 与 `timeoutMs` 合并为单个 AbortSignal(手写合并,兼容 Node 20,不用 `AbortSignal.any`),请求结束即清理定时器。
- 配置校验失败在 `apply` 时立即抛错(配置错误要响亮失败,不静默)。
- **on-demand 进程管理**:`spawn(command, { shell: true, detached: true })`,以进程组
  `SIGTERM`(5s 后 `SIGKILL` 兜底)整树清理,不会残留 shell 或 llama-server;
  请求计数保证并发调用共享一个子进程、最后一个请求结束后才退出;`ctx.on('dispose')`
  兜底清理,插件卸载不泄漏进程。

## 已知限制

- 图片体积上限默认 30 MiB(可配 `maxImageBytes`);单图路径入参,不支持 URL。
- 每次调用是独立请求,llama-server 侧无会话记忆;多轮讨论需由 agent 自己带上下文。
