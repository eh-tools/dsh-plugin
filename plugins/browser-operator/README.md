# browser-operator —— 常驻可见浏览器 + 10 个 `browser_*` 工具(纯 host 插件)

> 给「浏览器操作」agent 预设用的宿主侧插件:一个**常驻、有头、跨轮次**的浏览器会话,
> 独立 profile 长期复用登录态,用来复现 / 定位 / 验证 Web bug。
>
> **与日常浏览器并存,不抢它的窗口,不杀它的进程。**

## 它做什么 / 不做什么

| 做                                                                        | 不做                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------- |
| 用 Playwright 驱动**系统装好的** Chrome(或 Edge / 自带 chromium),有头可见 | 不下载 Chrome for Testing,不用 `--remote-debugging-port` |
| 独立 profile 目录(`$DSH_HOME/browser-operator/profile`),登录一次长期复用  | 不碰、不接管用户的日常浏览器 profile                     |
| 会话跨轮次保活;dsh 重启后重建、登录态仍在                                 | **从不调用 `taskkill`**,不做「清场重试」                 |
| console / network 常驻环形捕获                                            | 不做登录 / SSO 自动化(人工接管那一步)                    |
| 截图落**项目已 ignore 的目录**                                            | 不往仓库里写任何未被 ignore 的产物                       |

## 装什么、怎么挂

这是**纯 host 插件**(`package.json` + `lib/` + `cordis.yml` 示例 + `tests/`,无 client 半),
所以**不**用 `dsh plugin --profile web add link:` 装 —— 它挂进的是 **agent preset**:

```sh
# 1) 装依赖(只有一个:playwright-core;浏览器用系统已装的 Chrome)
pnpm --dir <repo-abs-path>/plugins/browser-operator install
```

```yaml
# 2) 把这一行加进目标 preset 的 agent.cordis.yml
#    (本仓库给「浏览器操作」预设用的完整行见 cordis.yml)
- id: browser-operator
  name: <repo-abs-path>/plugins/browser-operator/lib/index.js
  config:
    browser: chrome
    headless: false
```

`name` 写**绝对路径**即可:preset 的 `name` 只要是绝对路径,roster 就会转成
`file:` URL 直接 import(`dsh-agent-presets/specifier`),不需要装进 profile。

改完 `lib/index.js` 要**重启 DSH**(host 侧插件不走浏览器热更)。

## 10 个工具

| 工具                 | 干什么                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| `browser_act`        | 给一个目标,Jev 决策回路在当前页面上连跑若干步,返回精简轨迹             |
| `browser_navigate`   | 打开 URL(没写 scheme 自动补 `http://`),返回最终 URL / 标题 / HTTP 状态 |
| `browser_snapshot`   | 读当前页面可见文本(默认整个 body 的 `innerText`)+ 标题 + URL           |
| `browser_click`      | 点击元素(CSS,或 `text=登录` / `role=button[name="提交"]`)              |
| `browser_fill`       | 填输入框,或给 `<input type="file">` 设文件;`submit: true` 填完回车     |
| `browser_eval`       | 在页面上下文执行 JS,返回值的 JSON 文本                                 |
| `browser_screenshot` | 截图落盘,返回**绝对路径**(交给 `read_image` / 识图工具做视觉验收)      |
| `browser_console`    | 翻 console 日志 + 未捕获 pageerror(环形缓冲)                           |
| `browser_network`    | 翻**失败**请求:4xx/5xx 响应 + 连接失败/被中止                          |
| `browser_artifacts`  | 报告产物目录**以及为什么是它**,并可列出已有产物                        |

十个工具共享同一个页面,天然不可并发 —— 都没声明 `isConcurrencySafe`,即独占执行。

## `browser_act`(目标级工具)

前 9 个都是单步工具;`browser_act` 是唯一的目标级工具 —— 你给一个目标,它内部用
[TypeSafe 的 Jev](https://docs.typesafe.ai/introduction) 反复「观察 → 决策 → 执行」,
最多 12 步(上限 40),只把精简轨迹交回来。

**它不导航。** 先去哪个页面由你用 `browser_navigate` 决定。

**它的边界就是上游的边界。** 回路走的是 jev-ultrafast 那套结构,所以 shadow DOM、iframe、
canvas、文件上传、弹窗新 tab、嵌套滚动、任意键盘控件**都不在它的能力内** —— 遇到这些用对应的
单步工具。

**它不做文本生成。** `TYPE_TEXT` 的文本必须是 `goal` 里的**逐字片段**;没有可用片段时它会以
`status: 'text_unavailable'` 停下,这时改用 `browser_fill`。

**`status: 'done'` 不代表目标真的达成** —— 那只是回路停了。返回里带 `goalMet` 概率,要确认就
自己 `browser_snapshot` 复核一次。

**动画页面可能被误中止。** 陈旧性复检在**每一个**动作前都会跑,一旦对不上就终止整次运行 ——
这是有意的安全取舍(宁可停,也不拿过期的元素索引去操作)。代价是**良性**的页面变化也会让整次
`browser_act` 以 `status: 'error'` 收场而不是重试:走动的时钟、改变可见文本长度的滚动条、
新冒出来的元素都算。页面本身在动时,改用单步工具。

### 凭证

`browser_act` 需要 `TYPESAFE_API_KEY`(TypeSafe 是按量付费的外部服务)。凭证**只**经 DSH 的
凭证服务解析,那个服务自己就分层覆盖进程环境变量、provider store 与 `.env` 文件。两条配置路径:

1. 在 `.env` 里写 `TYPESAFE_API_KEY=<你的 key>`
2. 写进 `~/.dsh/.credentials.yaml`

**没有 key 时只有 `browser_act` 报错,其余 9 个工具照常可用。**

### 哪些测试进 `just check`

| 测试                     | 进 `just check`?   | 需要什么                                   |
| ------------------------ | ------------------ | ------------------------------------------ |
| `tests/policy.test.mjs`  | ✅ 进              | 什么都不要(离线、无浏览器、无 key、无网络) |
| `tests/harness.test.mjs` | ✅ 进              | 什么都不要(离线、无浏览器、无 key、无网络) |
| `tests/smoke.mjs`        | ❌ 不进,只能手动跑 | 本机装有 Chrome;会真的拉起一个有头窗口     |

`tests/harness.test.mjs` 是测试脚手架自己的用例:`tests/harness.mjs` 的守卫(什么时候抛错、账本
怎么记)不能只靠读代码保证,所以它拿一个临时 harness 实例装故意坏掉的用例,断言计数与输出。

门禁保持「离线」是有意的(见 ADR-0009 决策点 4):回路逻辑全在纯策略层与可注入的回路里,
所以离线单测覆盖得到;浏览器 I/O 与真实 Jev 往返只能手动验证。

## 产物目录(重点)

**规则:优先落进项目已经 ignore 的目录,绝不脏仓库。**

```
项目工作区 cwd
 ├─ 有已 ignore 的候选目录?  →  <候选>/browser-operator/     ← 首选
 │   候选按序:logs/ output/ tmp/ .tmp/ scripts/ test-results/
 │             playwright-report/ artifacts/ .artifacts/
 │             screenshots/ debug/ .debug/
 ├─ 在 git 仓库里但没有候选?  →  $DSH_HOME/browser-operator/<session-id>   ← 不脏仓库
 └─ 不在 git 仓库里?          →  cwd/logs/browser-operator/               ← 无所谓脏不脏
```

判定「ignore」以 **`git check-ignore`** 为准(git 是权威实现,自己写 glob 必然有出入);
git 不可用时才退化到本地 `.gitignore` 解析。

几个细节:

- 候选目录名带尾随 `/` 问 git —— `.gitignore` 里的 `logs/` 是**目录专属**模式,
  拿一个不存在的 `logs` 去问会被当成文件,匹配不上。
- 只有**真的被 ignore** 才会被选中,所以 `scripts` 这种通常被跟踪的名字放进来是安全的:
  不 ignore 就轮不到它。
- 已有目录优先于「被 ignore 但还没建」的目录 —— 不该为了写一张截图先在别人仓库里建目录。
- `git check-ignore -q` **只读退出码、不接管道**(`stdio: 'ignore'`),避免受限环境里
  子进程开不了管道的问题。

想钉死目录就在预设行里配 `artifactDir`(相对路径按会话工作区解析)。

同一套规则也写进了「浏览器操作」预设的人设,让模型知道产物落在哪、不去手写路径。

## 配置项

| 键                    | 默认值                               | 说明                                                              |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `browser`             | `chrome`                             | `chrome` / `edge` / `chromium`(Playwright 自带)                   |
| `executablePath`      | `''`                                 | 指定浏览器可执行文件;填了就忽略 `browser` 通道                    |
| `headless`            | `false`                              | 有头可见(SSO / 验证码需人工接管,默认就该看得见)                   |
| `profileDir`          | `$DSH_HOME/browser-operator/profile` | 独立 profile;登录态就存在这里                                     |
| `artifactDir`         | `''`                                 | 指定产物目录;省略 = 上面的自动探测                                |
| `artifactCandidates`  | 见上                                 | 覆盖候选目录名列表                                                |
| `logCap`              | `500`                                | console / network 环形缓冲条数上限                                |
| `navigationTimeoutMs` | `60000`                              | 导航超时                                                          |
| `actionTimeoutMs`     | `15000`                              | 动作(点击 / 填充 / 元素截图)超时                                  |
| `launchTimeoutMs`     | `60000`                              | 拉起浏览器超时                                                    |
| `maxTextChars`        | `20000`                              | 文本 / 求值结果的截断上限                                         |
| `maxSteps`            | `12`                                 | `browser_act` 回路的步数上限(硬上限 `40`,超了截断)                |
| `budgetMs`            | `100000`                             | `browser_act` 回路的时间预算;必须严格小于工具声明的 `120000` 超时 |
| `jevTimeoutMs`        | `5000`                               | 单次 Jev 决策请求的超时                                           |
| `jevModel`            | `jev-latest`                         | Jev 模型名                                                        |
| `locale`              | `zh-CN`                              | 浏览器 locale                                                     |

配错的键会在**加载时**直接报错(不静默),`browser` 只接受那三个值。

## 为什么这么选(实测结论)

本仓库选的是 **Playwright `chromium.launchPersistentContext` + `channel: 'chrome'`**,
而不是「`--remote-debugging-port` + `connectOverCDP`」那条路:

- Playwright 自己带 `--user-data-dir` 拉起一个**新进程**,所以**不需要**调试端口,
  也就同时绕开了两条坑:Chrome 拒绝在**默认 profile** 上开调试端口,以及同安装间带
  调试参数的启动被单例转发/静默忽略。
- 因此**不需要** Chrome for Testing,也**不需要** `taskkill` 清场兜底 ——
  本插件里没有一处调用 `taskkill`,不会误杀用户的浏览器。
- 实测(`tests/smoke.mjs`):日常 Chrome 开着 16 个进程时,拉起 / 操作 / 关闭会话
  前后,`chrome.exe` 进程数**一进一出完全相等**,用户的浏览器全程不受影响。

首选浏览器拉不起来时,会自动退到 Playwright 自带的 chromium,并把两次失败原因
一起报出来。

## 自检

```sh
node plugins/browser-operator/tests/smoke.mjs
```

会真的拉起一个有头浏览器窗口(临时 profile,跑完即关),覆盖:产物目录 4 条分支、
10 个工具全部注册、导航 / 读文本 / 求值 / console 捕获 / 失败请求捕获 / 截图落盘且
**不脏仓库状态**、以及 DISPOSE 后**无残留进程**。不需要 DSH 进程。

## 已知限制

- **同时刻只开一个浏览器预设会话**:预设是 standing mount(每进程一份),闭包状态就是
  那唯一的浏览器会话;两个会话共享同一 profile。要并发得按会话分 `profileDir`。
- 单页面约定:工具作用于窗口里最新的那个页面,没有多标签页模型。
- console / network 是环形缓冲 + 序号翻页,没有按请求 id 的精确索引。
- 预设行绑定本机绝对路径 —— 仓库搬家后要跟着改。
- 登录 / SSO / 验证码不做自动化,由人工在那个可见窗口里完成一次。
- **`browser_act` 在动画页面上可能误中止**:陈旧性复检跑在**每一个**动作之前,对不上就
  终止整次运行。所以良性的页面变化 —— 走动的时钟、改变可见文本长度的滚动条、新出现的
  元素 —— 会让整次调用以 `status: 'error'` 收场,而不是重试。这是有意的安全取舍:宁可停,
  也不拿一个过期的元素索引去操作。页面本身在动时用单步工具。
