# 0009 — browser-operator 复活:加一层 Jev 决策回路,不改原有工具行为

- 状态:已接受
- 日期:2026-09-19
- 关联词条:根 `CONTEXT.md`(原 `plugins/browser-operator/CONTEXT.md` 的词条并入,该文件随之删除)
- 关联决策:ADR-0008(browser-operator 退役;本 ADR 走它写明的回滚路径,但**有意不照搬其中一条**)
- 触发:用户提问 —— 「官方 dsh 的浏览器插件能否接入 jev 来加快速度」

## 背景

### 仓库侧

ADR-0008 在 2026-09-18 把 `browser-operator` 连同它的 agent preset 一起退役归档,并写明回滚路径:
「把 `plugins/obsolete/browser-operator` 移回 `plugins/browser-operator`;把 `preset/agent.cordis.yml` 里的
占位符换回绝对路径后放回 `~/.dsh/.agent-presets/browser-operator/`;再加回 smoke 那条」。本 ADR 触发时
距退役仅一天,源码一个字符未改。

**前两条照做,第三条不做** —— 理由见决策点 4:门禁必须保持"离线、不需要浏览器",而那条 smoke 会真的拉起
一个有头浏览器窗口。补回来的不是它,是一条新的离线纯策略层单测。

### 新变量:Jev

TypeSafe AI 的 **System One** 模型 Jev(2026-09 发布)不是聊天模型:给它一段 state 和一组**预先声明类型的问题**,
它返回**类型安全的答案 + 校准概率**,约 100–150 ms,约 $42 / 十亿 token。官方 JS/TS SDK `@typesafe-ai/sdk`
(Node ≥ 20,ESM+CJS+类型声明,零依赖);凭证环境变量 `TYPESAFE_API_KEY`。

`browser-use` 官方仓库已用它做出 `browser-use/jev-ultrafast`(MIT,6.5k star):每次观察产出一张**索引元素表**,
在**一次** TypeSafe 请求里并行问 operation + 所有兼容 target(投机扇出),默认循环里**没有截图**。自报实测:
中位任务时间 9.450 s → 7.092 s(-25%),中位浏览器协议调用 1092 → 101(-91%)。自报 MVP 边界:不支持
shadow DOM、iframe、canvas、文件上传、弹窗新 tab、嵌套滚动、任意键盘控件。

### DSH 侧

浏览器能力是**注册表 + 独占 provider 槽**:`@deepseek-ai/dsh-browser-use` 提供 `ctx.browserUse.register(name)`,
同一时刻只允许一个 provider。本机 web profile 的 playwright provider 行因 schema 不兼容被 `disabled`,槽当前是空的。

DSH 现有循环是「主模型决定 → 调一个浏览器工具 → 看结果 → 再来一轮」,延迟主要花在**主模型往返**,不在 CDP。
**Jev 不会让主模型推理变快** —— 它的加速全部来自把「观察 → 决策」压成一次 typed 调用、把截图踢出上下文、
把浏览器协议调用数降一个数量级。

## 决策点

### 决策点 1:落位

- 选项:移回 `plugins/browser-operator/` / 复制出来、归档原地保留 / 另起新 id
- 选择:移回
- 理由:ADR-0008 写明的回滚路径就是它;这仍然是同一份东西做同一件事(同一个常驻会话层 + 同一批
  `browser_*` 工具),不是"新东西借用旧名字"。复制会留下两份近乎相同的实现并让它们漂移。
- 代价:`plugins/obsolete/browser-operator/` 消失,ADR-0008 里指向该路径的引用失效 —— 在 ADR-0008 末尾加一行
  「后续」指针(**记录本身不改写**:ADR 是当时决策的留档,不是活文档)。归档里真正无法从 git 恢复的只有那份
  人设,它跟着插件一起搬回。

### 决策点 2:交付形态

- 选项:纯 host 工具插件(browser-operator 同构,不碰 `ctx.browserUse`) / 正式 browser-use provider
  (注册进独占槽,走 profile bundle + `plugin_manager`)
- 选择:纯 host 工具插件
- 理由:Jev 的收益**全在工具面**(目标级、一次往返、动作空间受约束、无截图),不在注册槽里。注册进槽是
  "独占"语义 —— 会和 playwright / cua-driver 抢唯一那一个位置,而原型期这份正统性换不来任何功能。原
  browser-operator 本来就不碰 `ctx.browserUse`,继续不碰。
- 代价:DSH 不把本插件当"浏览器后端",`ctx.browserUse.providerName` 不会显示它。以后若真要成为注册表里的
  正式 provider,那是薄薄一层 `register()` 调用,可以随时补。

### 决策点 3:加工具还是换工具面

- 选项:替换成 Jev 的目标级工具 / 在原 9 个工具之上**新增**目标级工具
- 选择:新增,原 9 个工具的**行为**一个不动
- 理由:① jev-ultrafast 的 MVP 不支持 shadow DOM / iframe / canvas / 上传 / 弹窗 tab,真实页面里这些常见,
  必须有兜底通道;② `browser_screenshot`(视觉验收)、`browser_console` 与 `browser_network`(失败诊断)是
  目标级工具**用得上**的配套;③ 既有工具的实现与契约零改动,新增逻辑集中在独立文件里。
- 代价:工具数从 9 涨到 10,主模型多一个选择点 —— 靠 `browser_act` 的描述把用途划清(一次目标 vs 单步操作)。
- **必须说清的一点**:「不碰工具行为」**不等于**「不碰 `tests/smoke.mjs`」。该 smoke 有**两处**会被第 10 个
  工具碰到:① `smoke.mjs:206-222` 枚举 `EXPECTED_TOOLS` 并断言 `ctx.toolsByName.size === EXPECTED_TOOLS.length`
  (消息「多注册了计划外的工具」);② `smoke.mjs:225-231` 逐个断言每个工具都带数值 `timeoutMs` 与
  `output.schema` / `output.render` / `presentCall`。两处都是**计划内**的更新,已列进同步改动 —— 漏掉任何
  一处,留下的就是一条红的自检。

### 决策点 4:分层与门禁

- 选项:整个回路一起测 / 把纯策略层单独抽出来测
- 选择:抽出纯策略层,让它进 `just check`;**原 smoke 继续留在门禁外**
- 理由:ADR-0008 把 smoke 摘掉的理由是它「会真的拉起一个有头浏览器窗口」,于是 `just check` 隐含要求本机装有
  Chrome。缺的那块用**离线纯函数单测**补:快照 → 元素表 → Jev questions,以及 Jev 响应 → 校验过的动作,
  两头都是纯数据,不需要浏览器、不需要网络、不需要 API key。
- **接线步骤(门禁不 glob,必须显式加)**:新测试 `plugins/browser-operator/tests/policy.test.mjs` 必须同时进
  ① `justfile` 的 `test` recipe、② 根 `package.json` 的 `scripts.test`、③ 根 `package.json` 的 `scripts.check`
  —— 三处都是逐条枚举路径,少一处它就不会跑。
- 代价:门禁覆盖的是策略层,**浏览器 I/O 层与真实 Jev 往返仍然只能手动验证**;这条限制写进**插件自己的**
  README(根 README 只留一句指针)。

### 决策点 5:凭证通道

- 选项:自己读 `process.env` / 走 DSH 的 `ctx.credentials` / 再允许写进插件配置
- 选择:**只走 `ctx.credentials`**,插件配置不接受 key
- 契约(照 `ctx.credentials` 的接口定义):
  - `CredentialRef` 在运行时就是一个 POSIX 环境变量名(`'TYPESAFE_API_KEY'`),`Branded` 只是类型层记号
    —— 纯 JS 里直接传字符串,不需要构造器。
  - **服务自己就是分层的**:环境变量名 →「process environment、provider-managed store、`.env` 文件」按序解析。
    所以插件**不再自己读 `process.env`** —— 自己再读一遍等于把同一份逻辑做两遍,还会绕过 `.env` 与
    provider store 这两层,并且违背仓库"凭证只进 `~/.dsh/.credentials.yaml` 或 `.env`"的规矩。
  - **每次操作重新解析,不跨操作缓存** —— 服务契约明文要求,也正是"换了凭证下一次操作就生效、不必重启"的来源。
  - store 里的空值在任何一层都算未配置,不会假扮成已配置。
- 注入方式:可选注入 —— 用 `ctx.get('credentials')` 加 undefined 检查,服务不在也不让插件加载失败。
- **两条路径要分清**:`describe(ref)` 只用来**报错与说明**(它的视图里没有放值的位置);真正的值走
  `resolve(ref) → ResolvedCredential { value, source }`。
- **解析时机:`browser_act` 的 `execute` 里,不在 `apply` 里。** 理由有二:① 服务契约要求每次操作重新解析;
  ② `tests/smoke.mjs` 的 `makeCtx()` 没有 `get`,在注册期解析会在那里直接抛 —— 既有插件(`ds-balance`)
  也是在处理器内解析的。
- 拿到 `value` 后**显式**传给 `TypeSafeClient`:SDK 在省略 `apiKey` 时会自己去读 `process.env`,那会让
  「缺凭证」这条路变得不确定。
- 插件配置**不接受** key:收了就等于把凭证写进 preset 行,配置面不该有第三个入口。
- 缺凭证时的报错文案:用 `describe(ref)` 取 `configured` / `source` / `writable`(这个视图没有放值的位置),
  说清两条配置路径(`.env` 里写 `TYPESAFE_API_KEY=…`,或写进 DSH 的凭证存储),并且要和
  「`ctx.credentials` 服务本身没挂载」这句区分开。只有 `browser_act` 报错,其余 9 个工具照常工作 ——
  不让整个 Web bug 复现工具因为缺一个外部服务的 key 而整体不可用。

### 决策点 6:`browser_act` 的契约

参数:`goal`(必填)、`maxSteps`(可选)。**不提供 `startUrl`** —— 且**本工具不导航**。

- 起点契约:`browser_act` 只在**当前已打开的页面**上工作。会话里没有页面时,报错并指向
  `browser_navigate`(沿用既有 `existingPage()` 的行为与语气)。理由:「先去哪个页面」是最该由人或主模型
  决定的,目标级工具一旦自己导航,URL 就成了它要猜的东西。
- **动作空间(策略层发出并校验的完整集合,闭合列举)**:
  `CLICK` / `TYPE_TEXT` / `SELECT` / `SCROLL_UP` / `SCROLL_DOWN` / `WAIT` / `DONE` / `BLOCKED`。
  没有 `NAVIGATE`、没有任意键盘、没有 JS 求值 —— 要那些用既有的单步工具。
  `BLOCKED` 表示「卡在需要人的一步(登录 / SSO / 验证码)」,与 persona 里"停下来问用户"的口径一致。
- 每步的产出:`{ step, operation, targetIndex, reason, confidence }`,全部进返回的 `steps[]`。
- **工具定义必须带齐四件东西** —— `tests/smoke.mjs:225-231` 会逐个断言:数值型 `timeoutMs`、`output.schema`、
  `output.render`(函数)、`presentCall`(函数)。既有 9 个工具都写了 `timeoutMs: TOOL_TIMEOUT_MS`
  (自 `lib/index.js:394` 起),`browser_act` 照办。只满足 `EXPECTED_TOOLS` 而漏掉这四个字段,smoke 会以
  另一条理由变红。
- 终止判据与预算(**四重上界,且必须严格有序**):
  - `maxSteps` 默认 **12**,硬上限 **40**(超了按上限截断,不报错)。**每一步都计一个单位,包括校验失败后的
    重新观察**;**`WAIT` 单次上限 1000 ms**。
  - 注册时声明的 `timeoutMs` 取既有 `TOOL_TIMEOUT_MS`(**120000**),与其余 9 个工具一致;但**内部总预算
    `budgetMs` 默认 100000,必须严格小于声明超时**。两者若相等,宿主会在回路自己返回 `status: 'timeout'`
    的同一刻掐掉这次调用 —— 那个带 `steps[]` 与概率的结构化结果就永远看不到了。这 20 s 余量是留给
    「把结果组装好交回去」的。
  - 单步 Jev 请求超时 **5000 ms**;单个动作的执行超时沿用既有的 `actionTimeoutMs`(默认 15000)。
  - **Jev 客户端必须显式关掉 SDK 的默认值**:`@typesafe-ai/sdk` 默认 `maxRetries: 2`(含 `APITimeoutError`
    与连接类错误)和 10000 ms 超时 —— 这两条都和本决策点的「立即停,不静默重试」与单步 5000 ms **直接冲突**。
    必须显式设 `retry: { maxRetries: 0 }`,并每次调用显式传超时。不写这一条,前面钉的语义会被 SDK 默认值
    悄悄改掉。
  - `goal_met ≥ 0.8` → 停,`status: 'done'`;`stuck ≥ 0.8` → 停,`status: 'stuck'`;
  - Jev 给出 `BLOCKED`(卡在需要人的一步:登录 / SSO / 验证码)→ 停,`status: 'blocked'` —— 与 `stuck`
    分开,因为两者的下一个动作不同:`stuck` 该退到 `browser_*` 单步工具,`blocked` 该去请人。
  - 用尽 `maxSteps` → `status: 'max_steps'`;超预算 → `status: 'timeout'`;Jev 报错或响应解析不了 → 立即停,
    `status: 'error'`,**不静默重试**;`TYPE_TEXT` 找不到逐字候选 → `status: 'text_unavailable'`。
    `status` 取值就是这**八**种(`done` / `stuck` / `blocked` / `max_steps` / `timeout` / `error` / `uncertain` /
    `text_unavailable`),闭合列举。
  - **`status: 'done'` 不声称目标真的达成** —— 返回里带 `goalMet` 概率,由主模型决定要不要用
    `browser_snapshot` 独立复核。jev-ultrafast 自己也写明 `DONE` 仍需独立验证。
- 置信度怎么用(不能只算不用):
  - 概率只作用于**停止判据与上报**,不用于拒绝单个动作。
  - 连续 **3** 步 operation 概率都低于 **0.35** → 停,`status: 'uncertain'`。
  - 动作执行前一律过"目标仍在 / 未被遮挡 / 页面未过期(freshness token 未变)"校验;不过就重新观察,
    最多重试 **2** 次,超过则 `status: 'error'`。
- `TYPE_TEXT` 的文本**不引入第二个模型**:文本必须是 `goal` 里的**逐字片段**。策略层先由代码枚举候选
  (`goal` 全文,加上按页面字段旁的标签 / 占位符切出的片段),再用 Jev 的 `choice` 从中选一个,原样输入。
  没有可用候选时该步停下,`status: 'text_unavailable'`,并在文案里指明改用 `browser_fill` 单步工具。
  - 理由:① 符合 TypeSafe 官方指引「选而不是生成」;② 不引入第二个模型供应商 —— 不必选模型,也不必构造
    `ctx.llm.stream` 要求的 `Message` / `MessageId` / `source` 那一套对象;③ DSH 里真要"凭空生成"文本时
    主模型本来就在场,用单步工具更直接;④ 回路的每一步都留在可测纯函数里。
  - 代价:需要凭空生成文本的页面会停下。这是**有意的** —— 那种页面走单步工具。

### 决策点 7:`preset/` 目录的处置

- 选项:当**历史快照**原样留着(只修路径引用) / 改造成**在役模板** / 删掉,靠 git 与 ADR 留档
- 选择:改造成在役模板
- 理由:ADR-0008 留档它的唯一理由是「那份人设是原创内容,不拷进仓库就永久没了」。复活之后人设必须补上
  `browser_act` 的用法与边界 —— 否则模型不知道该用目标级工具还是单步工具,而这正是决策点 3 的代价所在。
  留着两份几乎相同的人设、只把新的用在别处,才是真的会漂移;而 `agent.cordis.yml` 里那九成内容本来就是
  shipped `standard` 的副本,它的价值一直是「挂载示例」,不是「历史记录」。
- 代价:`preset/agent.cordis.yml` 会与 shipped `standard` 漂移 —— 这是 ADR-0008 已记下的既有债,不是新增的。
  模板的用法(本机拷一份、只改人设与插件行)**写在 `preset/README.md` 里,别把它当成完整组合直接挂**。
  `.prettierignore` 与 `.pre-commit-config.yaml` 里针对这份文件的排除**继续保留**(理由从「保持快照原样」
  改成「`!!js` 自定义标签 + persona 折叠块语义会被重排」),只改路径。

## 后果

- **正面**:仓库重新有一条在役的、带可见浏览器的会话路径,并多了一个"给一个目标、Jev 自己跑 N 步"的工具;
  `just check` 仍然离线、不需要浏览器、不需要 key(靠纯策略层单测补回,不是靠摘掉测试);Jev 的接入集中在
  独立文件里,浏览器会话层与既有工具行为零改动。
- **负面 / 技术债**:主模型多一个工具选择点,`browser_act` 与 9 个单步工具的重叠靠描述区分;Jev 是不受本仓库
  控制的外部付费服务,模型 id、限流与计费口径随时会变,所以回路有**四重上界**(`maxSteps` / `budgetMs` /
  单步 Jev 超时 / 单动作超时),且预算严格小于声明超时;
  jev-ultrafast 的 MVP 边界(shadow DOM / iframe / canvas / 上传 / 弹窗 tab)原样继承,兜底依赖那 9 个工具。
- **依赖覆盖缺口**:仓库**没有** `pnpm-workspace.yaml` —— 每个插件各自装依赖,`@typesafe-ai/sdk` 会落进
  `plugins/browser-operator/pnpm-lock.yaml`,**根 `just audit` 覆盖不到它**。因此 `justfile` 的 `audit` recipe
  追加一行 `pnpm --dir plugins/browser-operator audit`;提交前必须实测这一行能通过(不通过就退化成 README 里
  写明的手动步骤,并在本 ADR 补记)。
- **同步改动**(按「操作性的改、记录性的不改」分开。下面这份清单**逐文件点名**,不以某个总数来兜底 ——
  上一轮就因为「20 处」这个数对不上而漏了一整类「写死工具数」的站点):
  - `plugins/browser-operator/README.md`:去掉「已归档(2026-09 退役)」横幅、把安装命令与手动自检路径里的
    `plugins/obsolete/browser-operator` 改掉、工具表与正文改 9 → 10 并补 `browser_act` 小节(该文件有
    **四处**:标题行、`## 9 个工具` 小节标题、`:62` 的「九个工具共享同一个页面」、自检说明)、补门禁口径
    (**哪些进 `just check`、哪些手动**)、补 Jev 的动作空间 / 边界 / 凭证通道。
  - **所有写死工具数的地方 9 → 10**(逐站点名,别只改一处):`README.md:1` / `:48` / `:62` / `:137`、
    `lib/index.js:4`(模块头注释)、`cordis.yml:3`、`preset/preset.yml:2`、`preset/agent.cordis.yml:46`
    (「All 9 `browser_*` tools」)与 `:311`。另有 `package.json:4` 的 description 本来就写「注册 **8** 个」,
    与 README 的 9 个不一致 —— 一并纠到 10。`CONTEXT.md:18` 的「那 9 个工具」随该文件并入根 `CONTEXT.md` 时
    一起改。
  - `plugins/browser-operator/tests/smoke.mjs`:`EXPECTED_TOOLS` 加 `browser_act`(否则 `:206-222` 的 `size`
    断言变红;`:225-231` 的四个字段断言由决策点 6 保证)、头部注释里的运行路径、头部「不需要 DSH 进程」旁
    补一句它**不在**门禁里。
  - `plugins/browser-operator/package.json`:加 `@typesafe-ai/sdk` 依赖。
  - `plugins/browser-operator/cordis.yml`、`preset/agent.cordis.yml`、`preset/README.md`、`lib/index.js`
    (第 62 / 91 行的注释与错误串):归档路径与说明同步;`preset/README.md` 从「留档快照」改写为
    「在役模板 + 怎么拷到 `~/.dsh/.agent-presets/`」。
  - `.prettierignore` 与 `.pre-commit-config.yaml`(`check-yaml` 的 exclude):路径从 `plugins/obsolete/…`
    改为 `plugins/browser-operator/preset/`,排除理由按决策点 7 改写。
  - `justfile`:第 15 行引用归档 smoke 的注释;`test` recipe 加 `policy.test.mjs`;`audit` recipe 加插件目录那行。
  - 根 `package.json`:`scripts.test` 与 `scripts.check` 各加 `policy.test.mjs`。
  - 根 `CONTEXT.md`:第 3 行「本仓库当前没有在役的纯 host 插件…归档例子见 `plugins/obsolete/browser-operator/`」
    已失效;把 `plugins/browser-operator/CONTEXT.md` 的四个词条(**浏览器会话** / **独立浏览器 profile** /
    **浏览器操作预设** / **浏览器产物目录**)并入根文件、去掉「留档」字样,并按 AGENTS.md 的格式补
    `browser_act`(目标级工具)、**Jev 决策回路**、**索引元素表**这几个新词条;随后**删除**
    `plugins/browser-operator/CONTEXT.md`。
  - 根 `README.md`:插件清单把该行从「已归档」改回「维护中」、补 `browser_act`,并恢复安装 / 使用说明小节。
  - `CHANGELOG.md`:在 `[Unreleased]` 下补 `Added` / `Changed` 条目。
  - **不改写**的记录:`docs/adr/0008-*.md`(只在末尾加一行「后续」指针)与 `CHANGELOG.md` 里 0.4.0 / 退役
    那批条目 —— 它们记的是当时发生了什么。
- **本机数据**:`~/.dsh/.agent-presets/browser-operator/` 需要按 ADR-0008 的步骤重建;`$DSH_HOME/browser-operator/`
  下的独立 Chrome profile 在 ADR-0008 里已被删除,所以要**重新登录一次**。
- **回滚**:删掉 `lib/policy.js` / `lib/jev.js` / `lib/snapshot.js` / `lib/loop.js` 与 `browser_act` 的注册块、
  `tests/policy.test.mjs` / `tests/harness.mjs` / `tests/harness.test.mjs`、`@typesafe-ai/sdk` 依赖,
  把 `smoke.mjs` 的 `EXPECTED_TOOLS` 与三处门禁接线改回去,即回到退役前的行为;要连复活一起回滚,就把整个目录
  移回 `plugins/obsolete/` 并恢复 ADR-0008 的其余步骤。
  (`lib/loop.js` 与那两个 harness 文件是同一批新增的:`browser_act` 的注册块 import `loop.js`,
  `policy.test.mjs` 又 import `./harness.mjs` —— 只删前者会在插件加载时留下悬空 import,只删后者
  会让 `harness.test.mjs` 变成孤儿,两者都进 `just check`。)

## 后续(首次实机运行后补记;不改写上面的原始记录)

三个实测数,其中第一个推翻了「背景」里引用的延迟:

- **单次 `systemOne` 往返 ≈ 0.5–1.2 s,不是上面写的 100–150 ms。** 端到端三轮(同一任务、同一
  页面)每步约 1.1 s;绕过回路、直接用 SDK 跑的对照同样落在 0.5–1.2 s。差一个数量级的原因是那个
  数字**来自发布说明而非本机实测**。**这才是回路可用性的主成本**:12 步 = 6–14 s 的纯 Jev 时间。
- **单次请求 input ≈ 7.6k–11.6k token**(英文页约 7.6k,中文页约 11.6k;离线按 3.6 B/token 估的
  8.5k 落在中间)。按上面的 $42 / 十亿 token 折算,一步约 **$0.0003**,一次 12 步的回路约 **$0.004**。
- 于是:**载荷 / token 不是本回路的杠杆,延迟才是。** 元素表占全载荷 77%(被 state 与各目标问的
  `criteria` 各发一遍),已在 `e43dbc6` 做掉一轮无损精简(-4.8%);继续削 token 的收益是
  $0.0000x / 步,不值得拿决策质量去换。判断一个部署贵不贵,看 `usage.calls` 与 `elapsedMs`,
  **不要**看 token。
- 另:`browser_act` 的 render 一度漏渲染每步的 `reason`(结构化值里有、模型看不到),已在
  `93add35` 修掉,并补了一条**真正调用 render** 的用例 —— 此前门禁里唯一碰 render 的断言只是
  `typeof === 'function'`,从不调用它。
- **终止状态从 8 种变成 9 种:新增 `no_progress`。** 上面决策点 6 把 `status` 写成闭合的 8 种,
  那是在还不知道这个失败模式时定的。实测:HN 目标在第 1 步就达成,之后又跑了 11 步(两次运行
  都复现)——落点页上同一个下标解析到**另一个**可点元素(页内锚点),点它不改元素数 / URL /
  正文长度,`freshness` 因此对所有「空操作」完全盲,回路只能一路点到步数上限。9 次调用变 12 次、
  token 白烧 ~58%。**与 Jev 自报的 `stuck` 分开单列**,因为两者来源不同、混用会让台账读不准。
  判据刻意不只看 `freshness`:往输入框打字同样不改那三样,所以必须同时要求
  `(operation, targetIndex)` 与上一步相同,连着 3 次才停(与 `LOW_CONFIDENCE_RUN` 同取 3)。
