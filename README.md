# dsh-plugin

> DeepSeek Harness (DSH) 插件集合 —— 给 DSH 补上余额监控、本地识图、粘贴图片落盘等日常能力,`link:` 本地安装即用,随 `dsh web` 启动自动挂载。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Made with DeepSeek + DSH](https://img.shields.io/badge/Made%20with-DeepSeek%20%2B%20DSH-4A6CF7)](https://github.com/deepseek-ai/DeepSeek-Harness)

## 这是什么

DSH 的插件生态还在早期,本仓库把几个日常高频缺口做成了独立插件,一个插件一个目录,按需取用:

| 插件          | 解决什么问题                             | 一句话说明                                                                 |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `ds-balance`  | 官方状态栏看不到余额和用量               | stats 行下方加第二行:余额 + 今日/本月 token,每 5 分钟刷新                  |
| `tool-vision` | DeepSeek 模型不支持图片输入              | 本地识图工具,把图片交给本地视觉模型(llama-server / LM Studio / Ollama)描述 |
| `paste-image` | 粘贴图片发送会被"当前模型不支持图片"拒绝 | 粘贴瞬间把图片落盘成文件,路径写入草稿,配合 `tool-vision` 实现看图          |

> `tool-vision` + `paste-image` 合起来的效果:你在输入框粘贴一张截图,agent 就能"看到"并描述它——完全绕开 DeepSeek 模型的图片输入限制。

## 快速上手

前置:Node.js >= 20、已安装 DeepSeek Harness(`dsh` CLI)及 `web` profile。

### 1. 克隆并安装两个 UI 插件

```sh
git clone https://github.com/eh-tools/dsh-plugin.git
cd dsh-plugin

# <repo-abs-path> 换成你克隆下来的仓库绝对路径(link: 安装要求绝对路径)
dsh plugin --profile web add link:<repo-abs-path>/plugins/ds-balance
dsh plugin --profile web add link:<repo-abs-path>/plugins/paste-image
```

装完**重启 DSH 并硬刷新浏览器**(Cmd/Ctrl+Shift+R)生效。

### 2. 挂载 tool-vision

纯 host 插件不走 plugin 命令,把下面这段加进目标 preset 的 `agent.cordis.yml`(如
`~/.dsh/.agent-presets/<id>/agent.cordis.yml`),保存后新建会话生效:

```yaml
- id: tool-vision
  name: <repo-abs-path>/plugins/tool-vision/lib/index.js
  config:
    baseUrl: http://127.0.0.1:8080/v1
```

> 更新插件:`git pull` 后重跑同一条安装命令;只改 `lib/client.js` 时刷新浏览器即可,
> 改 `lib/index.js` 才需要重启 DSH。
> 卸载:`dsh plugin --profile web remove dsh-ds-balance` / `dsh-paste-image`,然后重启 DSH。

## 插件使用说明

### ds-balance —— 余额/调用量状态栏

装好后,官方 stats 行**下方**出现独立第二行:

```
DeepSeek ¥68.64 | 今日 34K tok | 本月 1.2M tok
```

- 每 5 分钟自动刷新;悬停可看明细(总余额 / 赠送 / 充值 / 今日与本月输入输出 token 拆分)。
- 配置:凭证写入 `~/.dsh/.credentials.yaml`(或环境变量),经 credentials 服务读取,不进代码:

  ```yaml
  DEEPSEEK_API_KEY: sk-xxxx
  DEEPSEEK_USER_TOKEN: <平台网页登录态 token>
  ```

  `DEEPSEEK_USER_TOKEN` 的获取:登录 platform.deepseek.com 后,F12 → Application →
  Local Storage → 复制 `userToken` 键 JSON 值里的 `.value` 字段;也可以在状态栏上点
  **"浏览器登录"**,插件会用系统 Chrome 打开登录页,登录后自动写入并生效。

#### 常见问题

| 现象                                | 原因                                                                    | 解决                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 状态栏没有第二行                    | base URL 指向非官方 API(网关/代理/自建中转),或未配置 `DEEPSEEK_API_KEY` | 确认 base 是 `api.deepseek.com` 且 key 已配置;**非官方场景整行隐藏是设计行为**,不会污染状态栏 |
| 只有余额,没有今日/本月              | 未配置 `DEEPSEEK_USER_TOKEN`                                            | 点状态栏"浏览器登录",或手动复制 userToken                                                     |
| 调用量突然消失,日志报 `40002/40003` | userToken 过期/退出登录                                                 | 重新登录,重新复制/一键登录                                                                    |
| "浏览器登录"失败                    | 本机没有 Google Chrome                                                  | 装 Chrome,或 `npx playwright install chromium`                                                |
| 数字不更新                          | 5 分钟轮询 + 60s 服务端缓存                                             | 正常现象,等下一轮刷新;改了 key 后重启 DSH 最稳                                                |

> 注意:调用量接口是平台用量页的**私有接口**(无公开文档),只返回 token 数不返回
> 调用次数,且可能随时变动——这属于平台侧限制,插件无法控制。

### tool-vision —— 本地识图工具

把图片路径交给它,返回视觉模型对图片的描述(读图 / OCR / 版面理解)。工具名 `vision`,
agent 会自动调用;支持 PNG / JPEG / WebP / BMP / GIF。

两种用法(核心配置 `autoStart`):

- **常驻服务**(高频):自己起一个 llama-server,`autoStart` 保持 `false`(默认),插件只对接端口。
- **on-demand**(低频 / 省内存):配 `autoStart: true`,插件在调用时自动拉起服务、
  用完即退(`keepAliveMs: 0`),外部已有服务时优先复用,不重复拉起。

完整配置项(全部有默认值,除 `baseUrl` 外通常不用改):

| 键                                          | 默认值                         | 说明                                                                          |
| ------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `baseUrl`                                   | `http://127.0.0.1:8080/v1`     | 任意 OpenAI 兼容视觉服务的 API 地址(带 `/v1`),本地或云端都行                  |
| `model`                                     | `''`                           | 模型 id;留空自动探测 `/v1/models` 第一个                                      |
| `apiKey`                                    | `''`                           | **云服务认证**:直接填 `sk-xxx`,或 `env:MY_KEY` 读环境变量;留空 = 无认证(本地) |
| `defaultPrompt`                             | `用中文简要描述这张图片的内容` | 调用方未传 `prompt` 时的指令                                                  |
| `maxTokens` / `timeoutMs` / `maxImageBytes` | `1024` / `120000` / `30 MiB`   | 生成上限 / 超时 / 图片体积上限                                                |
| `autoStart`                                 | `false`                        | 服务不可达时自动拉起 llama-server(云端保持 `false`)                           |
| `serverCommand`                             | `''`                           | 拉起命令;留空用默认(基于 `baseUrl` 推导,已适配 Windows)                       |
| `keepAliveMs`                               | `0`                            | `0` = 用完即退;`>0` = 闲置 N 毫秒后退出                                       |

#### 常见问题

| 现象                            | 原因                                        | 解决                                                                                                    |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 调用 `vision` 超时/报错         | llama-server 没起,或端口与 `baseUrl` 不一致 | 手动起服务;或配 `autoStart: true` 让插件自动拉起                                                        |
| Windows 上找不到 `llama-server` | 不在 `PATH`,或 cmd 不展开 `~`               | 显式配 `serverCommand` 完整路径(示例见插件 README);更省事用 LM Studio / Ollama,完全不碰 `serverCommand` |
| 想换模型 / 换推理服务           | —                                           | 只改 `baseUrl` + `model`,LM Studio / Ollama / vLLM 都行,只要模型支持视觉                                |
| 想用**云端**视觉模型            | —                                           | `baseUrl` 填云服务地址 + `model` 填云端模型 id + `apiKey` 填 key(`env:` 引用环境变量),示例见插件 README |
| 云端返回 401/403                | key 不对,或服务不支持视觉模型               | 核对 `apiKey` 与模型 id;DeepSeek 官方 API 不支持图片,不能当 vision 后端                                 |
| 图片太大被拒                    | 默认上限 30 MiB                             | 调大 `maxImageBytes`,或先压缩图片                                                                       |
| 多轮讨论模型"不记得"之前的图    | 每次调用是独立请求,无会话记忆               | 这是服务侧限制,由 agent 自己带上下文                                                                    |
| 常驻服务太占内存                | 模型常驻内存                                | `autoStart: true` + `keepAliveMs: 0`,用完即退                                                           |

### paste-image —— 粘贴图片落盘

在输入框 **Cmd+V / Ctrl+V** 粘贴图片时,自动把图片字节保存到**当前会话工作目录的
`attachments/`**,并把绝对路径追加进草稿,形如:

```
[已粘贴图片: /path/to/session/attachments/1760000000000-shot.png]
```

这样 agent 看到路径后,直接用 `tool-vision` 传该路径识别——绕开 DSH 主模型
(DeepSeek)不支持图片的检查。限制:PNG / JPEG / WebP / GIF,单张 ≤ 30MB;
文本粘贴不受影响。

## 常见问题速查

| 现象           | 解决                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| 装了插件没效果 | 重启 DSH + 硬刷新浏览器(Cmd/Ctrl+Shift+R);确认安装命令用的是仓库**绝对路径** |
| 改了代码不生效 | `lib/client.js` 改动刷新浏览器即可;`lib/index.js` 改动需重启 DSH             |
| 如何更新插件   | `git pull` 后重跑安装命令                                                    |
| 如何卸载       | `dsh plugin --profile web remove <插件id>`,然后重启 DSH                      |
| 凭证放哪       | `~/.dsh/.credentials.yaml`(或环境变量),**不要写进代码/提交到 git**           |
| 想自己写插件   | 见下方「贡献与开发」                                                         |

## 贡献与开发

开发/新增插件/提交规范等见 [CONTRIBUTING.md](CONTRIBUTING.md);仓库结构很简单:
`plugins/<plugin-id>/` 一个插件一个目录(需要浏览器 UI 的为静态双半包,
纯功能性的为纯 host 插件,写法都有现成参考)。

## 安全

发现漏洞请走私有渠道报告,勿开公开 Issue,详见 [SECURITY.md](SECURITY.md)。

## 关于

- **开发方式**:本仓库由 **DeepSeek** 模型协助、基于 **DeepSeek Harness (DSH)**
  工具链开发。
- **免责声明**:第三方社区项目,与 DeepSeek / 深度求索官方无隶属关系,未经官方认可
  或背书;`ds-balance` 的调用量接口为平台私有接口,可能随时变动,仅用于展示你本人
  账户信息。

## 协议

[MIT](LICENSE) © 2025 [eh-tools](https://github.com/eh-tools)
