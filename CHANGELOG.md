# Changelog

本文件记录 dsh-plugin 的重要变更,格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循
[SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- `file-git-explorer`:提交历史详情改版——点条目**仍在历史面板内**展示完整提交说明 + 文件 ±行数列表;点某条文件记录改为在历史面板**左侧单开该文件的 diff 悬浮栏**(复用右侧变更列表的 diff 面板与交互, 不再在面板内展开), 历史列表与详情保持不动、互不关闭;换提交 / 回列表 / 收起右栏 / Esc / 切换工作区时随历史一并关闭

### Added

- `file-git-explorer`:**文件编辑与树内写操作**——内容悬浮面板新增纯 textarea
  编辑态(`⌘S/Ctrl+S` 保存、Esc 退出、Tab 补两空格、未保存关闭/退出拦截确认);
  保存带 `mtimeMs` 乐观并发校验(磁盘被外部改动 → 冲突提示「重新加载磁盘版 /
  仍要覆盖写入」);左树新增**新建**(分区头 `+` 与目录行 `+`, 名称以 `/` 结尾建
  目录、支持 `a/b` 嵌套自动补建父目录)、**重命名**(行悬停 `✎`, 行内输入)与
  **删除**(行悬停 `✕`, 目录需确认框 + host 侧显式 `recursive` 双保险);保存后
  自动刷新右侧 git 状态, 树内结构变更局部重载不打断展开, 已打开面板跟随重命名 /
  删除时自动关闭;写类接口路径逐段白校验, 拒绝触及 `.git` 段, save 路由单独放宽
  body 上限至 3 MiB(内容仍限 1 MiB)。新增 `tests/edit.test.mjs`(8 组)
- `db-console`:全新**数据库控制台插件**——会话头部新增「数据库」页签(排在轨迹后),
  粘贴完整 PostgreSQL 链接串登录;连接按仓库根(项目)单例保存在
  `~/.dsh/storages/db-console.json`(明文 + 0600, 口径见 `docs/adr/0001`),
  切工作区/刷新/重启均不失效;已连接态提供 schema 内省树(表/列, 手动刷新)、
  SQL 编辑器(关键字/表名/列名三级补全 + 高亮 underlay, `Ctrl/Cmd+Enter` 执行)
  与结果网格(500 行截断提示、单元格点击复制、多语句分段、影响行数);执行不拦截
- `file-git-explorer`:侧栏联动升级——切到轨迹/数据库等非对话页签时两树自动收成
  细条(悬停细条仍可展开), 切回对话还原进入前的固定/开合快照;悬停保持改为
  「侧栏 + 其悬浮栏」联合区域追踪, 鼠标在两者之间移动不再误触延迟收起
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
- `file-git-explorer`:提交历史面板头部新增**查看分支切换器**——分支名可点,
  弹出与右树同款的本地/远程分组菜单(标记「当前 / 查看中」), 点选即按该分支
  重拉历史列表;历史列表条目之间、单条详情的文件行与展开 diff 块之间增加分割线

### Fixed

- `file-git-explorer`:右树顶部分支下拉新增**点外收起**——鼠标单击下拉外任意位置(面板内其他区域 / 页面其他处)即关闭分支列表,不再必须再点一次分支名
- `ds-balance`:修复"今日"调用量在每天本地凌晨(UTC+8 的 00:00~08:00)显示 **0** 的问题。
  平台用量接口 `usage/amount` 的 `days[].date` 按 **UTC** 切天(实测忽略 `tz` 参数),
  而插件原按**本地日期**匹配 `todayKey`,导致该时段请求落入上一 UTC 日、"今日"桶尚未
  累积,于是今日显示 0 而本月却很大。现改为按 UTC 取今日日期与 `month`/`year`,与平台
  桶标签对齐;并新增 `usage/amount`(userToken)路径的冒烟回归测试。
- `file-git-explorer`:右树分支下拉与 diff / 提交历史悬浮栏都出现在面板左侧
  同一留白带,同时打开会互相遮挡 —— 现改为**互斥**(开一关一);顺带修复移入
  分支下拉会误触发面板延迟收起的问题。
- `file-git-explorer`:修复左树忽略区看不到**深层被忽略目录**的问题。忽略分区
  原先只列"自身被 .gitignore 忽略"的条目,而 `src/__pycache__` 这类深层忽略路径
  的各级父目录(`src`)都未被忽略,导致它在可见区被过滤、在忽略区又走不到,
  整棵树任何分区都不显示。现忽略区引入**桥接目录**(自身未忽略但子树含忽略项的
  普通目录,经一次 `ls-files -o -i --exclude-standard --directory` 批量探测标记
  `subIgnored`),逐级展开即可到达任意深度的忽略项;可见/隐藏区分桶不受影响。

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
