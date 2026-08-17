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
  name: <repo-abs-path>/plugins/tool-vision/lib/index.js
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

## 接入云端视觉模型(OpenAI 兼容 + API key)

不想跑本地模型?把 `baseUrl` 指到任何 **OpenAI 兼容的云服务**,填 `model` 和
`apiKey` 即可(`autoStart` 保持 `false`,插件不会去拉起本地服务):

```yaml
- id: tool-vision
  name: <repo-abs-path>/plugins/tool-vision/lib/index.js
  config:
    baseUrl: https://api.openai.com/v1 # 换成你的服务地址(带 /v1)
    model: gpt-4o # 换成服务支持的视觉模型 id
    apiKey: env:MY_VISION_API_KEY # 或直接填 sk-xxx;env: 引用环境变量更安全
    autoStart: false # 云端无需自动拉起
```

- **key 放哪**:直接填明文(方便,但会写进 `agent.cordis.yml`,注意别提交到 git);
  或 `env:变量名` 从环境变量读取(推荐,密钥不落盘)。`env:` 引用的变量未设置时,
  插件在加载时直接报错,方便排查。
- **注意**:DeepSeek 官方 API **不支持图片输入**,不能当 vision 后端;请用支持视觉
  的 OpenAI 兼容服务(OpenAI GPT-4o、智谱 GLM-4V、阿里 qwen-vl、OpenRouter 等)。
- 探测模型列表、聊天补全请求都会带 `Authorization: Bearer <key>`;返回 401/403
  通常是 key 不对或服务未开通视觉模型。

## 自定义模型 / 换机器(Windows)

插件对接的是 **OpenAI 兼容接口**,不绑定任何特定模型——换模型、换机器都不用改代码,
只改配置:

| 场景               | 改什么                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 换模型(服务已在跑) | `baseUrl` 指向新服务,`model` 填新模型 id(留空自动探测 `/v1/models` 的第一个 id)                                                                             |
| 换推理服务         | 任意 OpenAI 兼容服务都行:llama-server / LM Studio(`http://127.0.0.1:1234/v1`)/ Ollama(`http://127.0.0.1:11434/v1`)/ vLLM 等,只要模型支持视觉                |
| 换**云端**服务     | `baseUrl` 填云服务地址(带 `/v1`)+ `model` 填云端模型 id + `apiKey` 填云端 key(`env:` 引用环境变量);`autoStart` 保持 `false`。示例见上方「接入云端视觉模型」 |
| on-demand 自动拉起 | `serverCommand` 填新服务的启动命令(含新模型路径)                                                                                                            |

### Windows 注意

- 默认 `serverCommand`(qwen3.5-9b)已做平台适配:模型路径改用 `os.homedir()` 解析
  (cmd.exe 不展开 `~`)并加引号;进程清理在 Windows 上用 `taskkill /T` 整树删除,
  不会遗留孤儿 llama-server;`spawn` 加了 `windowsHide`,不弹黑色控制台窗口。
- 但 **Windows 上仍建议显式配 `serverCommand`**:要么把 llama.cpp 所在目录加进
  `PATH`(否则 cmd 解析不到 `llama-server`),要么写完整路径,例如:

  ```yaml
  - id: tool-vision
    name: /path/to/dsh-plugin/plugins/tool-vision/lib/index.js
    config:
      baseUrl: http://127.0.0.1:8080/v1
      model: qwen3.5-9b
      autoStart: true
      serverCommand: llama-server -m C:\Users\me\models\qwen3.5-9b\Qwen3.5-9B-Q4_K_M.gguf --mmproj C:\Users\me\models\qwen3.5-9b\mmproj-F16.gguf --host 127.0.0.1 --port 8080 -c 4096 -ngl 99 --image-min-tokens 1024 --alias qwen3.5-9b
      keepAliveMs: 0
  ```

  (路径含空格时,把每个路径用双引号包起来即可。)

- 更省事的 Windows 方案:用 **LM Studio**(图形界面自带 OpenAI 兼容服务)或
  **Ollama**,`autoStart` 保持 `false`,只配 `baseUrl` + `model`,完全不碰
  `serverCommand`。

## 配置项

见 `cordis.yml` 的配置表:`baseUrl` / `model` / `apiKey` / `defaultPrompt` /
`maxTokens` / `timeoutMs` / `maxImageBytes` / `autoStart` / `serverCommand` /
`keepAliveMs` / `startupTimeoutMs`,全部有默认值,除 `baseUrl` 外通常无需改动;
接云服务时再加 `model` + `apiKey`。

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
- `apiKey` 非空时,探测/模型列表/聊天补全请求都带 `Authorization: Bearer <key>`;
  支持 `env:NAME` 从环境变量读取,避免密钥明文入库,`env:` 未设置时加载即报错。
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
