# Changelog

本文件记录 dsh-plugin 的重要变更,格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循
[SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `tool-vision`:支持 on-demand 自动拉起 llama-server 与用后即退(`keepAliveMs`),
  外部已有服务时优先复用,不重复拉起;`dispose` 时清理自拉进程
- `tool-vision`:新增 `apiKey` 配置(支持 `env:NAME` 引用环境变量,避免明文入库),
  可接入任意 OpenAI 兼容**云端**视觉服务(OpenAI / 智谱 / qwen-vl / OpenRouter 等)
- `tool-vision`:Windows 平台适配(路径按 `os.homedir()` 解析、`taskkill /T` 整树
  清理、`windowsHide` 不弹控制台窗口);支持 LM Studio / Ollama / vLLM 等任意
  OpenAI 兼容视觉服务
- 仓库开源化:MIT 协议、贡献指南、安全政策、变更日志
- 根 README 改为**使用导向**:新增各插件使用说明与「常见问题」FAQ 速查,
  弱化开发/贡献篇幅

### Fixed

- `ds-balance`:修复"今日"调用量在每天本地凌晨(UTC+8 的 00:00~08:00)显示 **0** 的问题。
  平台用量接口 `usage/amount` 的 `days[].date` 按 **UTC** 切天(实测忽略 `tz` 参数),
  而插件原按**本地日期**匹配 `todayKey`,导致该时段请求落入上一 UTC 日、"今日"桶尚未
  累积,于是今日显示 0 而本月却很大。现改为按 UTC 取今日日期与 `month`/`year`,与平台
  桶标签对齐;并新增 `usage/amount`(userToken)路径的冒烟回归测试。

## [0.1.0] - 2025-08-17

首个可用版本。

### Added

- `ds-balance`:官方 stats 行下方显示 DeepSeek 余额 + 今日/本月调用量,每 5 分钟
  刷新;浏览器一键登录获取 `userToken`;非官方 API 或未配置 key 时整行隐藏
- `tool-vision`:本地识图工具,把图片发给本地 OpenAI 兼容视觉服务并返回描述
  (零依赖,直接挂载任意绝对路径)
- `paste-image`:输入框粘贴图片即落盘到会话工作目录 `attachments/`,路径写入草稿,
  供 `tool-vision` 识别
- 工具链:prettier / eslint / justfile / pre-commit 门禁(lint、冒烟测试、依赖审计、
  密钥扫描、Conventional Commits)

### Changed

- `ds-balance` / `paste-image`:由动态插件(`cordis_define` / `cordis_run`)改造为
  **静态双半 npm 包**(`dsh.bundle.patch` + `dsh.client`),随 `dsh web` 启动自动
  挂载,无 Run 卡批准,重启不丢;client→host 通信改用 `ctx.webServer` HTTP JSON 路由

### Removed

- 删除已废弃的动态插件参考文件(`ds-balance` / `paste-image` 的 `host.js` /
  `client.js` 与 `ds-balance/install-v2.md`);`verify-ds-balance.mjs` 冒烟测试
  改为直接挂载静态实现 `lib/index.js`(走 `/ds-balance/api/query` 路由入口)

### Fixed

- `paste-image`:落盘改用 `node:fs` 直写(绕开代理沙箱 `ctx.shell` 的 read-only
  seatbelt 限制,修复 mkdir EPERM);补充回归测试并修正 pre-push 语法检查
